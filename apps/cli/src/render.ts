import { secondsToFlicks } from '@trailerforge/schema';
import {
  OpError,
  approveVersionOp,
  createDemoOp,
  critiqueFactsOp,
  healthOp,
  critiqueOp,
  exportVersionOp,
  handoffOp,
  presetsViewOp,
  qualityOp,
  renderDraftOp,
  reviewViewOp,
  type Engine,
  type HandoffFormat,
  type Progress,
} from '@trailerforge/engine';
import { fail, type CmdCtx } from './m2.js';

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

/** `--version master` (or none) is the master cut; anything else is a version id. */
function versionOf(ctx: CmdCtx): string | null {
  const v = ctx.flags.version;
  return v === undefined || v === 'master' ? null : v;
}

function overridesOf(ctx: CmdCtx): { checkId: string; reason: string }[] {
  return ctx.flags.override.map((o) => {
    const i = o.indexOf('=');
    const id = i < 0 ? o : o.slice(0, i);
    const reason = i < 0 ? '' : o.slice(i + 1);
    if (!reason.trim())
      throw new OpError('usage', `--override ${id}=<reason>: an override needs a reason`);
    return { checkId: id.includes('/') ? id : `core/${id}`, reason };
  });
}

/** Progress lines on stderr, one per whole percent step of 10, so a script's stdout stays clean. */
function progress(ctx: CmdCtx): (p: Progress) => void {
  let last = -1;
  return (p) => {
    const step = Math.floor(p.fraction * 10);
    if (step === last) return;
    last = step;
    ctx.io.err(`  ${p.message ?? p.phase} ${Math.round(p.fraction * 100)}%`);
  };
}

const name = (id: string | null) => id ?? 'master';

/** `tforge presets`: the export presets. */
export async function presetsCommand(ctx: CmdCtx): Promise<number> {
  const p = await presetsViewOp(ctx.engine);
  ctx.emit(
    [
      ...p.presets.map((x) => `${x.id.padEnd(14)} ${x.name} (.${x.extension}): ${x.description}`),
      p.hardwareDraftEncoder
        ? `Review drafts use the ${p.hardwareDraftEncoder} hardware encoder.`
        : 'Review drafts use the software encoder.',
    ].join('\n'),
    p,
  );
  return 0;
}

/** `tforge qc <dir> [--version <id|master>] [--override <check>=<reason>]...`: the Quality Gate on the plan. */
export async function qcCommand(ctx: CmdCtx, dir: string): Promise<number> {
  return withProject(ctx, dir, async (engine, store) => {
    const id = versionOf(ctx);
    const q = await qualityOp(engine, store, id, overridesOf(ctx));
    const v = q.verdict;
    const line = (f: { message: string; at?: { start: number } | undefined }, mark: string) =>
      `  ${mark} ${f.message}${f.at ? ` (at ${f.at.start} s)` : ''}`;
    ctx.emit(
      [
        `${name(id)} as ${q.preset.name}: ${v.allowed ? 'may be exported' : 'blocked'}`,
        ...v.blocking.map((f) => line(f, 'X')),
        ...v.needsOverride.map(
          (f) =>
            line(f, '!') + `  [override: --override ${f.checkId.replace('core/', '')}=<reason>]`,
        ),
        ...v.overridden.map((f) => line(f, '~') + `  (overridden: ${f.reason})`),
        ...v.warnings.map((f) => line(f, '-')),
      ].join('\n'),
      q,
    );
    return v.allowed ? 0 : 1;
  });
}

/**
 * `tforge demo [--dir <folder>]`: build the demo project (generated footage and music, a cut, two
 * versions) and print where it is. Nothing is downloaded or sent anywhere.
 */
export async function demoCommand(ctx: CmdCtx): Promise<number> {
  try {
    const r = await createDemoOp(ctx.engine, ctx.flags.dir ? { dir: ctx.flags.dir } : {});
    ctx.emit(
      `Demo project ready: ${r.dir}\n  ${r.shots} shots, ${r.seconds.toFixed(1)} s cut, versions ${r.versions.join(', ')}. Open it in the app, or try: tforge export "${r.dir}" --version master`, // prettier-ignore
      r,
    );
    return 0;
  } catch (err) {
    return fail(ctx, err);
  }
}

