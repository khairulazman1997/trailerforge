import type { ProjectStore } from '@trailerforge/core';
import {
  buildCaptureHints,
  buildCapturePack,
  buildCapturePlan,
  generateCaptureTips,
  renderCapturePack,
  RecordingPatch,
  resolveCaptureTips,
  resolveRecordingSettings,
  writeCapturePack,
  type CapturePackFormat,
  type CapturePlan,
  type CaptureTipsView,
  type GroupHints,
  type ResolvedRecording,
} from '@trailerforge/pack-game-trailer';
import { SlotStatus } from '@trailerforge/schema';
import type { Engine } from './engine.js';
import { OpError } from './ops.js';

/**
 * Capture-pack operations shared by the CLI, MCP server and local service. Reads compute from
 * `project.json`; edits go through the pack's typed commands, so each is undoable. Nothing here
 * stores a second copy of capture data.
 */

function requireStoryboard(store: ProjectStore) {
  const sb = store.state.storyboard;
  if (!sb) throw new OpError('not-found', 'this project has no storyboard yet; generate one first');
  return sb;
}

export interface CaptureView {
  plan: CapturePlan;
  /** One entry per plan group, in the same order. */
  hints: GroupHints[];
  tips: { groups: CaptureTipsView[]; orphanKeys: string[] };
  recording: ResolvedRecording;
}

/** The whole checklist: groups and shots, setup hints, stored tips and the recording settings. */
export function captureViewOp(
  _engine: Engine,
  store: ProjectStore,
  opts: { include?: 'all' | 'todo' } = {},
): CaptureView {
  const sb = requireStoryboard(store);
  const plan = buildCapturePlan(sb, store.state.knowledge, { include: opts.include ?? 'all' });
  return {
    plan,
    hints: buildCaptureHints(plan, store.state.knowledge),
    tips: resolveCaptureTips(store.state),
    recording: resolveRecordingSettings(store.state),
  };
}

export interface CaptureStatus {
  total: number;
  done: number;
  todoRecordSeconds: number;
  byStatus: Record<SlotStatus, number>;
  skipped: number;
  groups: { key: string; label: string; done: number; total: number }[];
  tips: { none: number; fresh: number; stale: number; edited: number };
}

export function captureStatusOp(engine: Engine, store: ProjectStore): CaptureStatus {
  const { plan, tips } = captureViewOp(engine, store);
  const byStatus: Record<SlotStatus, number> = { empty: 0, recorded: 0, approved: 0, rejected: 0 };
  for (const g of plan.groups) for (const i of g.items) byStatus[i.status] += 1;
  const tipCounts = { none: 0, fresh: 0, stale: 0, edited: 0 };
  for (const t of tips.groups) tipCounts[t.status] += 1;
  return {
    total: plan.total,
    done: plan.done,
    todoRecordSeconds: plan.todoRecordSeconds,
    byStatus,
    skipped: plan.skippedSlotIds.length,
    groups: plan.groups.map((g) => ({
      key: g.key,
      label: [g.location, g.setup, g.entity?.name].filter(Boolean).join(' · ') || 'Anywhere',
      done: g.done,
      total: g.total,
    })),
    tips: tipCounts,
  };
}

export function captureSettingsOp(_engine: Engine, store: ProjectStore): ResolvedRecording {
  return resolveRecordingSettings(store.state);
}

/** Change recording-setting overrides (`null` clears one) or `reset` them all. */
export function setCaptureSettingsOp(
  engine: Engine,
  store: ProjectStore,
  opts: { patch?: unknown; reset?: boolean },
): ResolvedRecording {
  if (opts.reset) store.dispatch('game-trailer/recording.reset-overrides', {});
  if (opts.patch !== undefined) {
    const patch = RecordingPatch.safeParse(opts.patch);
    if (!patch.success) {
      throw new OpError('usage', `invalid recording settings: ${patch.error.issues[0]?.message}`);
    }
    if (Object.keys(patch.data).length > 0) {
      store.dispatch('game-trailer/recording.set-overrides', patch.data);
    }
  }
  return captureSettingsOp(engine, store);
}

export interface MarkOptions {
  slotId: string;
  status?: SlotStatus | undefined;
  notes?: string | undefined;
  takes?: number | undefined;
  skipped?: boolean | undefined;
}

