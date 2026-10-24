import {
  captureExportOp,
  captureMarkOp,
  captureStatusOp,
  captureTipsOp,
  captureViewOp,
  OpError,
  setCaptureSettingsOp,
  type Engine,
} from '@trailerforge/engine';
import { fail, type CmdCtx } from './m2.js';

const SETTING_KEYS = ['resolution', 'fps', 'bitrate', 'codec', 'container', 'hud', 'hdr'] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

const fieldOf = (k: SettingKey) => (k === 'bitrate' ? 'bitrateMbps' : k);

/** `fps=30`, `resolution=2560x1440`, `hdr=true` → a recording-settings patch value. */
function parseSetting(pair: string): [string, unknown] {
  const eq = pair.indexOf('=');
  const key = pair.slice(0, eq) as SettingKey;
  const raw = pair.slice(eq + 1);
  if (eq < 1 || !SETTING_KEYS.includes(key)) {
    throw new OpError(
      'usage',
      `--set expects key=value with key one of ${SETTING_KEYS.join(', ')}`,
    );
  }
  if (key === 'resolution') {
    const m = /^(\d+)x(\d+)$/i.exec(raw);
    if (!m) throw new OpError('usage', `resolution must look like 2560x1440, got "${raw}"`);
    return [key, { width: Number(m[1]), height: Number(m[2]) }];
  }
  if (key === 'fps' || key === 'bitrate') {
    const n = Number(raw);
    if (!(n > 0) || !Number.isFinite(n))
      throw new OpError('usage', `${key} must be a number, got "${raw}"`);
    return [key, n];
  }
  if (key === 'hdr') {
    if (raw !== 'true' && raw !== 'false') throw new OpError('usage', 'hdr must be true or false');
    return [key, raw === 'true'];
  }
  return [key, raw];
}

function settingsPatch(ctx: CmdCtx): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const pair of ctx.flags.set) {
    const [k, v] = parseSetting(pair);
    patch[fieldOf(k as SettingKey)] = v;
  }
  for (const k of ctx.flags.unset) {
    if (!SETTING_KEYS.includes(k as SettingKey)) {
      throw new OpError('usage', `--unset expects one of ${SETTING_KEYS.join(', ')}`);
    }
    patch[fieldOf(k as SettingKey)] = null;
  }
  return patch;
}

const minutes = (s: number) => (s < 90 ? `${s} s` : `${Math.round(s / 6) / 10} min`);

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

const SUBCOMMANDS = ['plan', 'status', 'settings', 'mark', 'tips', 'export'];

/**
 * `tforge capture plan|status|settings|mark|tips|export <dir>`. Edits go through the pack's
 * typed commands, so they are undoable in the app; one-shot commands save on exit.
 */
