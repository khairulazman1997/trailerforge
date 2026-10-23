import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { assumptionsFor, checkCompleteness, type CompletenessReport } from '@trailerforge/brief';
import { appendDecisions, type ProjectStore } from '@trailerforge/core';
import {
  deepScan,
  detectExtractors,
  scanRepo,
  scanSource,
  type ScanManifest,
} from '@trailerforge/knowledge';
import type { ResolvedVideoType } from '@trailerforge/plugin-api';
import {
  collectIds,
  mintId,
  type KnowledgeEntity,
  type KnowledgeSource,
} from '@trailerforge/schema';
import { generateStoryboard, regenerateSection } from '@trailerforge/storyboard';
import type { Engine } from './engine.js';

/**
 * Operations that combine several subsystems (brief + plugins, scanner + extractors + merge,
 * LLM + storyboard commands). The CLI, the MCP server and the local service all call these, so
 * there is one implementation of each. They return plain data; callers decide how to show it.
 */

/** A problem the caller can explain to the user. `usage` means the request itself was wrong. */
export class OpError extends Error {
  constructor(
    readonly code: 'usage' | 'no-video-type' | 'brief-incomplete' | 'not-found',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'OpError';
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function videoTypeOf(engine: Engine, store: ProjectStore): ResolvedVideoType {
  const id = store.state.brief.videoTypeId;
  if (!id) {
    throw new OpError(
      'no-video-type',
      'this project has no video type; create it with `tforge new --type <videoTypeId>`',
    );
  }
  return engine.plugins.registries.videoTypes.require(id);
}

// ------------------------------------------------------------------ brief

export interface MissingField {
  field: string;
  label: string;
  required: boolean;
  reason: string;
  have?: number;
}

export interface BriefStatus {
  videoTypeId: string;
  videoTypeName: string;
  /** 0..1, two decimals. */
  score: number;
  complete: boolean;
  canProceed: boolean;
  missing: MissingField[];
  assumed: { field: string; label: string; assumption: unknown; reason: string }[];
}

function describeMissing(report: CompletenessReport): MissingField[] {
  return report.missing.map((m) => ({
    field: m.requirement.field,
    label: m.requirement.label,
    required: m.requirement.required,
    reason: m.reason,
    ...(m.have !== undefined ? { have: m.have } : {}),
  }));
}

export function briefStatus(engine: Engine, store: ProjectStore): BriefStatus {
  const vt = videoTypeOf(engine, store);
  const report = checkCompleteness(store.state, vt);
  return {
    videoTypeId: report.videoTypeId,
    videoTypeName: vt.name,
    score: Math.round(report.score * 100) / 100,
    complete: report.complete,
    canProceed: report.canProceed,
    missing: describeMissing(report),
    assumed: report.assumed.map((a) => ({
      field: a.requirement.field,
      label: a.requirement.label,
      assumption: a.assumption.value,
      reason: a.assumption.reason,
    })),
  };
}

// ------------------------------------------------------------------ storyboard

export interface GenerateOptions {
  /** Target length in seconds; default 60 clamped to the video type's typical range. */
  duration?: number | undefined;
  /** Template id; default the video type's own. */
  template?: string | undefined;
  /** Proceed with logged assumptions when required brief fields are missing. */
  assume?: boolean | undefined;
  /** Cancels the LLM call; a cancelled generation never writes to the project. */
  signal?: AbortSignal | undefined;
}

export interface GenerateOutcome {
  provider: string;
  sections: { id: string; name: string; locked: boolean; slots: string[] }[];
  slots: number;
  seconds: number;
  rationale: string;
  /** Assumptions that were logged to let generation proceed. */
  assumptionsAdded: number;
}

export async function generateStoryboardOp(
  engine: Engine,
  store: ProjectStore,
  opts: GenerateOptions = {},
): Promise<GenerateOutcome> {
  const vt = videoTypeOf(engine, store);
  const duration =
    opts.duration === undefined
      ? Math.min(Math.max(60, vt.typicalDuration?.min ?? 0), vt.typicalDuration?.max ?? 60)
      : opts.duration;
  if (!(duration > 0) || !Number.isFinite(duration)) {
    throw new OpError(
      'usage',
      `duration must be a positive number of seconds, got "${opts.duration}"`,
    );
  }
  const templateId = opts.template ?? vt.defaultTemplateId;
  if (!templateId)
    throw new OpError('usage', `${vt.name} has no default template; pass a template id`);
  const template = engine.plugins.registries.templates.require(templateId);

  const report = checkCompleteness(store.state, vt);
  let assumptionsAdded = 0;
  if (!report.canProceed) {
    if (!opts.assume) {
      throw new OpError(
        'brief-incomplete',
        'The brief is missing required details. Fill them in, or proceed with logged assumptions.',
        describeMissing(report).filter((m) => m.required),
      );
    }
    for (const a of assumptionsFor(report, new Map(), new Date())) {
      store.dispatch('core/brief.add-assumption', a);
      assumptionsAdded++;
    }
  }

  const { storyboard, decisions } = await generateStoryboard({ llm: engine.llm }, store.state, {
    template,
    targetDuration: duration,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  opts.signal?.throwIfAborted();
  store.dispatch('core/storyboard.set', storyboard);
  await appendDecisions(store.paths.decisions, decisions);

  const slots = storyboard.sections.reduce((n, s) => n + s.slots.length, 0);
  return {
    provider: String(decisions[0]?.reasons.provider ?? '?'),
    sections: storyboard.sections.map((s) => ({
      id: s.id,
      name: s.name,
      locked: s.locked,
      slots: s.slots.map((x) => x.title || x.id),
    })),
    slots,
    seconds: round1(
      storyboard.sections.reduce(
        (n, s) => n + s.slots.reduce((m, x) => m + x.duration.ideal, 0),
        0,
      ),
    ),
    rationale: decisions[0]?.summary ?? '',
    assumptionsAdded,
  };
}

export interface RegenerateOutcome {
  provider: string;
  section: { id: string; name: string; slots: string[] };
  /** Slots that were kept because the user edited or added them. */
  keptSlotIds: string[];
  rationale: string;
}

export async function regenerateSectionOp(
  engine: Engine,
  store: ProjectStore,
  opts: {
    sectionId: string;
    instruction?: string | undefined;
    keepEdited?: boolean | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<RegenerateOutcome> {
  if (!store.state.storyboard) {
    throw new OpError('not-found', 'this project has no storyboard yet; generate one first');
  }
  const { payload, decisions } = await regenerateSection({ llm: engine.llm }, store.state, {
    sectionId: opts.sectionId,
    ...(opts.instruction ? { instruction: opts.instruction } : {}),
    ...(opts.keepEdited !== undefined ? { keepEdited: opts.keepEdited } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  opts.signal?.throwIfAborted();
  store.dispatch('core/storyboard.replace-section', payload);
  await appendDecisions(store.paths.decisions, decisions);
  return {
    provider: String(decisions[0]?.reasons.provider ?? '?'),
    section: {
      id: payload.section.id,
      name: payload.section.name,
      slots: payload.section.slots.map((s) => s.title || s.id),
    },
    keptSlotIds: (decisions[0]?.reasons.pinnedSlotIds as string[] | undefined) ?? [],
    rationale: decisions[0]?.summary ?? '',
  };
}

// ------------------------------------------------------------------ knowledge

export const DEEP_SCAN_WARNING =
  'Deep scan sends the contents of your project files (text only, no secrets, no ignored files) ' +
  'to Anthropic through Claude Code. Confirm explicitly to run it.';

export interface ScanOptions {
  /** Repo folder; required the first time, optional afterwards when the project has one source. */
  repo?: string | undefined;
  /** Re-extract even if the repo hashes the same as the last scan. */
  force?: boolean | undefined;
  /** Also run the Claude Code deep scan. Needs `allowDeep`. */
  deep?: boolean | undefined;
  /** The user's explicit confirmation of the deep-scan warning. */
  allowDeep?: boolean | undefined;
  claudeBin?: string | undefined;
  /** Progress notices worth showing before a slow or sensitive step. */
  onNotice?: (message: string) => void;
  /** Cancels the scan; nothing is merged once cancelled. */
  signal?: AbortSignal | undefined;
}

export interface ScanSummary {
  sourceId: string;
  path: string;
  files: number;
  skipped: Record<string, number>;
  extractors: string[];
  unchanged: boolean;
  truncated: boolean;
  problems: { extractorId: string; message: string }[];
  added: number;
  updated: number;
  removed: number;
  total: number;
  deep?: { entities: number; filesShared: number; truncated: boolean };
}

async function readManifest(path: string): Promise<ScanManifest | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as ScanManifest;
  } catch {
    return undefined;
  }
}

function diffKnowledge(before: readonly KnowledgeEntity[], after: readonly KnowledgeEntity[]) {
  const was = new Map(before.map((e) => [e.id, JSON.stringify(e)]));
  const now = new Map(after.map((e) => [e.id, JSON.stringify(e)]));
  return {
    added: [...now.keys()].filter((id) => !was.has(id)).length,
    removed: [...was.keys()].filter((id) => !now.has(id)).length,
    updated: [...now].filter(([id, json]) => was.has(id) && was.get(id) !== json).length,
  };
}

/** Scan a game repo into the project's knowledge base (see `core/knowledge.apply-scan`). */
export async function scanKnowledgeOp(
  engine: Engine,
  store: ProjectStore,
  opts: ScanOptions = {},
): Promise<ScanSummary> {
  if (opts.deep && !opts.allowDeep) throw new OpError('usage', DEEP_SCAN_WARNING);
  const extractors = engine.plugins.registries.knowledgeExtractors;
  const repo = opts.repo ? resolve(opts.repo) : undefined;

  let source: KnowledgeSource | undefined = store.state.sources.find((s) =>
    repo ? s.path === repo : true,
  );
  if (!repo && store.state.sources.length > 1) {
    throw new OpError('usage', 'this project has several sources; say which repo to scan');
  }
  if (!source) {
    if (!repo) {
      throw new OpError('usage', 'this project has no source yet; give the path of your game repo');
    }
    const detected = await detectExtractors(await scanRepo(repo), extractors.list());
    source = {
      id: mintId('src', basename(repo), collectIds(store.state)),
      kind: 'local-repo',
      path: repo,
      extractorIds: detected,
      include: [],
      exclude: [],
      lastScannedAt: null,
      digestHash: null,
    };
    store.dispatch('core/knowledge.add-source', source);
  }

  const manifestPath = join(store.paths.cache, `scan-${source.id}.json`);
  const previous = opts.force ? undefined : await readManifest(manifestPath);
  const result = await scanSource(source, (id) => extractors.get(id), {
    ...(previous ? { previous } : {}),
    skipIfDigest: opts.force || opts.deep ? null : source.digestHash,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  opts.signal?.throwIfAborted();
  const { scan } = result;

  const skipped: Record<string, number> = {};
  for (const s of scan.skipped) skipped[s.reason] = (skipped[s.reason] ?? 0) + 1;

  const before = store.state.knowledge;
  if (!result.unchanged) {
    store.dispatch('core/knowledge.apply-scan', {
      sourceId: source.id,
      scope: 'standard',
      entities: result.entities,
      digestHash: scan.digestHash,
      scannedAt: new Date().toISOString(),
    });
  }
  let deep: ScanSummary['deep'];
  if (opts.deep) {
    opts.onNotice?.(
      `Deep scan: Claude Code will read ${scan.files.length} text files from a temporary copy.`,
    );
    const found = await deepScan({
      scan,
      consent: true,
      gameName: store.state.name,
      ...(opts.claudeBin ? { claudeBin: opts.claudeBin } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    opts.signal?.throwIfAborted();
    store.dispatch('core/knowledge.apply-scan', {
      sourceId: source.id,
      scope: 'deep',
      entities: found.entities,
      digestHash: scan.digestHash,
      scannedAt: new Date().toISOString(),
    });
    deep = {
      entities: found.entities.length,
      filesShared: found.filesShared,
      truncated: found.truncated,
    };
  }
  await mkdir(store.paths.cache, { recursive: true });
  await writeFile(manifestPath, JSON.stringify(scan.manifest));

  return {
    sourceId: source.id,
    path: source.path,
    files: scan.files.length,
    skipped,
    extractors: source.extractorIds,
    unchanged: result.unchanged,
    truncated: scan.truncated,
    problems: result.problems,
    ...diffKnowledge(before, store.state.knowledge),
    total: store.state.knowledge.length,
    ...(deep ? { deep } : {}),
  };
}
