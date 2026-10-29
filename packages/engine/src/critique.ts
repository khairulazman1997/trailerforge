import { createHash } from 'node:crypto';
import { cutMetrics, type GateFinding } from '@trailerforge/cut';
import { BUILTIN_PROMPTS_DIR, loadPrompt, type LlmClient } from '@trailerforge/llm';
import { excludedTerms, redactor, textLeaves } from '@trailerforge/pack-game-trailer';
import {
  DecisionRecord,
  FLICKS_PER_SECOND,
  type CritiqueFix,
  type Project,
  type Slot,
  type Timeline,
  type TimelineItem,
} from '@trailerforge/schema';
import { z } from 'zod';

/**
 * Optional, opt-in AI critique of a version (route `critique.run`). The model gets TEXT ONLY:
 * the brief, the storyboard's words for each shot (as opaque `shot-N` keys), numbers measured on
 * the cut and the Quality Gate's findings. Never frames, sound, file names, paths or ids, and
 * nothing about a game fact the user excluded. It answers with at most ten notes, each about a
 * shot or the cut as a whole, some with a fix that is data (a new length, or a removal) for the
 * user to apply or dismiss. Nothing here changes the project; a cancelled or failed run changes
 * nothing.
 */

export const CRITIQUE_TASK = 'critique.run';
export const MAX_NOTES = 10;
const MAX_TEXT = 300;
const REDACTED = '[redacted]';

export const GeneratedCritique = z.strictObject({
  notes: z.array(
    z.strictObject({
      about: z.string(),
      kind: z.enum(['issue', 'idea']).default('issue'),
      text: z.string(),
      atSeconds: z.number().min(0).optional(),
      fix: z
        .strictObject({
          type: z.enum(['slot-duration', 'remove-slot']),
          shot: z.string(),
          seconds: z.number().optional(),
          summary: z.string().default(''),
        })
        .optional(),
    }),
  ),
});
export type GeneratedCritique = z.infer<typeof GeneratedCritique>;

export interface CritiqueFacts {
  /** The data exactly as it is sent. */
  wire: Record<string, unknown>;
  /** What each `shot-N` key stands for. */
  keys: Map<string, { slotId: string; itemId: string; start: number; slot: Slot; locked: boolean }>;
  /** Names that must not go out. */
  terms: string[];
  /** Plain-language list of what is sent, for the disclosure panel. */
  summary: string[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const secs = (flicks: number) => round1(flicks / FLICKS_PER_SECOND);

function deepRedact<T>(v: T, redact: (s: string) => string): T {
  if (typeof v === 'string') return redact(v) as T;
  if (Array.isArray(v)) return v.map((x) => deepRedact(x, redact)) as T;
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepRedact(x, redact)])) as T;
  return v;
}

