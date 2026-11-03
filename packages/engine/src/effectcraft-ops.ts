import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendDecisions, type ProjectStore } from '@trailerforge/core';
import {
  AuthoredEffect,
  EFFECT_COMP,
  EffectCraftRenderer,
  EffectRefusedError,
  PROJECT_TEMPLATE_ID,
  EC_TEMPLATES,
  authorEffect,
  cachedMotionFrames,
  type EffectRequest,
} from '@trailerforge/effectcraft';
import { excludedTerms } from '@trailerforge/pack-game-trailer';
import { FLICKS_PER_SECOND, flicksPerFrame, type Slot, type Timeline } from '@trailerforge/schema';
import { effectBriefOf } from '@trailerforge/storyboard';
import { z } from 'zod';
import type { Engine } from './engine.js';
import { addEffect } from './effectcraft-commands.js';
import { OpError } from './ops.js';

/** A custom effect waiting for the user's yes or no; kept only in the project's cache. */
export interface EffectProposal {
  id: string;
  timelineId: string;
  /** The storyboard slot whose effect brief this was written from, if any. */
  slotId?: string;
  name: string;
  summary: string;
  seconds: number;
  landAt?: number;
  /** 1, or 2 when the first attempt was repaired; `repaired` lists what was wrong. */
  attempts: number;
  repaired: string[];
  provider?: string;
  model?: string;
  /** The request exactly as it went to the model (excluded names redacted); none for MCP-written effects. */
  sent: Record<string, unknown> | null;
  /** Rendered frames (transparent PNGs) and the frame to show as a still. */
  preview: { dir: string; pattern: string; frames: number; still: number };
  warnings: string[];
  createdAt: string;
}

const Stored = z.object({
  id: z.string(),
  timelineId: z.string(),
  slotId: z.string().optional(),
  name: z.string(),
  summary: z.string(),
  seconds: z.number(),
  landAt: z.number().optional(),
  sha256: z.string(),
  createdAt: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  sent: z.record(z.string(), z.unknown()).nullable(),
  effect: AuthoredEffect,
});

const PROPOSAL_ID = /^fx_[0-9a-f]{12}$/;
const proposalsDir = (store: ProjectStore) => join(store.paths.cache, 'effectcraft', 'proposals');

/** The bundled EffectCraft, ready, or why not. */
export async function effectcraftRenderer(engine: Engine): Promise<EffectCraftRenderer> {
  const r = engine.plugins.registries.motionRenderers.get('effectcraft/cli');
  if (!(r instanceof EffectCraftRenderer))
    throw new OpError('missing-tool', 'EffectCraft is not installed');
  const a = await r.available();
  if (!a.ok) throw new OpError('missing-tool', `EffectCraft is not available: ${a.reason}`);
  return r;
}

function masterTimeline(store: ProjectStore): Timeline {
  const tl =
    store.state.timelines.find((t) => t.id === 'tl_rough') ??
    store.state.timelines.find((t) => !t.variantId);
  if (!tl) throw new OpError('not-found', 'there is no cut yet: build the rough cut first');
  return tl;
}

export interface AuthorEffectInput {
  /** What the effect should look like, in the maker's words (or the summary of `effect`). */
  words: string;
  seconds: number;
  /** Seconds from the effect's start where its main hit lands. */
  landAt?: number;
  /** Commands written by the caller (Claude Code through MCP): no model is asked. */
  effect?: AuthoredEffect;
  /** The storyboard slot whose effect brief this is written from. */
  slotId?: string;
}

/**
 * Write a custom effect from words (plan M8 decision 4), build it in a scratch EffectCraft
 * session and render a preview. Nothing changes in the project: the proposal waits in the
 * project's cache until `acceptEffectOp` or `rejectEffectOp`. A cancel or a refusal leaves
 * nothing behind.
 */
