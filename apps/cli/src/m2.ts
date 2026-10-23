import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { assumptionsFor, checkCompleteness } from '@trailerforge/brief';
import { appendDecisions, type ProjectStore } from '@trailerforge/core';
import type { Engine } from '@trailerforge/engine';
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
import { generateStoryboard } from '@trailerforge/storyboard';
import type { Io } from './main.js';

export interface Flags {
  json: boolean;
  repo?: string | undefined;
  duration?: string | undefined;
  template?: string | undefined;
  assume: boolean;
  deep: boolean;
  allowDeepScan: boolean;
  force: boolean;
}

export interface CmdCtx {
  engine: Engine;
  io: Io;
  flags: Flags;
  emit(human: string, data: unknown): void;
  claudeBin?: string | undefined;
}

function videoTypeOf(ctx: CmdCtx, store: ProjectStore): ResolvedVideoType | null {
  const id = store.state.brief.videoTypeId;
  if (!id) {
    ctx.io.err('this project has no video type; create it with `tforge new --type <videoTypeId>`');
    return null;
  }
  return ctx.engine.plugins.registries.videoTypes.require(id);
}

function describeMissing(report: ReturnType<typeof checkCompleteness>) {
  return report.missing.map((m) => ({
    field: m.requirement.field,
    label: m.requirement.label,
    required: m.requirement.required,
    reason: m.reason,
    ...(m.have !== undefined ? { have: m.have } : {}),
  }));
}

/** `tforge brief check <dir>`: exit 0 when every required field has a real value, else 1. */
export async function briefCheck(ctx: CmdCtx, dir: string): Promise<number> {
  const store = await ctx.engine.openProject(dir);
  const vt = videoTypeOf(ctx, store);
  if (!vt) return 1;
  const report = checkCompleteness(store.state, vt);
  const missing = describeMissing(report);
  const required = missing.filter((m) => m.required);
  const data = {
    videoTypeId: report.videoTypeId,
    score: Math.round(report.score * 100) / 100,
    complete: report.complete,
    canProceed: report.canProceed,
    missing,
    assumed: report.assumed.map((a) => ({
      field: a.requirement.field,
      label: a.requirement.label,
      assumption: a.assumption.value,
      reason: a.assumption.reason,
    })),
  };
  const lines = [
    `${vt.name}: brief ${Math.round(report.score * 100)}% complete` +
      (report.complete
        ? ''
        : `, ${required.length} required field${required.length === 1 ? '' : 's'} missing`),
  ];
  for (const m of missing) {
    const why = m.reason === 'too-few' ? `needs more entries (have ${m.have ?? 0})` : m.reason;
    lines.push(`  ${m.required ? '*' : '-'} ${m.label} (${m.field}): ${why}`);
  }
  if (data.assumed.length) {
    lines.push('Assumed:');
    for (const a of data.assumed) lines.push(`  ~ ${a.label}: ${a.reason}`);
  }
  if (missing.length) lines.push('(* required, - optional)');
  ctx.emit(lines.join('\n'), data);
  return report.complete ? 0 : 1;
}

/** `tforge storyboard generate <dir> [--duration s] [--template id] [--assume]` */
export async function storyboardGenerate(ctx: CmdCtx, dir: string): Promise<number> {
  const { engine, io, flags } = ctx;
  const store = await engine.openProject(dir);
  const vt = videoTypeOf(ctx, store);
  if (!vt) return 1;

  const duration =
    flags.duration === undefined
      ? Math.min(Math.max(60, vt.typicalDuration?.min ?? 0), vt.typicalDuration?.max ?? 60)
      : Number(flags.duration);
  if (!(duration > 0) || !Number.isFinite(duration)) {
    io.err(`--duration must be a positive number of seconds, got "${flags.duration}"`);
    return 2;
  }
  const templateId = flags.template ?? vt.defaultTemplateId;
  if (!templateId) {
    io.err(`${vt.name} has no default template; pass --template <id>`);
    return 1;
  }
  const template = engine.plugins.registries.templates.require(templateId);

  const report = checkCompleteness(store.state, vt);
  if (!report.canProceed) {
    if (!flags.assume) {
      io.err('The brief is missing required details:');
      for (const m of describeMissing(report).filter((x) => x.required))
        io.err(`  * ${m.label} (${m.field})`);
      io.err('Fill them in, or re-run with --assume to proceed with logged assumptions.');
      return 1;
    }
    for (const a of assumptionsFor(report, new Map(), new Date())) {
      store.dispatch('core/brief.add-assumption', a);
    }
  }

  const { storyboard, decisions } = await generateStoryboard({ llm: engine.llm }, store.state, {
    template,
    targetDuration: duration,
  });
  store.dispatch('core/storyboard.set', storyboard);
  await appendDecisions(store.paths.decisions, decisions);

  const slots = storyboard.sections.reduce((n, s) => n + s.slots.length, 0);
  const seconds =
    Math.round(
      storyboard.sections.reduce(
        (n, s) => n + s.slots.reduce((m, x) => m + x.duration.ideal, 0),
        0,
      ) * 10,
    ) / 10;
  const provider = String(decisions[0]?.reasons.provider ?? '?');
  ctx.emit(
    [
      `Storyboard written with ${provider}: ${storyboard.sections.length} sections, ${slots} slots, ${seconds} s`,
      ...storyboard.sections.map(
        (s) => `  ${s.locked ? '🔒 ' : ''}${s.name}: ${s.slots.map((x) => x.title).join(' / ')}`,
      ),
      decisions[0]?.summary ?? '',
    ].join('\n'),
    {
      provider,
      sections: storyboard.sections.length,
      slots,
      seconds,
      rationale: decisions[0]?.summary,
    },
  );
  return 0;
}