/** Mark a shot recorded/approved/rejected, set its notes or take count, or skip/restore it. */
export function captureMarkOp(
  engine: Engine,
  store: ProjectStore,
  opts: MarkOptions,
): { slotId: string; changed: string[] } {
  const slot = requireStoryboard(store)
    .sections.flatMap((s) => s.slots)
    .find((s) => s.id === opts.slotId);
  if (!slot) throw new OpError('not-found', `no slot "${opts.slotId}"`);
  if (slot.kind !== 'shot') {
    throw new OpError('usage', `"${opts.slotId}" is a generated card; only shots are recorded`);
  }
  if (opts.status !== undefined && !SlotStatus.safeParse(opts.status).success) {
    throw new OpError('usage', `status must be one of ${SlotStatus.options.join(', ')}`);
  }
  if (opts.takes !== undefined && !(Number.isInteger(opts.takes) && opts.takes >= 0)) {
    throw new OpError('usage', 'takes must be a whole number, 0 or more');
  }
  const slotId = opts.slotId;
  const changed: string[] = [];
  const run = (type: string, payload: object, what: string) => {
    store.dispatch(type, { slotId, ...payload });
    changed.push(what);
  };
  if (opts.status !== undefined)
    run('game-trailer/capture.set-status', { status: opts.status }, 'status');
  if (opts.notes !== undefined)
    run('game-trailer/capture.set-notes', { notes: opts.notes }, 'notes');
  if (opts.takes !== undefined)
    run('game-trailer/capture.set-takes', { takes: opts.takes }, 'takes');
  if (opts.skipped !== undefined)
    run('game-trailer/capture.set-skipped', { skipped: opts.skipped }, 'skipped');
  if (changed.length === 0)
    throw new OpError('usage', 'nothing to change: pass a status, notes, takes or skip');
  return { slotId, changed };
}

export interface TipsOptions {
  groupKeys?: readonly string[] | undefined;
  force?: boolean | undefined;
  overwriteEdited?: boolean | undefined;
  /** Cancels the model call; a cancelled run never writes to the project. */
  signal?: AbortSignal | undefined;
}

export interface TipsOutcome {
  written: { key: string; tips: number; risks: number }[];
  skipped: { key: string; reason: string }[];
}

/** Ask the model for tips on the groups that need them and store the result. */
export async function captureTipsOp(
  engine: Engine,
  store: ProjectStore,
  opts: TipsOptions = {},
): Promise<TipsOutcome> {
  requireStoryboard(store);
  const r = await generateCaptureTips({ llm: engine.llm }, store.state, {
    ...(opts.groupKeys ? { groupKeys: opts.groupKeys } : {}),
    ...(opts.force !== undefined ? { force: opts.force } : {}),
    ...(opts.overwriteEdited !== undefined ? { overwriteEdited: opts.overwriteEdited } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  opts.signal?.throwIfAborted();
  if (r.apply.groups.length > 0) store.dispatch('game-trailer/capture.apply-tips', r.apply);
  return {
    written: r.apply.groups.map((g) => ({
      key: g.key,
      tips: g.tips.length,
      risks: g.risks.length,
    })),
    skipped: r.skipped,
  };
}

export interface ExportOptions {
  formats?: readonly CapturePackFormat[] | undefined;
  /** Leave out everything about entities excluded from LLM use (for a pack you share). */
  omitExcluded?: boolean | undefined;
}

export interface ExportOutcome {
  /** Project-relative paths, forward slashes. */
  files: string[];
  shots: number;
  done: number;
}

export async function captureExportOp(
  _engine: Engine,
  store: ProjectStore,
  opts: ExportOptions = {},
): Promise<ExportOutcome> {
  requireStoryboard(store);
  const formats = opts.formats?.length ? opts.formats : undefined;
  const bad = formats?.find((f) => !['md', 'html', 'json'].includes(f));
  if (bad) throw new OpError('usage', `format must be md, html or json, got "${bad}"`);
  const pack = buildCapturePack(store.state, { omitExcluded: opts.omitExcluded ?? false });
  const files = await writeCapturePack(store.paths.dir, pack, formats);
  return { files, shots: pack.progress.total, done: pack.progress.done };
}

const MIME: Record<CapturePackFormat, string> = {
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

export interface RenderedPack {
  /** A plain file name, never a path. */
  filename: string;
  mime: string;
  content: string;
}

/** The pack as text for the UI to download; nothing is written on this computer. */
export function captureRenderOp(
  _engine: Engine,
  store: ProjectStore,
  opts: { format: CapturePackFormat; omitExcluded?: boolean | undefined },
): RenderedPack {
  requireStoryboard(store);
  if (!(opts.format in MIME)) {
    throw new OpError('usage', `format must be md, html or json, got "${opts.format}"`);
  }
  const pack = buildCapturePack(store.state, { omitExcluded: opts.omitExcluded ?? false });
  return {
    filename: `capture-pack.${opts.format}`,
    mime: MIME[opts.format],
    content: renderCapturePack(pack, opts.format),
  };
}
