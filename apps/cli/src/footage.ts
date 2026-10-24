import {
  analyzeOp,
  footageStatusOp,
  generateCutOp,
  importFootageOp,
  matchAcceptOp,
  matchSuggestOp,
  OpError,
  rankTakesOp,
  type Engine,
} from '@trailerforge/engine';
import { fail, type CmdCtx } from './m2.js';

const secs = (n: number | null) => (n === null ? '?' : `${Math.round(n * 10) / 10} s`);

async function withProject(
  ctx: CmdCtx,
  dir: string,
  run: (engine: Engine, store: Awaited<ReturnType<Engine['openProject']>>) => Promise<number>,
): Promise<number> {
  const store = await ctx.engine.openProject(dir);
  try {
    return await run(ctx.engine, store);
  } catch (err) {
    return fail(ctx, err);
  }
}

/** Wait until none of these jobs is queued or running (a one-shot command saves on exit). */
async function settle(engine: Engine, jobIds: string[], onTick: (done: number) => void) {
  for (;;) {
    const jobs = jobIds.map((id) => engine.jobs.get(id));
    const open = jobs.filter((j) => j && (j.status === 'queued' || j.status === 'running'));
    onTick(jobs.length - open.length);
    if (open.length === 0) return jobs;
    await new Promise((r) => setTimeout(r, 200));
  }
}

function report(ctx: CmdCtx, jobs: ReturnType<Engine['jobs']['get']>[], what: string) {
  const failed = jobs.filter((j) => j?.status === 'failed');
  ctx.io.out(
    `${what}: ${jobs.length - failed.length} done${failed.length ? `, ${failed.length} failed` : ''}`,
  );
  for (const j of failed) ctx.io.err(`  failed: ${j?.error?.message ?? 'unknown error'}`);
  return failed.length ? 1 : 0;
}

/** `tforge ingest <dir> <paths…> [--wait]`: import recordings (files, or folders searched for video). */
export async function ingestCommand(ctx: CmdCtx, dir: string, paths: string[]): Promise<number> {
  return withProject(ctx, dir, async (engine, store) => {
    const r = await importFootageOp(engine, store, { paths });
    ctx.emit(
      [
        `Queued ${r.jobs.length} recording${r.jobs.length === 1 ? '' : 's'} for import`,
        ...r.jobs.map((j) => `  ${j.path}`),
        ...r.skipped.map((s) => `  skipped ${s.path} (${s.reason})`),
        ...(r.truncated ? ['  (stopped at the file limit; import the rest separately)'] : []),
      ].join('\n'),
      r,
    );
    if (r.jobs.length === 0) return 1;
    if (!ctx.flags.wait) {
      ctx.io.err(
        'Imports run in the background and stop when this command exits; add --wait to let them finish.',
      );
      return 0;
    }
    return report(
      ctx,
      await settle(
        engine,
        r.jobs.map((j) => j.jobId),
        () => undefined,
      ),
      'Imported',
    );
  });
}

/** `tforge footage <dir>`: what is in the library and how far along it is. */
export async function footageCommand(ctx: CmdCtx, dir: string): Promise<number> {
  return withProject(ctx, dir, async (engine, store) => {
    const s = await footageStatusOp(engine, store);
    ctx.emit(
      [
        `${s.footage.length} recording${s.footage.length === 1 ? '' : 's'}; jobs: ${s.jobs.running} running, ${s.jobs.queued} queued, ${s.jobs.failed.length} failed`,
        ...s.footage.map(
          (f) =>
            `  ${f.name}  ${secs(f.durationSec)}  ${f.file}${f.analyzed ? '' : ', not analysed'}${f.slotIds.length ? `, take of ${f.slotIds.join(', ')}` : ''}` +
            f.warnings
              .map((w) => `\n      ${w.severity === 'warn' ? '!' : '-'} ${w.message}`)
              .join(''),
        ),
        ...s.jobs.failed.map((j) => `  failed ${j.type}: ${j.error}`),
      ].join('\n'),
      s,
    );
    return 0;
  });
}

