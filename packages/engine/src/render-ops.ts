import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CompileError,
  DRAFT_ENCODE,
  EXPORT_PRESETS,
  compileAudio,
  compileRender,
  draftEncode,
  exportFileName,
  posterTime,
  resolveExport,
  sha256,
  toEdl,
  toFcpxml,
  toOtio,
  type GraphicFrames,
  type HandoffInput,
  type ResolvedExport,
  type SourceMedia,
} from '@trailerforge/compile';
import { appendDecisions, brandStatus, type ProjectStore } from '@trailerforge/core';
import {
  checkPlan,
  declaredFlashes,
  finding,
  gateVerdict,
  overrideDecision,
  type GateFinding,
  type GateOverride,
  type GateVerdict,
  type TakeSource,
} from '@trailerforge/cut';
import { checkScene, safeBox, timelineScenes, type TimelineScene } from '@trailerforge/graphics';
import { detectCapabilities, probe, runOutputGate, type Capabilities } from '@trailerforge/media';
import {
  FrameRenderer,
  RENDERER_VERSION,
  SEQUENCE_DONE,
  encodeAlphaClip,
  renderVideo,
  writePoster,
  type RenderProgress,
} from '@trailerforge/render';
import {
  FLICKS_PER_SECOND,
  approvalState,
  checkBrandContrast,
  flicksPerFrame,
  timelineDuration,
  type ApprovalState,
  type LibraryAsset,
  type MediaInfo,
  type StoryboardVariant,
  type Timeline,
} from '@trailerforge/schema';
import { readFootageAnalysis } from '@trailerforge/analysis';
import type { Engine } from './engine.js';
import { deriveVariantOp } from './graphics-ops.js';
import { OpError } from './ops.js';

/**
 * Review, render and export of a version of the trailer (`variantId` null = the master cut).
 * Everything derived (the version's timeline, the render plan, frames, drafts, the Quality Gate
 * report) is rebuilt from `project.json` and cached by content hash; the project stores only the
 * user's choices (export settings, comments, approvals). Renders read the project when they start
 * and never write to it, so editing can go on while one runs.
 */

const FIXED_ENCODE = { ...DRAFT_ENCODE, threads: 1 };
const DRAFT_HEIGHT = 720;
const keyOf = (variantId: string | null) => variantId ?? 'master';

export interface Progress {
  phase: 'graphics' | 'segments' | 'audio' | 'mux' | 'checking' | 'done';
  /** 0..1 over the whole job. */
  fraction: number;
  message?: string;
}
type OnProgress = (p: Progress) => void;

// ---- building a version ---------------------------------------------------------------------