const DEEP_WARNING =
  'Deep scan sends the contents of your project files (text only, no secrets, no ignored files) ' +
  'to Anthropic through Claude Code. Re-run with --deep --allow-deep-scan to confirm.';

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

/** `tforge knowledge scan <dir> [--repo path] [--force] [--deep --allow-deep-scan]` */
export async function knowledgeScan(ctx: CmdCtx, dir: string): Promise<number> {
  const { engine, io, flags } = ctx;
  if (flags.deep && !flags.allowDeepScan) {
    io.err(DEEP_WARNING);
    return 2;
  }
  const store = await engine.openProject(dir);
  const extractors = engine.plugins.registries.knowledgeExtractors;
  const repo = flags.repo ? resolve(flags.repo) : undefined;

  let source: KnowledgeSource | undefined = store.state.sources.find((s) =>
    repo ? s.path === repo : true,
  );
  if (!repo && store.state.sources.length > 1) {
    io.err('this project has several sources; pass --repo <path> to pick one');
    return 2;
  }
  if (!source) {
    if (!repo) {
      io.err('this project has no source yet; pass --repo <path to your game repo>');
      return 2;
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
  const previous = flags.force ? undefined : await readManifest(manifestPath);
  const result = await scanSource(source, (id) => extractors.get(id), {
    ...(previous ? { previous } : {}),
    skipIfDigest: flags.force || flags.deep ? null : source.digestHash,
  });
  const { scan } = result;

  const skipped = new Map<string, number>();
  for (const s of scan.skipped) skipped.set(s.reason, (skipped.get(s.reason) ?? 0) + 1);
  const skippedText = [...skipped].map(([r, n]) => `${n} ${r}`).join(', ');
  const summary: Record<string, unknown> = {
    sourceId: source.id,
    path: source.path,
    files: scan.files.length,
    skipped: Object.fromEntries(skipped),
    extractors: source.extractorIds,
    unchanged: result.unchanged,
    problems: result.problems,
  };
  const lines = [
    `Scanned ${source.path}: ${scan.files.length} files${skippedText ? ` (skipped ${skippedText})` : ''}`,
  ];
  if (scan.truncated)
    lines.push('  (stopped at the file limit; narrow the scan with include/exclude)');

  const before = store.state.knowledge;
  if (result.unchanged) {
    lines.push('Nothing changed since the last scan.');
  } else {
    store.dispatch('core/knowledge.apply-scan', {
      sourceId: source.id,
      scope: 'standard',
      entities: result.entities,
      digestHash: scan.digestHash,
      scannedAt: new Date().toISOString(),
    });
  }
  if (flags.deep) {
    io.err(
      `Deep scan: Claude Code will read ${scan.files.length} text files from a temporary copy.`,
    );
    const deep = await deepScan({
      scan,
      consent: true,
      gameName: store.state.name,
      ...(ctx.claudeBin ? { claudeBin: ctx.claudeBin } : {}),
    });
    store.dispatch('core/knowledge.apply-scan', {
      sourceId: source.id,
      scope: 'deep',
      entities: deep.entities,
      digestHash: scan.digestHash,
      scannedAt: new Date().toISOString(),
    });
    summary.deep = {
      entities: deep.entities.length,
      filesShared: deep.filesShared,
      truncated: deep.truncated,
    };
  }
  await mkdir(store.paths.cache, { recursive: true });
  await writeFile(manifestPath, JSON.stringify(scan.manifest));

  const d = diffKnowledge(before, store.state.knowledge);
  Object.assign(summary, d, { total: store.state.knowledge.length });
  if (!result.unchanged || flags.deep) {
    lines.push(
      `Knowledge: +${d.added} added, ${d.updated} updated, ${d.removed} removed (${store.state.knowledge.length} total)`,
    );
  }
  for (const p of result.problems) lines.push(`  ! ${p.extractorId}: ${p.message}`);
  ctx.emit(lines.join('\n'), summary);
  return result.problems.length ? 1 : 0;
}
