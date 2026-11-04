import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { appendDecisions, brandStatus, type ProjectStore } from '@trailerforge/core';
import { brandTokens, buildScene, renderSvg } from '@trailerforge/graphics';
import { platformSafeBox } from '@trailerforge/graphics';
import { LlmConsentError } from '@trailerforge/llm';
import { ffmpeg } from '@trailerforge/media';
import { generatePostCopy, POST_COPY_TASK } from '@trailerforge/pack-game-trailer';
import { FrameRenderer, writePoster } from '@trailerforge/render';
import {
  DecisionRecord,
  FLICKS_PER_SECOND,
  type Resolution,
  type Short,
} from '@trailerforge/schema';
import type { Engine } from './engine.js';
import { OpError } from './ops.js';
import { findShort } from './shorts-ops.js';

const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

export interface PostCopyOutcome {
  /** What was written into the TikTok's post text and cover title. */
  applied: ('caption' | 'hashtags' | 'pinnedComment' | 'coverTitle')[];
  rejected: { field: string; reason: string }[];
}

/**
 * Ask the app's AI for the caption, hashtags, pinned comment and cover title, and write what
 * passes the checks (one undo step). The text sent is the concept, shot titles, voiceover script,
 * brief and the game facts not excluded from AI use; never recordings.
 */
export async function postCopyOp(
  engine: Engine,
  store: ProjectStore,
  shortId: string,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<PostCopyOutcome> {
  const short = findShort(store, shortId);
  if (!short.storyboard) throw new OpError('usage', `"${short.name}" has no template yet: build it first`); // prettier-ignore
  let r;
  try {
    r = await generatePostCopy({ llm: engine.llmFor(store) }, store.state, short, {
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if (err instanceof LlmConsentError) throw new OpError('usage', 'you chose not to send the request'); // prettier-ignore
    throw err;
  }
  opts.signal?.throwIfAborted();
  const applied: PostCopyOutcome['applied'] = [];
  if (r.caption) applied.push('caption');
  if (r.hashtags) applied.push('hashtags');
  if (r.pinnedComment) applied.push('pinnedComment');
  if (r.coverTitle) applied.push('coverTitle');
  if (applied.length === 0) return { applied, rejected: r.rejected };
  store.dispatch('core/shorts.set-post-copy', {
    shortId,
    ...(r.caption ? { caption: r.caption } : {}),
    ...(r.hashtags ? { hashtags: r.hashtags } : {}),
    ...(r.pinnedComment ? { pinnedComment: r.pinnedComment } : {}),
    ...(r.coverTitle ? { coverTitle: r.coverTitle } : {}),
  });
  const at = new Date().toISOString();
  await appendDecisions(store.paths.decisions, [
    DecisionRecord.parse({
      id: `dec_${sha256(`tiktok-post-copy|${at}|${shortId}`).slice(0, 24)}`,
      at,
      step: 'game-trailer/tiktok-post-copy',
      subject: { kind: 'short', id: shortId },
      choice: { fields: applied },
      reasons: { task: POST_COPY_TASK, provider: r.provider, fellBack: r.fellBack },
      summary: `Post text for "${short.name}": ${applied.join(', ')} written by the AI.`.slice(
        0,
        400,
      ),
    }),
  ]);
  return { applied, rejected: r.rejected };
}

/**
 * The cover image for an exported TikTok: the frame at the chosen time (else `fallbackSeconds`,
 * the poster time) with the cover title over it, set in the brand's fonts clear of the app's own
 * interface. Written to `dest` only when complete.
 */
export async function writeCover(
  engine: Engine,
  store: ProjectStore,
  short: Short,
  o: {
    video: string;
    size: Resolution;
    fallbackSeconds: number;
    dest: string;
    signal?: AbortSignal | undefined;
  },
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  const work = join(store.paths.cache, 'cover');
  await mkdir(work, { recursive: true });
  const key = sha256(`${o.dest}|${process.pid}`).slice(0, 12);
  const frame = join(work, `${key}.frame.png`);
  const title = join(work, `${key}.title.png`);
  const out = `${o.dest}.tmp-${process.pid}.png`;
  const opts = { tools: engine.tools, ...(o.signal ? { signal: o.signal } : {}) };
  try {
    await writePoster(o.video, short.cover.seconds ?? o.fallbackSeconds, frame, opts);
    await mkdir(dirname(o.dest), { recursive: true });
    const text = short.cover.title.trim();
    if (!text) {
      await rename(frame, o.dest);
      return { warnings };
    }
    const tpl = engine.plugins.registries.graphicTemplates.get('core/cover-title');
    if (!tpl) throw new OpError('not-found', 'the cover title template is not installed');
    const status = await brandStatus(store.paths.dir, store.state.brand);
    const scene = buildScene(tpl as never, {
      params: { text },
      brand: brandTokens(
        store.state.brand,
        status.fonts,
        o.size,
        !status.warnings.some((w) => w.startsWith('The logo')),
      ),
      size: o.size,
      duration: Math.round(FLICKS_PER_SECOND),
      safe: platformSafeBox(o.size, short.platform),
    });
    warnings.push(...scene.warnings);
    const r = await FrameRenderer.create({ projectDir: store.paths.dir, brand: store.state.brand, cacheDir: false }); // prettier-ignore
    const png = await r.render(renderSvg(scene, 0));
    warnings.push(...r.warnings);
    await writeFile(title, png.png);
    await ffmpeg(
      ['-i', frame, '-i', title, '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', out], // prettier-ignore
      0,
      opts,
    );
    await rename(out, o.dest);
    return { warnings: [...new Set(warnings)] };
  } finally {
    await Promise.all([frame, title, out].map((f) => rm(f, { force: true })));
  }
}