export interface VersionBuild {
  variantId: string | null;
  name: string;
  timeline: Timeline;
  sources: Map<string, SourceMedia>;
  takeSources: Map<string, TakeSource>;
  scenes: TimelineScene[];
  /** Per scene: hash of what it draws (the frames' identity) and its frame count. */
  graphics: Map<string, GraphicFrames>;
  sceneMessages: { itemId: string; messages: string[] }[];
  contrastIssues: string[];
  beats: number[] | undefined;
  resolved: ResolvedExport;
  /** Set when the plan cannot be compiled (e.g. flashing more than three times a second). */
  compileError: string | undefined;
  /** Identifies the version's content (picture, graphics, sound), not the preset: what approvals vouch for. */
  contentHash: string;
  warnings: string[];
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** A timeline at most `maxHeight` tall, same shape (crops are normalised, so they carry over). */
function scaled(tl: Timeline, maxHeight: number): Timeline {
  const { width, height } = tl.resolution;
  if (height <= maxHeight) return tl;
  const s = maxHeight / height;
  return { ...tl, resolution: { width: even(width * s), height: even(height * s) } };
}

export async function buildVersion(
  engine: Engine,
  store: ProjectStore,
  variantId: string | null,
  o: { maxHeight?: number } = {},
): Promise<VersionBuild> {
  const project = store.state;
  let timeline: Timeline;
  let name: string;
  let exportSettings: StoryboardVariant['export'];
  if (variantId === null) {
    const master =
      project.timelines.find((t) => t.id === 'tl_rough') ??
      project.timelines.find((t) => !t.variantId);
    if (!master) throw new OpError('not-found', 'there is no cut yet: build the rough cut first');
    timeline = master;
    name = 'Master';
  } else {
    const v = project.storyboard?.variants.find((x) => x.id === variantId);
    if (!v) throw new OpError('not-found', `no version "${variantId}"`);
    timeline = (await deriveVariantOp(engine, store, variantId)).timeline;
    name = v.name || v.id;
    exportSettings = v.export;
  }
  if (o.maxHeight) timeline = scaled(timeline, o.maxHeight);
  const warnings: string[] = [];

  // The files the timeline uses, as the renderer and the checks need them.
  await engine.library.reload();
  const sources = new Map<string, SourceMedia>();
  const takeSources = new Map<string, TakeSource>();
  const used = new Set(
    timeline.tracks.flatMap((t) => t.items.flatMap((i) => ('assetId' in i ? [i.assetId] : []))),
  );
  for (const id of [...used].sort()) {
    const a = engine.library.get(id);
    if (!a || (await engine.library.status(id)) !== 'ok') continue;
    const media = await mediaOf(a);
    if (!media) continue;
    const v = media.video[0];
    const turned = v && (v.rotation === 90 || v.rotation === 270);
    sources.set(id, {
      path: a.uri,
      contentHash: a.contentHash ?? a.quickHash,
      width: v ? (turned ? v.height : v.width) : 0,
      height: v ? (turned ? v.width : v.height) : 0,
      frameRate: v?.frameRate ?? { num: 30, den: 1 },
      duration: media.duration,
      hasAudio: media.audio.length > 0,
      ...(v?.variableFrameRate ? { variableFrameRate: true } : {}),
    });
    const analysis = v ? await readFootageAnalysis(store.paths.analysisCache, a.quickHash) : null;
    takeSources.set(id, {
      duration: Math.round(media.duration * FLICKS_PER_SECOND),
      ...(analysis ? { footage: analysis } : {}),
    });
  }

  // Cards and captions.
  const status = await brandStatus(store.paths.dir, project.brand);
  const logoPresent = !status.warnings.some((w) => w.startsWith('The logo'));
  const { scenes, warnings: sceneWarnings } = timelineScenes({
    timeline,
    templates: engine.plugins.registries.graphicTemplates,
    brand: project.brand,
    fonts: status.fonts,
    logoPresent,
  });
  warnings.push(...sceneWarnings);
  const fpf = flicksPerFrame(timeline.frameRate);
  const safe = safeBox(timeline.resolution);
  const graphics = new Map<string, GraphicFrames>();
  const sceneMessages: VersionBuild['sceneMessages'] = [];
  for (const s of scenes) {
    const hash = sha256(
      JSON.stringify([
        RENDERER_VERSION,
        s.scene,
        timeline.frameRate,
        status.fonts,
        project.brand?.logo ?? null,
      ]),
    );
    graphics.set(s.itemId, {
      pattern: '',
      contentHash: hash,
      frames: Math.max(1, Math.round(s.scene.duration / fpf)),
    });
    sceneMessages.push({
      itemId: s.itemId,
      messages: checkScene(s.scene, safe, s.duration / FLICKS_PER_SECOND),
    });
  }
  const contrastIssues = project.brand
    ? checkBrandContrast(project.brand.colors).map((c) => c.message)
    : [];

  const beats = (await cutGridBeats(engine, store)) ?? undefined;
  const resolved = resolveExport(
    exportSettings?.presetId,
    { resolution: timeline.resolution, frameRate: timeline.frameRate },
    exportSettings?.loudnessLufs !== undefined ? { loudnessLufs: exportSettings.loudnessLufs } : {},
  );

  let compileError: string | undefined;
  let contentHash: string;
  try {
    const video = compileRender({ timeline, sources, graphics, encode: FIXED_ENCODE });
    const audio = compileAudio({ timeline, sources });
    contentHash = sha256(`${video.planHash}|${audio.planHash}`);
    warnings.push(...video.warnings, ...audio.warnings);
  } catch (err) {
    if (!(err instanceof CompileError)) throw err;
    compileError = err.message;
    contentHash = sha256(JSON.stringify([timeline, [...graphics.values()]]));
  }
  return {
    variantId,
    name,
    timeline,
    sources,
    takeSources,
    scenes,
    graphics,
    sceneMessages,
    contrastIssues,
    beats,
    resolved,
    compileError,
    contentHash,
    warnings: [...new Set([...status.warnings, ...warnings])],
  };
}

const probed = new Map<string, Promise<MediaInfo | null>>();
/** A library asset's media facts: the stored probe, or one made now (sounds added by the cut have none). */
function mediaOf(a: LibraryAsset): Promise<MediaInfo | null> {
  if (a.media) return Promise.resolve(a.media);
  const key = `${a.id}:${a.quickHash}`;
  let p = probed.get(key);
  if (!p) probed.set(key, (p = probe(a.uri).catch(() => null)));
  return p;
}

async function cutGridBeats(engine: Engine, store: ProjectStore): Promise<number[] | null> {
  const { cutGridOp } = await import('./footage-ops.js');
  return (await cutGridOp(engine, store))?.beats ?? null;
}

/** Render every card and caption of a build to PNG sequences (cached by what they draw). */
async function renderGraphics(
  store: ProjectStore,
  b: VersionBuild,
  signal: AbortSignal | undefined,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, GraphicFrames>> {
  const out = new Map<string, GraphicFrames>();
  if (b.scenes.length === 0) return out;
  const r = await FrameRenderer.create({ projectDir: store.paths.dir, brand: store.state.brand });
  let done = 0;
  for (const s of b.scenes) {
    signal?.throwIfAborted();
    const meta = b.graphics.get(s.itemId)!;
    const dir = join(store.paths.cache, 'render-frames', meta.contentHash.slice(0, 24));
    if (!(await exists(join(dir, SEQUENCE_DONE))))
      await r.renderSequence(s.scene, b.timeline.frameRate, dir, signal ? { signal } : {});
    out.set(s.itemId, {
      pattern: join(dir, 'frame_%06d.png'),
      contentHash: meta.contentHash,
      frames: meta.frames,
    });
    onProgress?.(++done, b.scenes.length);
  }
  return out;
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

const frames = (b: VersionBuild) =>
  Math.round(timelineDuration(b.timeline) / flicksPerFrame(b.timeline.frameRate));

// ---- the Quality Gate on the plan ---------------------------------------------------------------

export interface QualityReport {
  variantId: string | null;
  contentHash: string;
  preset: { id: string; name: string; extension: string };
  findings: GateFinding[];
  verdict: GateVerdict;
}

export function planFindings(b: VersionBuild): GateFinding[] {
  const out = checkPlan({
    timeline: b.timeline,
    sources: b.takeSources,
    ...(b.beats ? { beats: b.beats } : {}),
    graphicsIssues: b.sceneMessages,
    contrastIssues: b.contrastIssues,
  });
  for (const issue of b.resolved.issues) out.push(finding('core/output-format', issue));
  if (b.compileError && !out.some((f) => f.checkId === 'core/flash-plan'))
    out.push(finding('core/flash-plan', b.compileError));
  return out;
}

/** Everything the Quality Gate can say before rendering, and whether an export may go ahead. */
export async function qualityOp(
  engine: Engine,
  store: ProjectStore,
  variantId: string | null,
  overrides: readonly GateOverride[] = [],
): Promise<QualityReport> {
  const b = await buildVersion(engine, store, variantId);
  const findings = planFindings(b);
  return {
    variantId,
    contentHash: b.contentHash,
    preset: {
      id: b.resolved.preset.id,
      name: b.resolved.preset.name,
      extension: b.resolved.extension,
    },
    findings,
    verdict: gateVerdict(findings, overrides),
  };
}

// ---- review ----------------------------------------------------------------------------------

export interface VersionReview {
  variantId: string | null;
  name: string;
  formatTargetId: string | null;
  size: { width: number; height: number };
  seconds: number;
  /** What approvals vouch for; null when the version cannot be built. */
  contentHash: string | null;
  approval: ApprovalState;
  approvedAt?: string;
  openComments: number;
  comments: number;
  /** A review draft of exactly this content exists. */
  draftReady: boolean;
  export: { presetId: string; presetName: string; fileName: string; issues: string[] };
  /** Blocking and overridable findings, without the warnings. */
  gate: { blocking: number; needsOverride: number; warnings: number };
}

export async function reviewViewOp(engine: Engine, store: ProjectStore): Promise<VersionReview[]> {
  const project = store.state;
  const ids: (string | null)[] = [];
  if (project.timelines.some((t) => t.id === 'tl_rough' || !t.variantId)) ids.push(null);
  for (const v of project.storyboard?.variants ?? []) ids.push(v.id);
  const out: VersionReview[] = [];
  for (const id of ids) {
    let b: VersionBuild;
    try {
      b = await buildVersion(engine, store, id);
    } catch (err) {
      if (err instanceof OpError) continue;
      throw err;
    }
    const v = project.storyboard?.variants.find((x) => x.id === id);
    const approval = project.review.approvals.find((a) => a.variantId === id);
    const comments = project.review.comments.filter((c) => c.variantId === id);
    const verdict = gateVerdict(planFindings(b));
    out.push({
      variantId: id,
      name: b.name,
      formatTargetId: v?.formatTargetId ?? null,
      size: b.timeline.resolution,
      seconds: Math.round((timelineDuration(b.timeline) / FLICKS_PER_SECOND) * 100) / 100,
      contentHash: b.compileError ? null : b.contentHash,
      approval: approvalState(project.review, id, b.compileError ? null : b.contentHash),
      ...(approval ? { approvedAt: approval.approvedAt } : {}),
      openComments: comments.filter((c) => !c.resolved).length,
      comments: comments.length,
      draftReady: await exists(draftPath(store, id, b.contentHash)),
      export: {
        presetId: b.resolved.preset.id,
        presetName: b.resolved.preset.name,
        fileName: fileNameFor(store, b, v?.export?.fileName),
        issues: b.resolved.issues,
      },
      gate: {
        blocking: verdict.blocking.length,
        needsOverride: verdict.needsOverride.length,
        warnings: verdict.warnings.length,
      },
    });
  }
  return out;
}

/** Approve a version as it is now (its content hash is computed here, not by the caller). */
export async function approveVersionOp(
  engine: Engine,
  store: ProjectStore,
  o: { variantId: string | null; note?: string },
): Promise<{ contentHash: string }> {
  const b = await buildVersion(engine, store, o.variantId);
  if (b.compileError)
    throw new OpError('usage', `this version cannot be rendered yet: ${b.compileError}`);
  store.dispatch('core/review.approve', {
    variantId: o.variantId,
    planHash: b.contentHash,
    ...(o.note ? { note: o.note } : {}),
  });
  return { contentHash: b.contentHash };
}

// ---- presets ---------------------------------------------------------------------------------

export interface PresetsView {
  presets: { id: string; name: string; platform: string; description: string; extension: string }[];
  hardwareDraftEncoder: string | null;
}

const caps = new WeakMap<Engine, Promise<Capabilities | null>>();
async function capabilities(engine: Engine): Promise<Capabilities | null> {
  let c = caps.get(engine);
  if (!c) caps.set(engine, (c = detectCapabilities().catch(() => null)));
  return c;
}

/** Fast-quality arguments for the hardware H.264 encoders worth using for drafts. */
export function hardwareDraftArgs(encoder: string): string[] | null {
  switch (encoder) {
    case 'h264_nvenc':
      return ['-preset', 'p4', '-cq', '30', '-b:v', '0'];
    case 'h264_qsv':
      return ['-global_quality', '30'];
    case 'h264_videotoolbox':
      return ['-q:v', '55'];
    case 'h264_amf':
      return ['-quality', 'speed', '-rc', 'cqp', '-qp_i', '30', '-qp_p', '30'];
    default:
      return null; // vaapi needs device and filter setup: software instead
  }
}

export async function presetsViewOp(engine: Engine): Promise<PresetsView> {
  const c = await capabilities(engine);
  const hw = c?.workingHwEncoders.find((e) => hardwareDraftArgs(e)) ?? null;
  return {
    presets: EXPORT_PRESETS.map((p) => ({
      id: p.id,
      name: p.name,
      platform: p.platform,
      description: p.description,
      extension: p.container,
    })),
    hardwareDraftEncoder: hw,
  };
}

// ---- drafts ----------------------------------------------------------------------------------

const draftPath = (store: ProjectStore, variantId: string | null, contentHash: string) =>
  join(store.paths.cache, 'drafts', `${keyOf(variantId)}-${contentHash.slice(0, 16)}.mp4`);

/** The review draft of a version if one exists for its current content. */
export async function draftFileOp(
  engine: Engine,
  store: ProjectStore,
  variantId: string | null,
): Promise<string | null> {
  const b = await buildVersion(engine, store, variantId);
  const p = draftPath(store, variantId, b.contentHash);
  return (await exists(p)) ? p : null;
}

export interface DraftResult {
  variantId: string | null;
  file: string;
  contentHash: string;
  hardware: boolean;
  warnings: string[];
}

/**
 * A 720p review draft (software H.264, or a working hardware encoder when one is detected, with
 * a software retry if it fails), cached by the version's content hash.
 */
export async function renderDraftOp(
  engine: Engine,
  store: ProjectStore,
  variantId: string | null,
  o: { signal?: AbortSignal; onProgress?: OnProgress; hardware?: boolean } = {},
): Promise<DraftResult> {
  const full = await buildVersion(engine, store, variantId);
  if (full.compileError) throw new OpError('usage', `cannot render a draft: ${full.compileError}`);
  const b = await buildVersion(engine, store, variantId, { maxHeight: DRAFT_HEIGHT });
  const file = draftPath(store, variantId, full.contentHash);
  const c = o.hardware === false ? null : await capabilities(engine);
  const hwEncoder = c?.workingHwEncoders.find((e) => hardwareDraftArgs(e)) ?? null;
  const run = async (hardware: boolean) => {
    const encode = hardware
      ? draftEncode({ codec: hwEncoder!, args: hardwareDraftArgs(hwEncoder!)! })
      : draftEncode();
    return renderBuild(store, b, {
      encode,
      audioCodec: ['-c:a', 'aac', '-b:a', '160k'],
      loudness: b.resolved.loudness,
      output: file,
      workKey: 'draft',
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.onProgress ? { onProgress: o.onProgress } : {}),
    });
  };
  let hardware = false;
  let warnings: string[];
  try {
    if (hwEncoder) {
      try {
        warnings = (await run(true)).warnings;
        hardware = true;
      } catch (err) {
        if (o.signal?.aborted) throw err;
        warnings = [`the ${hwEncoder} encoder failed; rendered with the software encoder`];
        warnings.push(...(await run(false)).warnings);
      }
    } else warnings = (await run(false)).warnings;
  } catch (err) {
    throw asOpError(err);
  }
  return {
    variantId,
    file,
    contentHash: full.contentHash,
    hardware,
    warnings: [...b.warnings, ...warnings],
  };
}

function asOpError(err: unknown): unknown {
  if (err instanceof CompileError) return new OpError('failed', err.message);
  return err;
}

interface RenderBuildOptions {
  encode: ReturnType<typeof draftEncode>;
  audioCodec: string[];
  loudness: ResolvedExport['loudness'] | null;
  output: string;
  workKey: string;
  signal?: AbortSignal;
  onProgress?: OnProgress;
}

async function renderBuild(store: ProjectStore, b: VersionBuild, o: RenderBuildOptions) {
  const report = (p: Progress) => o.onProgress?.(p);
  report({ phase: 'graphics', fraction: 0, message: 'Drawing cards and captions' });
  const graphics = await renderGraphics(store, b, o.signal, (d, t) =>
    report({ phase: 'graphics', fraction: 0.1 * (d / t) }),
  );
  const phaseAt: Record<RenderProgress['phase'], number> = {
    segments: 0.1,
    audio: 0.85,
    mux: 0.95,
    done: 1,
  };
  const r = await renderVideo(
    {
      timeline: b.timeline,
      sources: [...b.sources],
      graphics: [...graphics],
      encode: o.encode,
      audioCodec: o.audioCodec,
      loudness: o.loudness,
      output: o.output,
    },
    {
      workRoot: join(store.paths.cache, 'render', o.workKey),
      loudnessCache: join(store.paths.cache, 'render', 'loudness'),
      ...(o.signal ? { signal: o.signal } : {}),
      onProgress: (p) =>
        report({
          phase: p.phase,
          fraction:
            p.phase === 'segments'
              ? 0.1 + 0.75 * (p.segments ? p.segmentsDone / p.segments : 1)
              : phaseAt[p.phase],
        }),
    },
  );
  return r;
}

// ---- export ----------------------------------------------------------------------------------

function fileNameFor(store: ProjectStore, b: VersionBuild, template: string | undefined): string {
  const fmt = store.state.formatTargets.find((f) => {
    const v = store.state.storyboard?.variants.find((x) => x.id === b.variantId);
    return f.id === v?.formatTargetId;
  });
  return exportFileName(
    template,
    {
      project: store.state.name,
      version: b.name,
      format: fmt?.name ?? `${b.timeline.resolution.width}x${b.timeline.resolution.height}`,
      preset: b.resolved.preset.name,
    },
    b.resolved.extension,
  );
}

export interface ExportResult {
  variantId: string | null;
  file: string;
  poster: string;
  record: string;
  sha256: string;
  contentHash: string;
  preset: string;
  reproducible: boolean;
  /** Findings that did not block (warnings and overridden errors). */
  findings: GateFinding[];
  overridden: string[];
  warnings: string[];
}

/**
 * Render a version with its preset and check the result. The Quality Gate runs twice: on the
 * plan before rendering (hard blocks stop here, overridable ones need an override with a reason)
 * and on the file afterwards (a measured flash risk, peak or size problem removes the file and
 * reports). Overrides used are written to the decision log. The result goes to
 * `<project>/exports/render/<name>`, with a poster frame and a JSON record next to it.
 */
export async function exportVersionOp(
  engine: Engine,
  store: ProjectStore,
  variantId: string | null,
  o: {
    overrides?: readonly GateOverride[];
    signal?: AbortSignal;
    onProgress?: OnProgress;
    now?: () => Date;
  } = {},
): Promise<ExportResult> {
  const overrides = o.overrides ?? [];
  const b = await buildVersion(engine, store, variantId);
  const v = store.state.storyboard?.variants.find((x) => x.id === variantId);
  const planFound = planFindings(b);
  const planVerdict = gateVerdict(planFound, overrides);
  if (!planVerdict.allowed)
    throw new OpError('gate-blocked', gateMessage('before rendering', planVerdict), {
      stage: 'plan',
      verdict: planVerdict,
    });

  const work = join(store.paths.cache, 'render-out');
  const tmpOut = join(
    work,
    `${keyOf(variantId)}-${b.contentHash.slice(0, 16)}-${b.resolved.preset.id.replace('/', '-')}.${b.resolved.extension}`,
  );
  let r;
  try {
    r = await renderBuild(store, b, {
      encode: b.resolved.encode,
      audioCodec: b.resolved.audioCodec,
      loudness: b.resolved.loudness,
      output: tmpOut,
      workKey: `export-${b.resolved.preset.id.replace('/', '-')}`,
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.onProgress ? { onProgress: o.onProgress } : {}),
    });
  } catch (err) {
    throw asOpError(err);
  }
  o.onProgress?.({ phase: 'checking', fraction: 0.97, message: 'Checking the file' });
  // The poster is taken while the file is checked; it is delivered only with the file.
  const posterTmp = `${tmpOut}.poster.png`;
  const [out] = await Promise.all([
    runOutputGate(
      tmpOut,
      {
        width: b.timeline.resolution.width,
        height: b.timeline.resolution.height,
        rate: b.timeline.frameRate,
        frames: frames(b),
        loudness: { lufs: b.resolved.loudness.lufs, truePeakDb: b.resolved.loudness.truePeakDb },
        declaredFlashes: declaredFlashes(b.timeline).map((e) => e.at),
      },
      { cacheDir: join(store.paths.cache, 'quality'), ...(o.signal ? { signal: o.signal } : {}) },
    ),
    writePoster(
      tmpOut,
      posterTime(timelineDuration(b.timeline) / FLICKS_PER_SECOND, v?.export?.posterSeconds),
      posterTmp,
    ),
  ]);
  const outVerdict = gateVerdict(
    out.findings.map((f) => ({ ...f, ...(f.tier ? {} : { tier: 'hard' as const }) })),
    overrides,
  );
  if (!outVerdict.allowed) {
    await rm(tmpOut, { force: true });
    await rm(posterTmp, { force: true });
    throw new OpError('gate-blocked', gateMessage('on the rendered file', outVerdict), {
      stage: 'output',
      verdict: outVerdict,
    });
  }

  // Deliver.
  const name = fileNameFor(store, b, v?.export?.fileName);
  const dir = join(store.paths.exports, 'render', keyOf(variantId));
  const file = join(dir, name);
  await mkdir(dir, { recursive: true });
  await copyAtomic(tmpOut, file);
  const poster = file.replace(/\.[^.]+$/, '.png');
  await copyAtomic(posterTmp, poster);
  await rm(posterTmp, { force: true });
  const used = [...planVerdict.overridden, ...outVerdict.overridden];
  const now = (o.now ?? (() => new Date()))();
  const all = [...planFound, ...out.findings] as GateFinding[];
  const checks = [...new Map(used.map((f) => [f.checkId, f.reason])).entries()];
  await appendDecisions(
    store.paths.decisions,
    checks.map(([checkId, reason]) =>
      overrideDecision({
        override: { checkId, reason },
        variantId: keyOf(variantId),
        planHash: b.contentHash,
        findings: all,
        now,
      }),
    ),
  );
  const result: ExportResult = {
    variantId,
    file,
    poster,
    record: file.replace(/\.[^.]+$/, '.export.json'),
    sha256: r.sha256,
    contentHash: b.contentHash,
    preset: b.resolved.preset.id,
    reproducible: r.manifest.reproducible,
    findings: [
      ...planVerdict.warnings,
      ...outVerdict.warnings,
      ...planVerdict.overridden,
      ...outVerdict.overridden,
    ],
    overridden: checks.map(([c]) => c),
    warnings: [...new Set([...b.warnings, ...r.warnings])],
  };
  await writeAtomic(
    result.record,
    JSON.stringify({ ...result, ffmpeg: r.manifest.ffmpeg, facts: out.facts }, null, 2),
  );
  o.onProgress?.({ phase: 'done', fraction: 1 });
  return result;
}

function gateMessage(when: string, v: GateVerdict): string {
  const blocking = v.blocking.map((f) => f.message);
  const needs = v.needsOverride.map((f) => `${f.message} (needs an override)`);
  return `The Quality Gate stopped the export ${when}: ${[...blocking, ...needs].join('; ')}`;
}

async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function copyAtomic(from: string, to: string): Promise<void> {
  const tmp = `${to}.tmp-${process.pid}`;
  try {
    await copyFile(from, tmp);
    await rename(tmp, to);
  } finally {
    await rm(tmp, { force: true });
  }
}

// ---- NLE handoff -----------------------------------------------------------------------------

export type HandoffFormat = 'fcpxml' | 'otio' | 'edl';

export interface HandoffResult {
  variantId: string | null;
  dir: string;
  files: { format: HandoffFormat; file: string }[];
  /** Alpha clips rendered for cards and captions. */
  graphics: string[];
  warnings: string[];
}

/**
 * Write a version for an editor: FCPXML, OTIO and/or EDL next to ProRes 4444 clips (with alpha)
 * of its cards and captions, under `<project>/exports/handoff/<version>/`. Recordings are
 * referenced where they are, never copied.
 */
export async function handoffOp(
  engine: Engine,
  store: ProjectStore,
  variantId: string | null,
  o: { formats?: readonly HandoffFormat[]; signal?: AbortSignal; onProgress?: OnProgress } = {},
): Promise<HandoffResult> {
  const formats = o.formats?.length ? o.formats : (['fcpxml', 'otio', 'edl'] as const);
  const b = await buildVersion(engine, store, variantId);
  const dir = join(store.paths.exports, 'handoff', keyOf(variantId));
  await mkdir(dir, { recursive: true });
  const frames = await renderGraphics(store, b, o.signal);
  const clips = new Map<string, { path: string; frames: number }>();
  let n = 0;
  for (const [itemId, g] of frames) {
    o.signal?.throwIfAborted();
    const path = join(dir, `${itemId}-${g.contentHash.slice(0, 10)}.mov`);
    if (!(await exists(path)))
      await encodeAlphaClip(g, b.timeline.frameRate, path, o.signal ? { signal: o.signal } : {});
    clips.set(itemId, { path, frames: g.frames });
    o.onProgress?.({ phase: 'graphics', fraction: ++n / frames.size });
  }
  const input: HandoffInput = {
    timeline: b.timeline,
    name: `${store.state.name} - ${b.name}`,
    sources: b.sources,
    graphics: clips,
  };
  const base = fileNameFor(store, b, undefined).replace(/\.[^.]+$/, '');
  const files: HandoffResult['files'] = [];
  for (const f of formats) {
    const text = f === 'fcpxml' ? toFcpxml(input) : f === 'otio' ? toOtio(input) : toEdl(input);
    const file = join(dir, `${base}.${f}`);
    await writeAtomic(file, text);
    files.push({ format: f, file });
  }
  const missing = b.timeline.tracks.flatMap((t) =>
    t.items.flatMap((i) =>
      i.kind === 'placeholder'
        ? [`"${i.label ?? i.slotId ?? i.id}" is still a placeholder`]
        : i.kind === 'clip' && !b.sources.has(i.assetId)
          ? [`the recording for "${i.label ?? i.slotId ?? i.id}" cannot be found`]
          : [],
    ),
  );
  o.onProgress?.({ phase: 'done', fraction: 1 });
  return {
    variantId,
    dir,
    files,
    graphics: [...clips.values()].map((c) => c.path),
    warnings: [...missing, ...b.warnings],
  };
}

/** Read an export record (for status views); null when there is none. */
export async function readExportRecord(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}