export async function captureCommand(
  ctx: CmdCtx,
  sub: string | undefined,
  dir: string,
  slotId?: string,
): Promise<number> {
  const { flags } = ctx;
  if (!sub || !SUBCOMMANDS.includes(sub)) {
    ctx.io.err(`capture needs one of: ${SUBCOMMANDS.join(', ')}; see tforge --help`);
    return 2;
  }
  return withProject(ctx, dir, async (engine, store) => {
    if (sub === 'plan') {
      const v = captureViewOp(engine, store, { include: flags.todo ? 'todo' : 'all' });
      const lines = [
        `${v.plan.done} of ${v.plan.total} shots recorded, about ${minutes(v.plan.todoRecordSeconds)} still to record`,
      ];
      v.plan.groups.forEach((g, i) => {
        lines.push(
          `${i + 1}. ${[g.location, g.setup, g.entity?.name].filter(Boolean).join(' · ') || 'Anywhere'} (${g.done}/${g.total})`,
        );
        for (const it of g.items) {
          lines.push(
            `   [${it.todo ? ' ' : 'x'}] ${it.slotId}  ${it.title} — record ${it.recordSeconds} s, HUD ${it.hud}${it.status === 'rejected' ? ', rejected' : ''}`,
          );
        }
      });
      if (v.plan.skippedSlotIds.length) lines.push(`Skipped: ${v.plan.skippedSlotIds.join(', ')}`);
      ctx.emit(lines.join('\n'), v);
      return 0;
    }
    if (sub === 'status') {
      const s = captureStatusOp(engine, store);
      ctx.emit(
        [
          `${s.done} of ${s.total} shots recorded, about ${minutes(s.todoRecordSeconds)} still to record`,
          `  empty ${s.byStatus.empty}, recorded ${s.byStatus.recorded}, approved ${s.byStatus.approved}, rejected ${s.byStatus.rejected}, skipped ${s.skipped}`,
          `  tips: ${s.tips.fresh} fresh, ${s.tips.stale} stale, ${s.tips.edited} edited, ${s.tips.none} none`,
          ...s.groups.map((g) => `  ${g.done}/${g.total}  ${g.label}`),
        ].join('\n'),
        s,
      );
      return 0;
    }
    if (sub === 'settings') {
      const patch = settingsPatch(ctx);
      const changing = flags.reset || Object.keys(patch).length > 0;
      const r = setCaptureSettingsOp(engine, store, {
        ...(flags.reset ? { reset: true } : {}),
        ...(Object.keys(patch).length > 0 ? { patch } : {}),
      });
      const s = r.settings;
      const src = (k: keyof typeof r.sources) => (r.sources[k] === 'override' ? ' (override)' : '');
      ctx.emit(
        [
          `${s.resolution.width}x${s.resolution.height}${src('resolution')}, ${s.fps} fps${src('fps')}, ${s.bitrateMbps} Mbps${src('bitrateMbps')}`,
          `${s.codec} in ${s.container}${src('codec')}${src('container')}, HUD ${s.hud}${src('hud')}, HDR ${s.hdr ? 'on' : 'off'}${src('hdr')}`,
          ...r.advice.map((a) => `  ${a.severity === 'warn' ? '!' : '-'} ${a.message}`),
          ...(changing ? ['Saved.'] : []),
        ].join('\n'),
        r,
      );
      return 0;
    }
    if (sub === 'mark') {
      if (!slotId) {
        ctx.io.err('missing <slotId>; see tforge --help');
        return 2;
      }
      if (flags.skip && flags.unskip)
        throw new OpError('usage', 'use --skip or --unskip, not both');
      const r = captureMarkOp(engine, store, {
        slotId,
        status: flags.status as never,
        notes: flags.note,
        takes: flags.takes === undefined ? undefined : Number(flags.takes),
        skipped: flags.skip ? true : flags.unskip ? false : undefined,
      });
      ctx.emit(`${r.slotId}: updated ${r.changed.join(', ')}`, r);
      return 0;
    }
    if (sub === 'tips') {
      const r = await captureTipsOp(engine, store, {
        ...(flags.group.length ? { groupKeys: flags.group } : {}),
        force: flags.force,
        overwriteEdited: flags.overwriteEdited,
      });
      ctx.emit(
        [
          `Tips written for ${r.written.length} group${r.written.length === 1 ? '' : 's'}`,
          ...r.written.map((w) => `  ${w.key}: ${w.tips} tips, ${w.risks} risks`),
          ...r.skipped.map((s) => `  skipped ${s.key} (${s.reason})`),
        ].join('\n'),
        r,
      );
      return 0;
    }
    const formats = flags.format
      ?.split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    const r = await captureExportOp(engine, store, {
      ...(formats?.length ? { formats: formats as ('md' | 'html' | 'json')[] } : {}),
      omitExcluded: flags.omitExcluded,
    });
    ctx.emit(
      [
        `Capture pack (${r.done} of ${r.shots} shots recorded):`,
        ...r.files.map((f) => `  ${f}`),
      ].join('\n'),
      r,
    );
    return 0;
  });
}
