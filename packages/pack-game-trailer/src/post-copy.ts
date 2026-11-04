import { BUILTIN_PROMPTS_DIR, loadPrompt, type LlmClient } from '@trailerforge/llm';
import { normalizeHashtags, type Project, type Short } from '@trailerforge/schema';
import { z } from 'zod';
import { CAPTURE_TIPS_PROMPTS_DIR, excludedTerms, redactor } from './capture-tips.js';
import { tiktokFormat } from './tiktok-formats.js';

/**
 * The words that go with a posted TikTok (route `tiktok.post-copy`): caption, hashtags, a comment
 * to pin and a cover title. Written from the concept, the shots' titles, the voiceover script, the
 * brief and the game facts the user lets the AI see; never from recordings. A field that mentions
 * knowledge excluded from AI use, or is over its limit, is dropped with the reason.
 */

export const POST_COPY_TASK = 'tiktok.post-copy';
const KNOWLEDGE_CAP = 120;
const MAX_CAPTION = 600;
const MAX_HASHTAGS = 8;
const MAX_COMMENT = 150;
const MAX_COVER = 60;
const MAX_COVER_WORDS = 6;

export const GeneratedPostCopy = z.strictObject({
  caption: z.string().optional(),
  hashtags: z.array(z.string()).optional(),
  pinnedComment: z.string().optional(),
  coverTitle: z.string().optional(),
});

export interface PostCopyResult {
  caption?: string;
  hashtags?: string[];
  pinnedComment?: string;
  coverTitle?: string;
  /** Fields the model wrote that were not used, with why. */
  rejected: { field: string; reason: string }[];
  provider: string;
  model: string | undefined;
  fellBack: boolean;
}

const clean = (t: string) => t.trim().replace(/[ \t]+/g, ' ');

export async function generatePostCopy(
  deps: { llm: LlmClient },
  project: Project,
  short: Short,
  opts: { signal?: AbortSignal } = {},
): Promise<PostCopyResult> {
  const sb = short.storyboard;
  if (!sb) throw new Error('this TikTok has no template yet');
  const terms = excludedTerms(project.knowledge);
  const redact = redactor(terms);
  const lower = terms.map((t) => t.toLowerCase());
  const mentionsExcluded = (t: string) => lower.some((x) => t.toLowerCase().includes(x));

  const c = short.concept;
  const { assumptions: _a, ...brief } = project.brief;
  const knowledge = project.knowledge
    .filter((e) => !e.excludedFromLlm)
    .slice(0, KNOWLEDGE_CAP)
    .map((e) => `- ${e.id}: ${e.kind}: ${e.name}${e.description ? ` — ${e.description}` : ''}`)
    .join('\n');
  const shots = sb.sections
    .flatMap((s) => s.slots)
    .filter((x) => x.kind === 'shot')
    .map((x) => `- ${redact(x.title)}`)
    .join('\n');
  const system = await loadPrompt('system.trailer-craft', { projectName: project.name }, [
    BUILTIN_PROMPTS_DIR,
  ]);
  const prompt = await loadPrompt(
    POST_COPY_TASK,
    {
      format: tiktokFormat(c.formatId)?.name ?? 'TikTok',
      concept: redact(JSON.stringify({ title: c.title, hook: c.hook, pitch: c.pitch, seconds: c.targetSeconds }, null, 2)), // prettier-ignore
      shots: shots || '(none)',
      voiceover: sb.voLines.length ? sb.voLines.map((v) => `- ${redact(v.text)}`).join('\n') : '(none)', // prettier-ignore
      brief: redact(JSON.stringify(brief, null, 2)),
      knowledge: knowledge || '(none)',
    },
    [CAPTURE_TIPS_PROMPTS_DIR],
  );
  opts.signal?.throwIfAborted();
  const r = await deps.llm.generate(POST_COPY_TASK, { system, prompt, schema: GeneratedPostCopy }, opts.signal); // prettier-ignore
  opts.signal?.throwIfAborted();

  const out: PostCopyResult = { rejected: [], provider: r.provider, model: r.model, fellBack: r.fellBack }; // prettier-ignore
  const take = (field: string, value: string | undefined, ok: (v: string) => string | null) => {
    if (value === undefined) return undefined;
    const v = clean(value);
    if (!v) return undefined;
    const bad = ok(v) ?? (mentionsExcluded(v) ? 'mentions knowledge excluded from AI use' : null);
    if (bad) {
      out.rejected.push({ field, reason: bad });
      return undefined;
    }
    return v;
  };
  const caption = take('caption', r.value.caption, (v) => (v.length > MAX_CAPTION ? `over ${MAX_CAPTION} characters` : null)); // prettier-ignore
  if (caption) out.caption = caption;
  const pinned = take('pinnedComment', r.value.pinnedComment, (v) => (v.length > MAX_COMMENT ? `over ${MAX_COMMENT} characters` : null)); // prettier-ignore
  if (pinned) out.pinnedComment = pinned;
  const cover = take('coverTitle', r.value.coverTitle, (v) =>
    v.length > MAX_COVER || v.split(' ').length > MAX_COVER_WORDS
      ? `over ${MAX_COVER_WORDS} words`
      : null,
  );
  if (cover) out.coverTitle = cover;
  if (r.value.hashtags) {
    const tags = normalizeHashtags(r.value.hashtags);
    const kept = tags.filter((t) => !mentionsExcluded(t));
    if (kept.length < tags.length)
      out.rejected.push({
        field: 'hashtags',
        reason: 'some mention knowledge excluded from AI use',
      });
    if (kept.length > MAX_HASHTAGS) out.rejected.push({ field: 'hashtags', reason: `only the first ${MAX_HASHTAGS} are used` }); // prettier-ignore
    if (kept.length > 0) out.hashtags = kept.slice(0, MAX_HASHTAGS);
  }
  return out;
}