/** `tforge analyze <dir> [--wait]`: local analysis of recordings and the music. */
export async function analyzeCommand(ctx: CmdCtx, dir: string): Promise<number> {
  return withProject(ctx, dir, async (engine, store) => {
    const r = await analyzeOp(engine, store);
    ctx.emit(
      [
        `Queued ${r.jobs.length} analysis job${r.jobs.length === 1 ? '' : 's'}`,
        ...r.skipped.map((s) => `  skipped ${s}`),
      ].join('\n'),
      r,
    );
    if (!ctx.flags.wait) return 0;
    return report(
      ctx,
      await settle(
        engine,
        r.jobs.map((j) => j.jobId),
        () => undefined,
      ),
      'Analysed',
    );
  });
}

/** `tforge match <dir> [--accept] [--min certain|high|medium]`: suggestions, or attach the confident ones. */
export async function matchCommand(ctx: CmdCtx, dir: string): Promise<number> {
  return withProject(ctx, dir, async (engine, store) => {
    const min = ctx.flags.min;
    if (min !== undefined && !['certain', 'high', 'medium'].includes(min)) {
      throw new OpError('usage', '--min must be certain, high or medium');
    }
    if (ctx.flags.accept) {
      const r = await matchAcceptOp(engine, store, min ? { minConfidence: min as 'high' } : {});
      ctx.emit(
        [
          `Attached ${r.attached.length} recording${r.attached.length === 1 ? '' : 's'} (one undo step)`,
          ...r.attached.map((a) => `  ${a.assetId} → ${a.slotId} (${a.matchedBy})`),
        ].join('\n'),
        r,
      );
      return 0;
    }
    const r = await matchSuggestOp(engine, store);
    const name = new Map(r.recordings.map((x) => [x.assetId, x.name]));
    ctx.emit(
      r.matches.length === 0
        ? 'Nothing to match.'
        : r.matches
            .map((m) => {
              const top = m.candidates[0];
              return `${name.get(m.assetId) ?? m.assetId}: ${top ? `${top.slotId} (${m.kind}, ${m.confidence}) — ${top.reasons.map((x) => x.detail).join('; ')}` : 'no suggestion'}`;
            })
            .join('\n'),
      r,
    );
    return 0;
  });
}

/** `tforge rank-takes <dir> [--overwrite-chosen]`: ask the model which take to use (text only). */
export async function rankTakesCommand(ctx: CmdCtx, dir: string): Promise<number> {
  return withProject(ctx, dir, async (engine, store) => {
    const r = await rankTakesOp(
      engine,
      store,
      ctx.flags.overwriteChosen ? { overwriteChosen: true } : {},
    );
    ctx.emit(
      [
        `Chose ${r.chosen.length} take${r.chosen.length === 1 ? '' : 's'} (one undo step)`,
        ...r.chosen.map((c) => `  ${c.slotId}: ${c.takeId} — ${c.reason}`),
        ...r.skipped.map((s) => `  skipped ${s.slotId} (${s.reason})`),
      ].join('\n'),
      r,
    );
    return 0;
  });
}

/** `tforge cut <dir> [--lead 1|2]`: build the rough cut on the music. */
export async function cutCommand(ctx: CmdCtx, dir: string): Promise<number> {
  return withProject(ctx, dir, async (engine, store) => {
    const lead = ctx.flags.lead === undefined ? undefined : Number(ctx.flags.lead);
    if (lead !== undefined && ![0, 1, 2].includes(lead))
      throw new OpError('usage', '--lead must be 0, 1 or 2');
    const r = await generateCutOp(engine, store, lead ? { leadFrames: lead } : {});
    ctx.emit(
      [
        `Rough cut: ${r.items} items, ${r.placeholders} placeholder${r.placeholders === 1 ? '' : 's'}${r.keptEdits.length ? `, kept ${r.keptEdits.length} edited clip${r.keptEdits.length === 1 ? '' : 's'}` : ''}`,
        ...(r.unanalysed
          ? [
              `  ${r.unanalysed} recording${r.unanalysed === 1 ? '' : 's'} not analysed yet: run tforge analyze --wait for better in and out points`,
            ]
          : []),
        ...r.warnings.map((w) => `  ! ${w}`),
      ].join('\n'),
      r,
    );
    return 0;
  });
}
