import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  answerCommands,
  answerSchema,
  assumptionsFor,
  buildQuestionnaire,
  checkCompleteness,
  getAt,
  suggestAnswer,
  type CompletenessReport,
  type Question,
} from '@trailerforge/brief';
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
import { createClaudeCodeProvider } from '@trailerforge/llm';
import { buildCaptureHints, tipsInputs } from '@trailerforge/pack-game-trailer';
import {
  TakesWouldBeLostError,
  generateStoryboard,
  regenerateSection,
} from '@trailerforge/storyboard';
import type { Engine } from './engine.js';

/**
 * Operations that combine several subsystems (brief + plugins, scanner + extractors + merge,
 * LLM + storyboard commands). The CLI, the MCP server and the local service all call these, so
 * there is one implementation of each. They return plain data; callers decide how to show it.
 */

/** A problem the caller can explain to the user. `usage` means the request itself was wrong. */
export class OpError extends Error {
  constructor(
    readonly code:
      | 'usage'
      | 'no-video-type'
      | 'brief-incomplete'
      | 'not-found'
      | 'takes-attached'
      | 'gate-blocked'
      | 'missing-tool'
      | 'failed',
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

// ------------------------------------------------------------------ brief form

export interface BriefField {
  /** The requirement's path; answers are addressed by it. */
  id: string;
  label: string;
  required: boolean;
  input: 'text' | 'long-text' | 'list' | 'date' | 'choice' | 'multi-choice';
  choices?: string[];
  minItems?: number;
  help?: string;
  state: 'answered' | 'missing' | 'assumed';
  /** Why it is being asked (or empty once answered). */
  why: string;
  /** Current value: text, a list of strings, or null when there is none. */
  value: string | string[] | null;
  assumption?: { value: unknown; reason: string; source: string };
}

export interface BriefForm {
  videoTypeId: string;
  videoTypeName: string;
  /** 0..1, two decimals. */
  score: number;
  /** Every required field has a real value. */
  complete: boolean;
  /** Every required field has a real value or a logged assumption. */
  canProceed: boolean;
  /** In the video type's own order. */
  fields: BriefField[];
  /** Output formats already added (the "formats" answer is additive; these can be removed). */
  formats: { id: string; name: string }[];
}

/** One Question per requirement, answered or not, so any field can be edited. */
function allQuestions(report: CompletenessReport, vt: ResolvedVideoType): Map<string, Question> {
  const everything: CompletenessReport = {
    ...report,
    satisfied: [],
    assumed: [],
    missing: vt.requirements.map((requirement) => ({ requirement, reason: 'missing' as const })),
  };
  return new Map(buildQuestionnaire(everything).map((q) => [q.id, q]));
}

const asText = (v: unknown): string | string[] | null => {
  if (typeof v === 'string') return v.trim() ? v : null;
  if (Array.isArray(v)) {
    const items = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    return items.length ? items : null;
  }
  return null;
};

/** Everything the brief screen shows: each requirement with its state, current value and prompt. */
export function briefForm(engine: Engine, store: ProjectStore): BriefForm {
  const vt = videoTypeOf(engine, store);
  const project = store.state;
  const report = checkCompleteness(project, vt);
  const questions = allQuestions(report, vt);
  const pending = new Map(
    buildQuestionnaire(report, { includeAssumed: true }).map((q) => [q.id, q]),
  );
  const satisfied = new Set(report.satisfied.map((r) => r.field));
  const assumed = new Set(report.assumed.map((a) => a.requirement.field));

  const fields = vt.requirements.map((r): BriefField => {
    const q = questions.get(r.field)!;
    const state: BriefField['state'] = satisfied.has(r.field)
      ? 'answered'
      : assumed.has(r.field)
        ? 'assumed'
        : 'missing';
    const value =
      r.field === 'formatTargets'
        ? asText(project.formatTargets.map((f) => f.name))
        : asText(
            [r.field, ...r.anyOf].map((p) => getAt(project, p)).find((v) => asText(v) !== null),
          );
    const a = pending.get(r.field)?.assumption;
    return {
      id: r.field,
      label: r.label,
      required: r.required,
      input: r.input,
      ...(q.choices ? { choices: q.choices } : {}),
      ...(q.minItems ? { minItems: q.minItems } : {}),
      ...(q.help ? { help: q.help } : {}),
      state,
      why: state === 'answered' ? '' : (pending.get(r.field)?.why ?? q.why),
      value,
      ...(a ? { assumption: { value: a.value, reason: a.reason, source: a.source } } : {}),
    };
  });
  return {
    videoTypeId: vt.id,
    videoTypeName: vt.name,
    score: Math.round(report.score * 100) / 100,
    complete: report.complete,
    canProceed: report.canProceed,
    fields,
    formats: project.formatTargets.map((f) => ({ id: f.id, name: f.name })),
  };
}

function questionOf(engine: Engine, store: ProjectStore, questionId: string): Question {
  const vt = videoTypeOf(engine, store);
  const q = allQuestions(checkCompleteness(store.state, vt), vt).get(questionId);
  if (!q) throw new OpError('not-found', `${vt.name} has no brief field "${questionId}"`);
  return q;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Save one answer. The value is checked against the question's shape first; format answers add
 * the chosen presets that are not already there. A date question also accepts a looser answer
 * ("Q2 2027", "summer"): that goes to the requirement's alternative field (the release window),
 * since the exact-date field only holds real dates.
 */
export function answerBriefOp(
  engine: Engine,
  store: ProjectStore,
  opts: { questionId: string; value: unknown },
): { commands: number } {
  let q = questionOf(engine, store, opts.questionId);
  const vt = videoTypeOf(engine, store);
  const requirement = vt.requirements.find((r) => r.field === q.id)!;
  if (q.input === 'date' && typeof opts.value === 'string' && !ISO_DATE.test(opts.value.trim())) {
    const alternative = requirement.anyOf[0];
    if (!alternative) {
      throw new OpError('usage', `"${q.label}": use a date like 2027-02-14`);
    }
    q = { ...q, id: alternative, input: 'text' };
  }
  const parsed = answerSchema(q).safeParse(
    typeof opts.value === 'string' ? opts.value.trim() : opts.value,
  );
  if (!parsed.success) {
    throw new OpError(
      'usage',
      `"${q.label}": ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  const have = new Set(store.state.formatTargets.map((f) => f.id));
  const commands = answerCommands(q, parsed.data).filter(
    (c) =>
      !(c.type === 'core/project.add-format-target' && have.has((c.payload as { id: string }).id)),
  );
  for (const c of commands) store.dispatch(c.type, c.payload);
  return { commands: commands.length };
}

export interface BriefSuggestion {
  questionId: string;
  value: unknown;
  reason: string;
  provider: string;
}

/** "Suggest for me": an LLM proposal for one field, grounded in the brief and the game facts. */
export async function suggestBriefAnswerOp(
  engine: Engine,
  store: ProjectStore,
  opts: { questionId: string; signal?: AbortSignal | undefined },
): Promise<BriefSuggestion> {
  const q = questionOf(engine, store, opts.questionId);
  const r = await suggestAnswer(engine.llmFor(store), store.state, q, opts.signal);
  return { questionId: q.id, value: r.value, reason: r.reason, provider: r.provider };
}

/** "Proceed with assumptions": log one visible assumption per missing required field. */
export function assumeMissingOp(engine: Engine, store: ProjectStore): { added: number } {
  const vt = videoTypeOf(engine, store);
  const report = checkCompleteness(store.state, vt);
  let added = 0;
  for (const a of assumptionsFor(report, new Map(), new Date())) {
    store.dispatch('core/brief.add-assumption', a);
    added++;
  }
  return { added };
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
  /** Replace unlocked shots even though recordings are attached (error `takes-attached` otherwise). */
  discardTakes?: boolean | undefined;
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
    assumptionsAdded = assumeMissingOp(engine, store).added;
  }

  let generated;
  try {
    generated = await generateStoryboard(
      { llm: engine.llmFor(store), filters: engine.filters() },
      store.state,
      {
        template,
        targetDuration: duration,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.discardTakes ? { discardTakes: true } : {}),
      },
    );
  } catch (err) {
    if (err instanceof TakesWouldBeLostError) {
      throw new OpError('takes-attached', err.message, { shots: err.shots });
    }
    throw err;
  }
  const { storyboard, decisions } = generated;
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
  const { payload, decisions } = await regenerateSection(
    { llm: engine.llmFor(store), filters: engine.filters() },
    store.state,
    {
      sectionId: opts.sectionId,
      ...(opts.instruction ? { instruction: opts.instruction } : {}),
      ...(opts.keepEdited !== undefined ? { keepEdited: opts.keepEdited } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
  );
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

// ------------------------------------------------------------------ LLM disclosure

export interface LlmPreview {
  task: string;
  available: boolean;
  /** Why no provider can run this task, when `available` is false. */
  reason?: string;
  provider?: { id: string; name: string; kind: string; sendsDataOffDevice: boolean };
  model?: string;
  effort?: string;
  /** The routed provider was unavailable and a fallback will be used instead. */
  fellBack?: boolean;
  /** What the request will contain, so the user can see it before agreeing. */
  willSend: {
    /** Brief fields that have a value (plugin fields as `pack.field`). */
    brief: string[];
    assumptions: number;
    /** Game facts an AI may see: names, kinds and short descriptions only. */
    knowledge: { id: string; kind: string; name: string }[];
    knowledgeExcluded: number;
    /** `capture.tips` only: how many capture groups and shots the request describes. */
    capture?: { groups: number; shots: number };
  };
}

/** Same cap the prompts apply, so the preview matches what is actually sent. */
const PROMPT_KNOWLEDGE_CAP = 120;

const filled = (v: unknown): boolean =>
  v !== null &&
  v !== undefined &&
  v !== '' &&
  !(Array.isArray(v) && v.length === 0) &&
  !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** Provider, model and contents of the request a task would make, without making it. */
export async function llmPreviewOp(
  engine: Engine,
  store: ProjectStore,
  task: string,
): Promise<LlmPreview> {
  const { assumptions, extensions, ...rest } = store.state.brief;
  const brief = [
    ...Object.entries(rest)
      .filter(([k, v]) => k !== 'videoTypeId' && filled(v))
      .map(([k]) => k),
    ...Object.entries(extensions ?? {}).flatMap(([pack, slice]) =>
      slice && typeof slice === 'object'
        ? Object.entries(slice as Record<string, unknown>)
            .filter(([, v]) => filled(v))
            .map(([k]) => `${pack}.${k}`)
        : [],
    ),
  ];
  const shared = store.state.knowledge.filter((e) => !e.excludedFromLlm);
  const willSend: LlmPreview['willSend'] = {
    brief,
    assumptions: assumptions.length,
    knowledge: shared
      .slice(0, PROMPT_KNOWLEDGE_CAP)
      .map((e) => ({ id: e.id, kind: e.kind, name: e.name })),
    knowledgeExcluded: store.state.knowledge.length - shared.length,
  };
  if (task === 'capture.tips') {
    // The tips prompt carries the capture groups and their hints, not the brief.
    const inputs = tipsInputs(store.state);
    const seen = new Map<string, { id: string; kind: string; name: string }>();
    for (const h of buildCaptureHints(inputs.plan, store.state.knowledge, { forLlm: true })) {
      for (const x of [...h.levels, ...h.featured, ...h.debugCommands, ...h.saveFiles]) {
        seen.set(x.entityId, { id: x.entityId, kind: x.kind, name: x.name });
      }
    }
    willSend.brief = [];
    willSend.assumptions = 0;
    willSend.knowledge = [...seen.values()];
    willSend.capture = { groups: inputs.groups.length, shots: inputs.plan.total };
  }
  const route = await engine.llm.describeRoute(task);
  if (!route.ok) return { task, available: false, reason: route.reason, willSend };
  const p = route.provider;
  return {
    task,
    available: true,
    provider: { id: p.id, name: p.name, kind: p.kind, sendsDataOffDevice: p.sendsDataOffDevice },
    ...(route.model ? { model: route.model } : {}),
    ...(route.effort ? { effort: route.effort } : {}),
    fellBack: route.fellBack,
    willSend,
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
    // Claude Code reaches the network itself: the hand-off is logged by Egress, under a purpose.
    const found = await engine.egress.scope({ purpose: 'Deep repo scan (Claude Code)' }, () =>
      deepScan({
        scan,
        consent: true,
        gameName: store.state.name,
        ...(opts.claudeBin ? { claudeBin: opts.claudeBin } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        makeProvider: (sandbox) =>
          createClaudeCodeProvider({
            ...(opts.claudeBin ? { bin: opts.claudeBin } : {}),
            tools: ['Read', 'Grep', 'Glob'],
            cwd: sandbox,
            handOff: (text) =>
              engine.egress.handOff({ provider: 'core/claude-code', tool: 'claude-code', text }),
          }),
      }),
    );
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