/** Every id the project uses (slots, items, assets, entities...), longest first. */
function projectIds(project: Project, timeline: Timeline): string[] {
  const ids = new Set<string>();
  const walk = (v: unknown, key = ''): void => {
    if (typeof v === 'string') {
      if ((key === 'id' || key.endsWith('Id')) && v.length >= 4) ids.add(v);
    } else if (Array.isArray(v)) {
      if (key.endsWith('Ids') || key === 'ids')
        for (const x of v) if (typeof x === 'string' && x.length >= 4) ids.add(x);
      for (const x of v) walk(x, key);
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(project);
  walk(timeline);
  return [...ids].sort((a, b) => b.length - a.length);
}

const MEDIA_EXT = 'mp4|mov|mkv|webm|avi|m4v|wav|mp3|flac|aac|ogg|png|jpe?g|svg|ttf|otf|woff2?';
const MEDIA_FILE = new RegExp(`[^\\s"'\\\\/]+\\.(?:${MEDIA_EXT})\\b`, 'gi');
// A path to a media file (spaces allowed inside it), then any other absolute path.
const MEDIA_PATH = new RegExp(
  `(?:[A-Za-z]:[\\\\/]|\\/(?:[\\w.-]+\\/)+)[^"'\\n]*?\\.(?:${MEDIA_EXT})\\b`,
  'gi',
);
const ABS_PATH = /(?:[A-Za-z]:[\\/]|\/(?:[\w.-]+\/)+)[^\s"']*/g;

/**
 * Software messages (the Quality Gate's) may name ids, file names or paths: those become the
 * shot's key, or a neutral word, before anything is sent.
 */
function scrubber(ids: readonly string[], alias: ReadonlyMap<string, string>) {
  const re = ids.length
    ? new RegExp(ids.map((i) => i.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
    : null;
  return (text: string): string => {
    let out = text
      .replace(MEDIA_PATH, 'a file')
      .replace(ABS_PATH, 'a file')
      .replace(MEDIA_FILE, 'a file');
    if (re) out = out.replace(re, (m) => alias.get(m) ?? 'an item');
    return out;
  };
}

const mean = (xs: number[]) => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

/** What a critique of this version would send, and how to map the answer back. Pure. */
export function buildCritiqueFacts(input: {
  project: Project;
  timeline: Timeline;
  beats: readonly number[] | null;
  bars: readonly number[] | null;
  findings: readonly GateFinding[];
}): CritiqueFacts {
  const { project, timeline } = input;
  const sb = project.storyboard;
  const terms = excludedTerms(project.knowledge);
  const redact = redactor(terms);
  const slots = new Map<
    string,
    { slot: Slot; section: { name: string; role: string; locked: boolean } }
  >();
  for (const section of sb?.sections ?? [])
    for (const slot of section.slots)
      slots.set(slot.id, {
        slot,
        section: { name: section.name, role: section.role ?? '', locked: section.locked },
      });

  const picture = timeline.tracks
    .filter((t) => t.kind === 'video' || t.kind === 'graphics')
    .flatMap((t) => t.items)
    .filter((i): i is Exclude<TimelineItem, { kind: 'sequence' }> => i.kind !== 'sequence')
    .sort((a, b) => a.start - b.start);

  const keys: CritiqueFacts['keys'] = new Map();
  const shots = picture.map((item, n) => {
    const key = `shot-${n + 1}`;
    const known = item.slotId ? slots.get(item.slotId) : undefined;
    if (known && item.slotId) {
      keys.set(key, {
        slotId: item.slotId,
        itemId: item.id,
        start: item.start,
        slot: known.slot,
        locked: known.section.locked,
      });
    }
    const slot = known?.slot;
    const overlays = slot?.kind === 'shot' ? slot.overlays.map((o) => o.text).filter(Boolean) : [];
    return {
      key,
      section: known?.section.name ?? '',
      role: known?.section.role ?? '',
      kind: item.kind === 'placeholder' ? 'placeholder (no footage yet)' : item.kind === 'graphic' ? 'card' : 'shot', // prettier-ignore
      title: slot?.title ?? '',
      purpose: slot?.purpose ?? '',
      startSeconds: secs(item.start),
      seconds: secs(item.duration),
      ...(slot?.priority ? { priority: slot.priority } : {}),
      ...(overlays.length ? { onScreenText: overlays } : {}),
      ...(slot?.kind === 'card' && slot.text ? { cardText: slot.text } : {}),
    };
  });

  // Pacing: mean length of the shots in each third of the cut.
  const lens = picture.map((i) => i.duration / FLICKS_PER_SECOND);
  const third = Math.max(1, Math.ceil(lens.length / 3));
  const metrics = cutMetrics(
    timeline,
    { beats: [...(input.beats ?? [])], bars: [...(input.bars ?? [])] },
    1,
  );
  const cut = {
    shots: picture.length,
    seconds: metrics.seconds,
    placeholders: metrics.placeholders,
    ...(input.beats?.length
      ? { onBeatShare: metrics.onBeat, onBarShare: metrics.onBar }
      : { music: 'not analysed yet' }),
    meanShotSeconds: {
      first: mean(lens.slice(0, third)),
      middle: mean(lens.slice(third, 2 * third)),
      last: mean(lens.slice(2 * third)),
    },
    shortestShot: lens.length ? round1(Math.min(...lens)) : 0,
    longestShot: lens.length ? round1(Math.max(...lens)) : 0,
  };

  const itemKey = new Map(picture.map((i, n) => [i.id, `shot-${n + 1}`]));
  const aliasOf = new Map<string, string>(itemKey);
  for (const [key, k] of keys) aliasOf.set(k.slotId, key);
  const scrub = scrubber(projectIds(project, timeline), aliasOf);
  const findings = input.findings.map((f) => ({
    check: f.checkId.replace(/^core\//, ''),
    level: f.tier === 'hard' ? 'blocks the export' : f.tier === 'override' ? 'needs an override' : f.severity, // prettier-ignore
    message: scrub(f.message),
    ...(f.at ? { atSeconds: round1(f.at.start) } : {}),
    ...(f.itemId && itemKey.has(f.itemId) ? { shot: itemKey.get(f.itemId)! } : {}),
  }));

  const b = project.brief;
  const brief = {
    ...(b.title ? { title: b.title } : {}),
    ...(b.freeText ? { notes: b.freeText } : {}),
    ...(b.tone.length ? { tone: b.tone } : {}),
    ...(b.audience ? { audience: b.audience } : {}),
    ...(b.goals.length ? { goals: b.goals } : {}),
    ...(b.keySellingPoints.length ? { sellingPoints: b.keySellingPoints } : {}),
    ...(b.callToAction ? { callToAction: b.callToAction } : {}),
  };
  const vo = (sb?.voLines ?? []).map((v) => v.text).filter(Boolean);
  const wire = deepRedact(
    {
      videoType: sb?.meta.videoTypeId ?? 'trailer',
      brief,
      cut,
      shots,
      findings,
      ...(vo.length ? { voiceOver: vo } : {}),
    },
    redact,
  );

  const summary = [
    `The brief: ${Object.keys(brief).join(', ') || 'nothing'} (your own words)`,
    `${shots.length} shots in order: section, title, purpose, length, priority, on-screen text`,
    'Numbers measured on the cut: shot lengths by third, cuts on the beat and bar, shots with no footage',
    `${findings.length} Quality Gate finding${findings.length === 1 ? '' : 's'} (check, message, time)`,
    ...(vo.length ? [`${vo.length} voice-over line${vo.length === 1 ? '' : 's'}`] : []),
    'Never sent: footage, frames, sound, file names or paths, ids, or game facts you excluded',
  ];
  return { wire, keys, terms, summary };
}

export interface CritiqueNoteOut {
  /** Time on the version, flicks. */
  at: number;
  itemId?: string;
  text: string;
  kind: 'issue' | 'idea';
  slotId?: string;
  fix?: CritiqueFix;
}

export interface CritiqueResult {
  notes: CritiqueNoteOut[];
  decisions: DecisionRecord[];
  skipped: { about: string; reason: 'unknown-shot' | 'empty' | 'excluded' | 'too-many' }[];
  /** Fixes the model proposed that were dropped, with why. */
  droppedFixes: { about: string; reason: string }[];
  provider: string;
  model: string;
}

export interface CritiqueDeps {
  llm: LlmClient;
  now?: () => Date;
}

/** Ask for the critique. Pure with respect to the project: it returns notes, it stores nothing. */
export async function critique(
  deps: CritiqueDeps,
  facts: CritiqueFacts,
  opts: { variantId: string | null; frameFlicks: number; signal?: AbortSignal },
): Promise<CritiqueResult> {
  const { signal } = opts;
  // Check the project text that goes in (not the fixed template); enums are not user text.
  const sent = textLeaves(facts.wire, [
    'key',
    'check',
    'level',
    'kind',
    'role',
    'priority',
    'videoType',
  ])
    .join('\n')
    .toLowerCase();
  const leaked = facts.terms.find((t) => sent.includes(t.toLowerCase()));
  if (leaked !== undefined)
    throw new Error(
      'refusing to send: the critique still contains knowledge excluded from LLM use',
    );

  const system = await loadPrompt('system.trailer-craft', { projectName: '' }, [
    BUILTIN_PROMPTS_DIR,
  ]);
  const prompt = await loadPrompt(
    'critique.run',
    {
      videoType: String(facts.wire.videoType ?? 'trailer'),
      facts: JSON.stringify(facts.wire, null, 2),
      maxNotes: String(MAX_NOTES),
    },
    [BUILTIN_PROMPTS_DIR],
  );
  const r = await deps.llm.generate(
    CRITIQUE_TASK,
    { system, prompt, schema: GeneratedCritique },
    signal,
  );
  signal?.throwIfAborted();

  const at = (deps.now ?? (() => new Date()))();
  const out: CritiqueResult = {
    notes: [],
    decisions: [],
    skipped: [],
    droppedFixes: [],
    provider: r.provider,
    model: r.model,
  };
  const snap = (flicks: number) =>
    Math.max(0, Math.round(flicks / opts.frameFlicks) * opts.frameFlicks);
  for (const n of r.value.notes) {
    if (out.notes.length >= MAX_NOTES) {
      out.skipped.push({ about: n.about, reason: 'too-many' });
      continue;
    }
    const about = n.about.trim();
    const shot = facts.keys.get(about);
    if (about !== 'overall' && !shot) {
      out.skipped.push({ about, reason: 'unknown-shot' });
      continue;
    }
    const text = n.text.trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT);
    if (!text) {
      out.skipped.push({ about, reason: 'empty' });
      continue;
    }
    if (
      text.includes(REDACTED) ||
      facts.terms.some((t) => text.toLowerCase().includes(t.toLowerCase()))
    ) {
      out.skipped.push({ about, reason: 'excluded' });
      continue;
    }
    let fix: CritiqueFix | undefined;
    if (n.fix) {
      const target = facts.keys.get(n.fix.shot.trim());
      const summary = n.fix.summary.trim().replace(/\s+/g, ' ').slice(0, 200);
      const why = (reason: string) => out.droppedFixes.push({ about, reason });
      if (!target) why('names a shot that is not in the cut');
      else if (target.locked) why('the shot is in a locked section');
      else if (!summary) why('no summary of what it does');
      else if (n.fix.type === 'remove-slot') {
        if (target.slot.kind !== 'shot') why('only shots can be removed, not cards');
        else fix = { type: 'remove-slot', slotId: target.slotId, summary };
      } else if (!(n.fix.seconds !== undefined && n.fix.seconds >= 0.5 && n.fix.seconds <= 600)) {
        why('the new length is missing or out of range');
      } else {
        fix = {
          type: 'slot-duration',
          slotId: target.slotId,
          seconds: round1(n.fix.seconds),
          summary,
        };
      }
    }
    const start = shot ? shot.start : snap((n.atSeconds ?? 0) * FLICKS_PER_SECOND);
    const note: CritiqueNoteOut = {
      at: snap(start),
      ...(shot ? { itemId: shot.itemId, slotId: shot.slotId } : {}),
      text,
      kind: n.kind,
      ...(fix ? { fix } : {}),
    };
    out.notes.push(note);
    const iso = at.toISOString();
    const inputsHash = sha256(`${about}|${text}`);
    out.decisions.push(
      DecisionRecord.parse({
        id: `dec_${sha256(`core/critique|${iso}|${about}|${inputsHash}`).slice(0, 24)}`,
        at: iso,
        step: 'core/critique',
        subject: shot
          ? { kind: 'slot', id: shot.slotId }
          : { kind: 'timeline', id: opts.variantId ? `tl_${opts.variantId}` : 'tl_rough' },
        choice: { kind: n.kind, fix: fix ? fix.type : null },
        reasons: { provider: r.provider, model: r.model, text },
        summary: `AI critique (${n.kind}): ${text}`,
        inputsHash,
      }),
    );
  }
  return out;
}