/**
 * `tforge doctor`: is this computer ready? FFmpeg and what it can do, the analysis tools, disk
 * space, AI help and the vision model. Reads only; exits 1 when something that stops the app fails.
 */
export async function doctorCommand(ctx: CmdCtx): Promise<number> {
  try {
    const r = await healthOp(ctx.engine);
    const mark = { ok: 'ok  ', info: 'info', warn: 'warn', fail: 'FAIL' } as const;
    ctx.emit(
      [
        ...r.checks.flatMap((c) => [
          `${mark[c.status]}  ${c.title}: ${c.detail}`,
          ...(c.status !== 'ok' && c.fix ? [`      → ${c.fix}`] : []),
        ]),
        r.ready ? 'Ready.' : 'Not ready: fix the FAIL lines above.',
      ].join('\n'),
      r,
    );
    return r.ready ? 0 : 1;
  } catch (err) {
    return fail(ctx, err);
  }
}

/**
 * `tforge critique <dir> [--version <id|master>] [--show]`: ask the AI for a critique of a version
 * (text only). `--show` prints what would be sent and sends nothing.
 */
export async function critiqueCommand(ctx: CmdCtx, dir: string): Promise<number> {
  return withProject(ctx, dir, async (engine, store) => {
    const id = versionOf(ctx);
    if (ctx.flags.show) {
      const f = await critiqueFactsOp(engine, store, id);
      ctx.emit(
        [
          'A critique would send:',
          ...f.summary.map((l) => `  - ${l}`),
          ...(f.excluded ? [`  (${f.excluded} game fact${f.excluded === 1 ? '' : 's'} left out because you excluded them)`] : []), // prettier-ignore
        ].join('\n'),
        f,
      );
      return 0;
    }
    const r = await critiqueOp(engine, store, id);
    ctx.emit(
      [
        `Critique of ${id ?? 'the master cut'}: ${r.notes.length} note${r.notes.length === 1 ? '' : 's'} on the Review tab (one undo step)`,
        ...r.notes.map(
          (n) =>
            `  ${n.kind === 'issue' ? '!' : '+'} ${n.text}${n.fix ? `  [fix: ${n.fix.summary}]` : ''}`,
        ),
        ...r.skipped.map((s) => `  skipped a note about ${s.about} (${s.reason})`),
        ...r.droppedFixes.map((d) => `  dropped a fix for ${d.about}: ${d.reason}`),
      ].join('\n'),
      r,
    );
    return 0;
  });
}

/** `tforge draft <dir> [--version <id|master>]`: a 720p review draft. */
export async function draftCommand(ctx: CmdCtx, dir: string): Promise<number> {
  return withProject(ctx, dir, async (engine, store) => {
    const r = await renderDraftOp(engine, store, versionOf(ctx), { onProgress: progress(ctx) });
    ctx.emit(
      [
        `Draft of ${name(r.variantId)}: ${r.file}${r.hardware ? ' (hardware encoder)' : ''}`,
        ...r.warnings.map((w) => `  ! ${w}`),
      ].join('\n'),
      r,
    );
    return 0;
  });
}

/**
 * `tforge export <dir> [--version <id|master>] [--preset <id>] [--override <check>=<reason>]...`:
 * render a version with its preset, check the file, deliver it. `--preset` saves the choice for
 * the version first.
 */
export async function exportCommand(ctx: CmdCtx, dir: string): Promise<number> {
  return withProject(ctx, dir, async (engine, store) => {
    const id = versionOf(ctx);
    if (ctx.flags.preset) {
      if (id === null) throw new OpError('usage', '--preset needs a version (--version <id>)');
      store.dispatch('core/export.set', { variantId: id, presetId: ctx.flags.preset });
    }
    try {
      const r = await exportVersionOp(engine, store, id, {
        overrides: overridesOf(ctx),
        onProgress: progress(ctx),
      });
      ctx.emit(
        [
          `Exported ${name(id)} as ${r.preset}: ${r.file}`,
          `  poster ${r.poster}`,
          `  sha256 ${r.sha256}${r.reproducible ? '' : ' (hardware encoder: not reproducible)'}`,
          ...r.overridden.map((c) => `  overridden: ${c}`),
          ...r.findings.filter((f) => f.severity === 'warning').map((f) => `  - ${f.message}`),
        ].join('\n'),
        r,
      );
      return 0;
    } finally {
      await store.save();
    }
  });
}

