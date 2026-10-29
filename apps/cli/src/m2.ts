import {
  briefStatus,
  DEEP_SCAN_WARNING,
  generateStoryboardOp,
  OpError,
  scanKnowledgeOp,
  type Engine,
} from '@trailerforge/engine';
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
  /** Capture commands. */
  format?: string | undefined;
  omitExcluded: boolean;
  note?: string | undefined;
  takes?: string | undefined;
  status?: string | undefined;
  skip: boolean;
  unskip: boolean;
  group: string[];
  overwriteEdited: boolean;
  set: string[];
  unset: string[];
  reset: boolean;
  todo: boolean;
  /** Footage commands. */
  wait: boolean;
  accept: boolean;
  min?: string | undefined;
  lead?: string | undefined;
  overwriteChosen: boolean;
  /** Versions and brand commands. */
  target?: string | undefined;
  length?: string | undefined;
  name?: string | undefined;
  reframe?: 'crop' | 'fill' | undefined;
  slot?: string | undefined;
  drop: boolean;
  keep: boolean;
  take?: string | undefined;
  focus?: string | undefined;
  clear: boolean;
  role?: 'heading' | 'body' | undefined;
  family?: string | undefined;
  bold: boolean;
  /** Render and review commands. */
  version?: string | undefined;
  preset?: string | undefined;
  override: string[];
  at?: string | undefined;
  text?: string | undefined;
  /** `demo --dir`: where the demo project goes. */
  dir?: string | undefined;
  /** `critique --show`: print what would be sent. */
  show: boolean;
}

export interface CmdCtx {
  engine: Engine;
  io: Io;
  flags: Flags;
  emit(human: string, data: unknown): void;
  claudeBin?: string | undefined;
}

/** Print an operation's problem; `usage` mistakes exit 2, everything else 1. */
export function fail(ctx: CmdCtx, err: unknown, hint?: string): number {
  if (!(err instanceof OpError)) throw err;
  ctx.io.err(err.message);
  if (err.code === 'brief-incomplete') {
    for (const m of err.details as { label: string; field: string }[]) {
      ctx.io.err(`  * ${m.label} (${m.field})`);
    }
  }
  if (hint) ctx.io.err(hint);
  return err.code === 'usage' ? 2 : 1;
}

/** `tforge brief check <dir>`: exit 0 when every required field has a real value, else 1. */
export async function briefCheck(ctx: CmdCtx, dir: string): Promise<number> {
  const store = await ctx.engine.openProject(dir);
  try {
    const s = briefStatus(ctx.engine, store);
    const required = s.missing.filter((m) => m.required);
    const lines = [
      `${s.videoTypeName}: brief ${Math.round(s.score * 100)}% complete` +
        (s.complete
          ? ''
          : `, ${required.length} required field${required.length === 1 ? '' : 's'} missing`),
    ];
    for (const m of s.missing) {
      const why = m.reason === 'too-few' ? `needs more entries (have ${m.have ?? 0})` : m.reason;
      lines.push(`  ${m.required ? '*' : '-'} ${m.label} (${m.field}): ${why}`);
    }
    if (s.assumed.length) {
      lines.push('Assumed:');
      for (const a of s.assumed) lines.push(`  ~ ${a.label}: ${a.reason}`);
    }
    if (s.missing.length) lines.push('(* required, - optional)');
    ctx.emit(lines.join('\n'), s);
    return s.complete ? 0 : 1;
  } catch (err) {
    return fail(ctx, err);
  }
}

/** `tforge storyboard generate <dir> [--duration s] [--template id] [--assume]` */
export async function storyboardGenerate(ctx: CmdCtx, dir: string): Promise<number> {
  const { flags } = ctx;
  const duration = flags.duration === undefined ? undefined : Number(flags.duration);
  if (flags.duration !== undefined && !(duration! > 0 && Number.isFinite(duration))) {
    ctx.io.err(`--duration must be a positive number of seconds, got "${flags.duration}"`);
    return 2;
  }
  const store = await ctx.engine.openProject(dir);
  try {
    const r = await generateStoryboardOp(ctx.engine, store, {
      duration,
      template: flags.template,
      assume: flags.assume,
    });
    ctx.emit(
      [
        `Storyboard written with ${r.provider}: ${r.sections.length} sections, ${r.slots} slots, ${r.seconds} s`,
        ...r.sections.map((s) => `  ${s.locked ? '🔒 ' : ''}${s.name}: ${s.slots.join(' / ')}`),
        r.rationale,
      ].join('\n'),
      {
        provider: r.provider,
        sections: r.sections.length,
        slots: r.slots,
        seconds: r.seconds,
        rationale: r.rationale,
      },
    );
    return 0;
  } catch (err) {
    return fail(
      ctx,
      err,
      err instanceof OpError && err.code === 'brief-incomplete'
        ? 'Re-run with --assume to proceed with logged assumptions.'
        : undefined,
    );
  }
}

/** `tforge knowledge scan <dir> [--repo path] [--force] [--deep --allow-deep-scan]` */
export async function knowledgeScan(ctx: CmdCtx, dir: string): Promise<number> {
  const { flags } = ctx;
  if (flags.deep && !flags.allowDeepScan) {
    ctx.io.err(`${DEEP_SCAN_WARNING}\nRe-run with --deep --allow-deep-scan to confirm.`);
    return 2;
  }
  const store = await ctx.engine.openProject(dir);
  try {
    const r = await scanKnowledgeOp(ctx.engine, store, {
      repo: flags.repo,
      force: flags.force,
      deep: flags.deep,
      allowDeep: flags.allowDeepScan,
      claudeBin: ctx.claudeBin,
      onNotice: (m) => ctx.io.err(m),
    });
    const skippedText = Object.entries(r.skipped)
      .map(([reason, n]) => `${n} ${reason}`)
      .join(', ');
    const lines = [
      `Scanned ${r.path}: ${r.files} files${skippedText ? ` (skipped ${skippedText})` : ''}`,
    ];
    if (r.truncated)
      lines.push('  (stopped at the file limit; narrow the scan with include/exclude)');
    if (r.unchanged) lines.push('Nothing changed since the last scan.');
    if (!r.unchanged || r.deep) {
      lines.push(
        `Knowledge: +${r.added} added, ${r.updated} updated, ${r.removed} removed (${r.total} total)`,
      );
    }
    for (const p of r.problems) lines.push(`  ! ${p.extractorId}: ${p.message}`);
    ctx.emit(lines.join('\n'), r);
    return r.problems.length ? 1 : 0;
  } catch (err) {
    return fail(ctx, err);
  }
}
