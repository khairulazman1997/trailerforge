import {
  brandImportOp,
  brandViewOp,
  createDefaultVariantsOp,
  effectsViewOp,
  OpError,
  setSfxFolderOp,
  sfxViewOp,
  templatesViewOp,
  variantsViewOp,
  type Engine,
} from '@trailerforge/engine';
import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import { fail, type CmdCtx } from './m2.js';

const secs = (flicks: number) => `${Math.round((flicks / FLICKS_PER_SECOND) * 10) / 10} s`;

async function withProject(
  ctx: CmdCtx,
  dir: string,
  run: (store: Awaited<ReturnType<Engine['openProject']>>) => Promise<number>,
): Promise<number> {
  const store = await ctx.engine.openProject(dir);
  try {
    return await run(store);
  } catch (err) {
    return fail(ctx, err);
  }
}

const usage = (message: string) => {
  throw new OpError('usage', message);
};

/** `tforge variants list|add|defaults|set|override|remove <dir> …` */
export async function variantsCommand(
  ctx: CmdCtx,
  sub: string,
  dir: string,
  id?: string,
): Promise<number> {
  const f = ctx.flags;
  const length = (v: string | undefined) => {
    if (v === undefined) return undefined;
    if (v === 'none') return null;
    const n = Number(v);
    return n > 0 && Number.isFinite(n)
      ? n
      : usage(`--length must be seconds or "none", got "${v}"`);
  };
  return withProject(ctx, dir, async (store) => {
    switch (sub) {
      case 'list':
      case '': {
        const v = await variantsViewOp(ctx.engine, store);
        const lines = v.variants.map((x) => {
          const d = x.derived;
          const dropped =
            d?.slots.filter((s) => s.fate === 'dropped' && s.reason !== 'not in the master cut') ??
            [];
          return [
            `${x.id}: ${x.name || x.format?.name || x.formatTargetId}${x.targetDuration ? ` (${x.targetDuration} s)` : ''}`,
            d
              ? `  ${secs(d.duration)} of ${secs(d.target)}${d.shortfall ? `; ${d.shortfall}` : ''}${dropped.length ? `; dropped ${dropped.map((s) => s.slotId).join(', ')}` : ''}`
              : `  ${x.error ?? 'no rough cut to derive from yet'}`,
            ...(d?.warnings ?? []).map((w) => `  ! ${w}`),
          ].join('\n');
        });
        ctx.emit(
          [
            ...(lines.length ? lines : ['No versions yet.']),
            ...(v.missing.length
              ? [
                  `Formats without a version: ${v.missing.map((m) => m.formatTargetId).join(', ')} (tforge variants defaults <dir>)`,
                ]
              : []),
          ].join('\n'),
          v,
        );
        return 0;
      }
      case 'defaults': {
        const r = createDefaultVariantsOp(store);
        ctx.emit(
          r.added.length ? `Added ${r.added.join(', ')}` : 'Every format already has a version.',
          r,
        );
        return 0;
      }
      case 'add': {
        if (!f.target) return usage('--target <formatTargetId> is required');
        const len = length(f.length);
        store.dispatch('core/variants.add', {
          formatTargetId: f.target,
          ...(f.name ? { name: f.name } : {}),
          ...(typeof len === 'number' ? { targetDuration: len } : {}),
          ...(f.reframe ? { reframe: { mode: f.reframe } } : {}),
        });
        ctx.emit(
          `Added ${store.state.storyboard!.variants.at(-1)!.id}`,
          store.state.storyboard!.variants.at(-1),
        );
        return 0;
      }
      case 'set': {
        if (!id) return usage('give the version id');
        const len = length(f.length);
        store.dispatch('core/variants.set', {
          variantId: id,
          patch: {
            ...(f.name !== undefined ? { name: f.name } : {}),
            ...(f.target ? { formatTargetId: f.target } : {}),
            ...(len !== undefined ? { targetDuration: len } : {}),
            ...(f.reframe ? { reframe: { mode: f.reframe } } : {}),
          },
        });
        ctx.emit(
          `Updated ${id}`,
          store.state.storyboard!.variants.find((v) => v.id === id),
        );
        return 0;
      }
      case 'override': {
        if (!id) return usage('give the version id');
        if (f.clear) {
          store.dispatch('core/variants.clear-override', {
            variantId: id,
            ...(f.slot ? { slotId: f.slot } : {}),
          });
          ctx.emit(f.slot ? `Reset ${f.slot} in ${id}` : `Reset ${id} to automatic`, {});
          return 0;
        }
        if (!f.slot) return usage('--slot <slotId> is required');
        const focus = f.focus?.split(',').map(Number);
        if (f.focus && (focus!.length !== 2 || focus!.some((n) => !(n >= 0 && n <= 1))))
          return usage('--focus must be x,y between 0 and 1, for example 0.6,0.5');
        const len = length(f.length);
        store.dispatch('core/variants.override', {
          variantId: id,
          slotId: f.slot,
          patch: {
            ...(f.drop ? { excluded: true } : f.keep ? { excluded: false } : {}),
            ...(f.take ? { takeId: f.take } : {}),
            ...(focus ? { cropCenter: { x: focus[0]!, y: focus[1]! } } : {}),
            ...(typeof len === 'number'
              ? { duration: { min: len * 0.7, ideal: len, max: len * 1.4 } }
              : {}),
          },
        });
        ctx.emit(
          `Updated ${f.slot} in ${id}`,
          store.state.storyboard!.variants.find((v) => v.id === id)?.overrides[f.slot],
        );
        return 0;
      }
      case 'remove': {
        if (!id) return usage('give the version id');
        store.dispatch('core/variants.remove', { variantId: id });
        ctx.emit(`Removed ${id}`, {});
        return 0;
      }
      default:
        return usage(
          `unknown variants command "${sub}"; use list, defaults, add, set, override or remove`,
        );
    }
  });
}