export async function authorEffectOp(
  engine: Engine,
  store: ProjectStore,
  input: AuthorEffectInput,
  opts: { signal?: AbortSignal | undefined; now?: () => Date } = {},
): Promise<EffectProposal> {
  const { words, seconds, landAt } = input;
  if (!input.effect && !words.trim())
    throw new OpError('usage', 'say what the effect should look like');
  if (!(seconds >= 0.5 && seconds <= 20))
    throw new OpError('usage', 'an effect runs between 0.5 and 20 seconds');
  if (landAt !== undefined && !(landAt >= 0 && landAt <= seconds))
    throw new OpError('usage', 'the hit must land inside the effect');
  const renderer = await effectcraftRenderer(engine);
  const tl = masterTimeline(store);
  const rate = tl.frameRate.num / tl.frameRate.den;
  const brand = store.state.brand;
  const req: EffectRequest = {
    words: words || input.effect?.summary || '',
    seconds,
    ...(landAt !== undefined ? { landAt } : {}),
    size: tl.resolution,
    frameRate: rate,
    brand: brand ? { colors: brand.colors, fonts: brand.fonts.map((f) => f.family) } : null,
  };
  const id = `fx_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const dir = join(proposalsDir(store), id);
  const signal = opts.signal ?? new AbortController().signal;
  await mkdir(dir, { recursive: true });
  try {
    const r = await authorEffect({ llm: engine.llmFor(store), renderer }, req, {
      terms: excludedTerms(store.state.knowledge),
      dest: join(dir, 'effect.ecproj'),
      signal,
      ...(input.effect ? { given: input.effect } : {}),
    });
    const duration = Math.round(seconds * FLICKS_PER_SECOND);
    const frames = await cachedMotionFrames(
      renderer,
      {
        templateId: PROJECT_TEMPLATE_ID,
        params: { project: r.project.path, comp: EFFECT_COMP },
        duration,
        resolution: tl.resolution,
        frameRate: tl.frameRate,
      },
      { cacheRoot: join(store.paths.cache, 'render-frames'), signal },
    );
    signal.throwIfAborted();
    const createdAt = (opts.now ?? (() => new Date()))().toISOString();
    const stored: z.infer<typeof Stored> = {
      id,
      timelineId: tl.id,
      ...(input.slotId ? { slotId: input.slotId } : {}),
      name: r.effect.name,
      summary: r.effect.summary,
      seconds,
      ...(landAt !== undefined ? { landAt } : {}),
      sha256: r.project.sha256,
      createdAt,
      ...(r.provider ? { provider: r.provider } : {}),
      ...(r.model ? { model: r.model } : {}),
      sent: input.effect ? null : r.sent,
      effect: r.effect,
    };
    await writeFile(join(dir, 'proposal.json'), JSON.stringify(stored, null, 2));
    const fpf = flicksPerFrame(tl.frameRate);
    return {
      id,
      timelineId: tl.id,
      ...(input.slotId ? { slotId: input.slotId } : {}),
      name: r.effect.name,
      summary: r.effect.summary,
      seconds,
      ...(landAt !== undefined ? { landAt } : {}),
      attempts: r.attempts,
      repaired: r.repaired,
      ...(r.provider ? { provider: r.provider } : {}),
      ...(r.model ? { model: r.model } : {}),
      sent: stored.sent,
      preview: {
        dir: frames.dir,
        pattern: frames.pattern,
        frames: frames.frames,
        still: Math.min(
          frames.frames - 1,
          landAt !== undefined
            ? Math.round((landAt * FLICKS_PER_SECOND) / fpf)
            : Math.floor(frames.frames / 2),
        ),
      },
      warnings: [...r.project.warnings, ...frames.warnings],
      createdAt,
    };
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    if (e instanceof EffectRefusedError)
      throw new OpError('effect-refused', e.message, { problems: e.problems });
    throw e;
  }
}

async function readProposal(store: ProjectStore, proposalId: string) {
  if (!PROPOSAL_ID.test(proposalId)) throw new OpError('usage', `no proposal "${proposalId}"`);
  const dir = join(proposalsDir(store), proposalId);
  try {
    return { dir, p: Stored.parse(JSON.parse(await readFile(join(dir, 'proposal.json'), 'utf8'))) };
  } catch {
    throw new OpError(
      'not-found',
      `no proposal "${proposalId}" (it was accepted, rejected or never finished)`,
    );
  }
}

/**
 * The user said yes: the project file goes to `media/<sha256>.ecproj` and the effect onto the
 * Effects track at `at` seconds (snapped to a frame), as one undoable command with a decision
 * record. The proposal is then removed.
 */
export async function acceptEffectOp(
  engine: Engine,
  store: ProjectStore,
  input: { proposalId: string; at?: number },
  opts: { now?: () => Date } = {},
): Promise<{ itemId: string; project: string; start: number; duration: number }> {
  const { dir, p } = await readProposal(store, input.proposalId);
  const tl = store.state.timelines.find((t) => t.id === p.timelineId);
  if (!tl) throw new OpError('not-found', 'the cut this effect was made for is gone');
  const at = input.at ?? slotStart(tl, p.slotId);
  if (at === undefined || !(at >= 0))
    throw new OpError('usage', 'the effect needs a start time of 0 or later');
  const bytes = await readFile(join(dir, 'effect.ecproj'));
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== p.sha256) throw new OpError('failed', 'the proposal changed on disk; write it again');
  const rel = `media/${sha}.ecproj`;
  const abs = join(store.paths.dir, rel);
  if (!existsSync(abs)) {
    await mkdir(join(store.paths.dir, 'media'), { recursive: true });
    const tmp = `${abs}.tmp-${process.pid}`;
    await copyFile(join(dir, 'effect.ecproj'), tmp);
    await rename(tmp, abs);
  }
  const fpf = flicksPerFrame(tl.frameRate);
  const start = Math.round((at * FLICKS_PER_SECOND) / fpf) * fpf;
  const duration = Math.max(fpf, Math.round((p.seconds * FLICKS_PER_SECOND) / fpf) * fpf);
  const decisionId = `dec_${p.id}`;
  const before = new Set(tl.tracks.flatMap((t) => t.items.map((i) => i.id)));
  store.dispatch(addEffect.type, {
    timelineId: tl.id,
    start: Math.round(start),
    duration: Math.round(duration),
    project: rel,
    comp: EFFECT_COMP,
    label: p.name,
    decisionId,
    ...(p.slotId && slotOf(store, p.slotId) ? { slotId: p.slotId } : {}),
  });
  const after = store.state.timelines.find((t) => t.id === tl.id)!;
  const itemId = after.tracks.flatMap((t) => t.items).find((i) => !before.has(i.id))!.id;
  await appendDecisions(store.paths.decisions, [
    {
      id: decisionId,
      at: (opts.now ?? (() => new Date()))().toISOString(),
      step: 'effectcraft/author',
      subject: { kind: 'item', id: itemId },
      choice: { name: p.name, project: rel },
      reasons: {
        ...(p.provider ? { provider: p.provider } : {}),
        ...(p.model ? { model: p.model } : {}),
        writtenBy: p.sent ? 'model' : 'caller',
        ...(p.landAt !== undefined ? { landAt: p.landAt } : {}),
      },
      summary: `Custom effect "${p.name}": ${p.summary}`,
      alternatives: [],
    },
  ]);
  await rm(dir, { recursive: true, force: true });
  void engine;
  return { itemId, project: rel, start: Math.round(start), duration: Math.round(duration) };
}

/** The user said no: the proposal is removed; nothing in the project changes. */
export async function rejectEffectOp(
  store: ProjectStore,
  input: { proposalId: string },
): Promise<{ removed: string }> {
  const { dir } = await readProposal(store, input.proposalId);
  await rm(dir, { recursive: true, force: true });
  return { removed: input.proposalId };
}

export { AuthoredEffect } from '@trailerforge/effectcraft';

/** Seconds where a slot starts on a timeline (its first picture item), if it is on it. */
function slotStart(tl: Timeline, slotId: string | undefined): number | undefined {
  if (!slotId) return undefined;
  const starts = tl.tracks
    .filter((t) => t.kind === 'video' || t.kind === 'graphics')
    .flatMap((t) => t.items)
    .filter((i) => i.slotId === slotId)
    .map((i) => i.start);
  return starts.length ? Math.min(...starts) / FLICKS_PER_SECOND : undefined;
}

function slotOf(store: ProjectStore, slotId: string): Slot | undefined {
  return store.state.storyboard?.sections.flatMap((s) => s.slots).find((x) => x.id === slotId);
}

/**
 * What the storyboard generator may use from EffectCraft (plan M8 decision 5): the shipped
 * templates that are installed, with the card kinds each draws (those of its built-in fallback),
 * and effect briefs. Nothing when EffectCraft is not available, so generation is then exactly
 * what it was before.
 */
export async function generatorMotion(
  engine: Engine,
): Promise<
  | { motion: { templates: { id: string; name: string; cardKinds: string[] }[]; briefs: boolean } }
  | Record<string, never>
> {
  const r = engine.plugins.registries.motionRenderers.get('effectcraft/cli');
  if (!(r instanceof EffectCraftRenderer) || !(await r.available()).ok) return {};
  const reg = engine.plugins.registries.graphicTemplates;
  const templates = EC_TEMPLATES.filter((d) => reg.get(d.id)).map((d) => ({
    id: d.id,
    name: d.name,
    cardKinds: [...(reg.get(d.fallback)?.serves ?? [])],
  }));
  return { motion: { templates, briefs: true } };
}

/** The proposals waiting for a yes or no. */
export async function effectProposalsOp(store: ProjectStore): Promise<z.infer<typeof Stored>[]> {
  const { readdir } = await import('node:fs/promises');
  let ids: string[];
  try {
    ids = await readdir(proposalsDir(store));
  } catch {
    return [];
  }
  const out: z.infer<typeof Stored>[] = [];
  for (const id of ids.filter((x) => PROPOSAL_ID.test(x)).sort())
    try {
      out.push((await readProposal(store, id)).p);
    } catch {
      /* unfinished */
    }
  return out;
}

export interface BriefsOutcome {
  proposals: EffectProposal[];
  /** Briefs that were not written, and why (refused, already proposed or accepted). */
  skipped: { slotId: string; reason: string }[];
}

/**
 * The authoring pass after a storyboard is generated (plan M8 decision 5): one proposal per
 * effect brief that has neither a proposal waiting nor an accepted effect, one after the other.
 * Cancellable between and during briefs (the one in progress stores nothing); a refused brief is
 * reported and the pass goes on. Nothing is applied: each proposal waits for the user.
 */
export async function effectBriefsOp(
  engine: Engine,
  store: ProjectStore,
  opts: {
    signal?: AbortSignal | undefined;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<BriefsOutcome> {
  const waiting = new Set((await effectProposalsOp(store)).map((p) => p.slotId).filter(Boolean));
  const briefs = (store.state.storyboard?.sections ?? [])
    .flatMap((s) => s.slots)
    .map((slot) => ({ slot, brief: effectBriefOf(slot) }))
    .filter((x) => x.brief);
  const out: BriefsOutcome = { proposals: [], skipped: [] };
  let done = 0;
  for (const { slot, brief } of briefs) {
    opts.signal?.throwIfAborted();
    if (brief!.accepted) out.skipped.push({ slotId: slot.id, reason: 'accepted' });
    else if (waiting.has(slot.id)) out.skipped.push({ slotId: slot.id, reason: 'proposed' });
    else
      try {
        const seconds = Math.min(20, Math.max(0.5, slot.duration.ideal));
        out.proposals.push(
          await authorEffectOp(
            engine,
            store,
            { words: brief!.text, seconds, slotId: slot.id },
            { signal: opts.signal },
          ),
        );
      } catch (e) {
        if (opts.signal?.aborted || !(e instanceof OpError)) throw e;
        out.skipped.push({ slotId: slot.id, reason: e.message });
      }
    opts.onProgress?.(++done, briefs.length);
  }
  return out;
}