/** `tforge handoff <dir> [--version <id|master>] [--format fcpxml,otio,edl]`: files for an editor. */
export async function handoffCommand(ctx: CmdCtx, dir: string): Promise<number> {
  return withProject(ctx, dir, async (engine, store) => {
    const formats = ctx.flags.format
      ? (ctx.flags.format.split(',').map((f) => f.trim()) as HandoffFormat[])
      : undefined;
    const bad = formats?.find((f) => !['fcpxml', 'otio', 'edl'].includes(f));
    if (bad) throw new OpError('usage', `--format must be fcpxml, otio or edl, not "${bad}"`);
    const r = await handoffOp(engine, store, versionOf(ctx), {
      ...(formats ? { formats } : {}),
      onProgress: progress(ctx),
    });
    ctx.emit(
      [
        `Handoff of ${name(r.variantId)} in ${r.dir}`,
        ...r.files.map((f) => `  ${f.format}: ${f.file}`),
        `  ${r.graphics.length} card/caption clip${r.graphics.length === 1 ? '' : 's'} with alpha`,
        ...r.warnings.map((w) => `  ! ${w}`),
      ].join('\n'),
      r,
    );
    return 0;
  });
}

/** `tforge review list|comment|resolve|reopen|approve|revoke <dir> ...`. */
export async function reviewCommand(
  ctx: CmdCtx,
  sub: string,
  dir: string,
  arg?: string,
): Promise<number> {
  return withProject(ctx, dir, async (engine, store) => {
    const id = versionOf(ctx);
    try {
      switch (sub) {
        case 'list': {
          const vs = await reviewViewOp(engine, store);
          ctx.emit(
            vs
              .map(
                (v) =>
                  `${name(v.variantId).padEnd(18)} ${v.approval.padEnd(9)} ${v.seconds} s, ${v.openComments}/${v.comments} open comments, ${v.draftReady ? 'draft ready' : 'no draft'}, ${v.export.presetName}` +
                  (v.gate.blocking + v.gate.needsOverride
                    ? `, gate: ${v.gate.blocking} blocking, ${v.gate.needsOverride} need an override`
                    : ''),
              )
              .join('\n'),
            vs,
          );
          for (const c of store.state.review.comments)
            ctx.io.out(
              `  ${c.resolved ? '[x]' : '[ ]'} ${c.id}  ${name(c.variantId)} @ ${Math.round((c.at / 705_600_000) * 100) / 100} s: ${c.text}`,
            );
          return 0;
        }
        case 'comment': {
          if (!ctx.flags.text) throw new OpError('usage', 'give the comment with --text "..."');
          const at = Number(ctx.flags.at ?? 0);
          if (!Number.isFinite(at) || at < 0)
            throw new OpError('usage', '--at is seconds into the version');
          store.dispatch('core/review.comment', {
            variantId: id,
            at: secondsToFlicks(at),
            text: ctx.flags.text,
          });
          const c = store.state.review.comments.at(-1)!;
          ctx.emit(`Comment ${c.id} on ${name(id)} at ${at} s`, c);
          return 0;
        }
        case 'resolve':
        case 'reopen':
          if (!arg) throw new OpError('usage', `review ${sub} <dir> <commentId>`);
          store.dispatch(`core/review.${sub}`, { commentId: arg });
          ctx.emit(`${sub === 'resolve' ? 'Resolved' : 'Reopened'} ${arg}`, { commentId: arg });
          return 0;
        case 'approve': {
          const r = await approveVersionOp(engine, store, {
            variantId: id,
            ...(ctx.flags.note ? { note: ctx.flags.note } : {}),
          });
          ctx.emit(`Approved ${name(id)} (content ${r.contentHash.slice(0, 12)})`, r);
          return 0;
        }
        case 'revoke':
          store.dispatch('core/review.revoke', { variantId: id });
          ctx.emit(`Withdrew the approval of ${name(id)}`, { variantId: id });
          return 0;
        default:
          throw new OpError('usage', `unknown review command "${sub}"; see tforge --help`);
      }
    } finally {
      await store.save();
    }
  });
}