const COLORS = ['background', 'text', 'primary', 'accent'];
const SCALES = ['title', 'heading', 'body', 'caption'];

/** `tforge brand show|set|logo|font|reset <dir> …` */
export async function brandCommand(
  ctx: CmdCtx,
  sub: string,
  dir: string,
  file?: string,
): Promise<number> {
  const f = ctx.flags;
  return withProject(ctx, dir, async (store) => {
    switch (sub) {
      case 'show':
      case '': {
        const v = await brandViewOp(store);
        const b = v.brand;
        ctx.emit(
          [
            b
              ? `Colours: ${Object.entries(b.colors)
                  .map(([k, c]) => `${k} ${c}`)
                  .join(', ')}`
              : 'No brand kit yet (defaults are used). Set one with tforge brand set.',
            `Logo: ${b?.logo ? b.logo.name : 'none'}`,
            `Fonts: heading ${v.fonts.heading}, body ${v.fonts.body}`,
            ...(b
              ? [
                  `Text sizes: ${Object.entries(b.typeScale)
                    .map(([k, n]) => `${k} ${n}`)
                    .join(', ')} (share of the shorter side)`,
                ]
              : []),
            ...v.warnings.map((w) => `! ${w}`),
          ].join('\n'),
          v,
        );
        return v.warnings.length ? 1 : 0;
      }
      case 'set': {
        const colors: Record<string, string> = {};
        const scale: Record<string, number> = {};
        for (const pair of f.set) {
          const eq = pair.indexOf('=');
          const key = pair.slice(0, eq);
          const val = pair.slice(eq + 1);
          if (eq < 1)
            return usage(
              '--set expects name=value, for example --set primary=#ff8800 or --set title=0.12',
            );
          if (COLORS.includes(key)) colors[key] = val;
          else if (SCALES.includes(key)) scale[key] = Number(val);
          else
            return usage(
              `unknown brand setting "${key}"; colours: ${COLORS.join(', ')}; sizes: ${SCALES.join(', ')}`,
            );
        }
        if (!f.set.length) return usage('give at least one --set name=value');
        if (Object.keys(colors).length) store.dispatch('core/brand.set-colors', { patch: colors });
        if (Object.keys(scale).length) store.dispatch('core/brand.set-scale', { patch: scale });
        return brandCommand(ctx, 'show', dir);
      }
      case 'logo':
      case 'font': {
        if (!file) return usage(`give the ${sub} file`);
        const r = await brandImportOp(store, {
          kind: sub,
          path: file,
          ...(f.role ? { role: f.role } : {}),
          ...(f.family ? { family: f.family } : {}),
          ...(f.bold ? { bold: true } : {}),
        });
        ctx.emit(`Set the ${sub} from ${r.file.name}${r.family ? ` (family ${r.family})` : ''}`, r);
        return 0;
      }
      case 'reset':
        store.dispatch('core/brand.reset', {});
        ctx.emit('Brand kit cleared.', {});
        return 0;
      default:
        return usage(`unknown brand command "${sub}"; use show, set, logo, font or reset`);
    }
  });
}

/** `tforge effects`: everything installed that a storyboard or cut may use. */
export async function effectsCommand(ctx: CmdCtx): Promise<number> {
  const v = await effectsViewOp(ctx.engine);
  const templates = templatesViewOp(ctx.engine);
  ctx.emit(
    [
      `Transitions: ${v.transitions.map((t) => t.id.replace(/^core\//, '') + (t.flashes ? '*' : '')).join(', ')}`,
      `Effects: ${v.effects.map((e) => e.id.replace(/^core\//, '') + (e.flashes ? '*' : '')).join(', ')}`,
      `Cards: ${templates
        .filter((t) => t.kind === 'card')
        .map((t) => t.id)
        .join(', ')}`,
      `Overlays: ${templates
        .filter((t) => t.kind === 'overlay')
        .map((t) => t.id)
        .join(', ')}`,
      `Sounds: ${v.sounds.generated.join(', ')}${v.sounds.folder ? `; your folder ${v.sounds.folder} (${v.sounds.files.length} files)` : ''}`,
      '(* flashes: checked by the photosensitivity guard)',
    ].join('\n'),
    { ...v, templates },
  );
  return 0;
}

/** `tforge sfx show` and `tforge sfx folder <path|none>`. */
export async function sfxCommand(ctx: CmdCtx, sub: string, path?: string): Promise<number> {
  try {
    if (sub === 'folder') {
      if (!path) return usage('give a folder, or "none" to stop using one');
      const v = await setSfxFolderOp(ctx.engine, path === 'none' ? null : path);
      ctx.emit(
        v.folder
          ? `Using ${v.folder} (${v.files.length} files)`
          : 'Using only the generated sounds.',
        v,
      );
      return 0;
    }
    if (sub === 'show' || sub === '') {
      const v = await sfxViewOp(ctx.engine);
      ctx.emit(
        [
          `Generated: ${v.generated.join(', ')}`,
          `Your folder: ${v.folder ?? 'none'}`,
          ...v.files.map((x) => `  ${x.name}: ${x.kind}`),
          ...v.warnings.map((w) => `! ${w}`),
        ].join('\n'),
        v,
      );
      return 0;
    }
    return usage(`unknown sfx command "${sub}"; use show or folder`);
  } catch (err) {
    return fail(ctx, err);
  }
}
