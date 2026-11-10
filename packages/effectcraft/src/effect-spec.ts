import { z } from 'zod';
import type { EcCommand } from './scene-commands.js';

/**
 * A custom effect as an LLM (or Claude Code through MCP) writes it (plan M10 decision 4): a name,
 * a one-line summary and the EffectCraft commands that build it inside a composition TrailerForge
 * creates itself. Only commands on the allowlist are run, and their parameters are checked here
 * before EffectCraft sees them: no file paths, no URLs, no expressions or scripts, no other
 * compositions. EffectCraft then validates every parameter itself.
 */
export const EFFECT_MAX_COMMANDS = 200;

export const AuthoredEffect = z.strictObject({
  name: z.string().trim().min(1).max(60),
  summary: z.string().trim().min(1).max(300),
  commands: z
    .array(
      z.strictObject({
        command: z.string().min(1).max(64),
        params: z.record(z.string(), z.json()).default({}),
      }),
    )
    .min(1)
    .max(EFFECT_MAX_COMMANDS),
});
export type AuthoredEffect = z.infer<typeof AuthoredEffect>;

/** The composition every authored effect is built in. */
export const EFFECT_COMP = 'tf-effect';

/**
 * The basic commands of an authored effect: make and name layers, set and animate their
 * properties, ease keyframes and apply effects. Every supported EffectCraft has them, so they are
 * part of the compatibility check (`REQUIRED_COMMANDS`).
 */
export const BASIC_EFFECT_COMMANDS: readonly string[] = [
  'layer.newText',
  'layer.newSolid',
  'layer.newShape',
  'layer.newNull',
  'layer.newAdjustment',
  'layer.rename',
  'layer.setSwitch',
  'layer.addShapeItem',
  'layer.setParent',
  'prop.set',
  'prop.addKey',
  'keys.select',
  'keys.easyEase',
  'keys.easyEaseIn',
  'keys.easyEaseOut',
  'keys.toggleHold',
  'effect.apply',
];

/**
 * The compositing and type commands that make an effect look like trailer motion graphics rather
 * than a plain card: blend modes, track mattes, masks, text animators and presets, the built-in
 * animation presets and layer styles. All work inside the project and touch no file.
 * They are optional: a build without one of them is still usable, and the model is offered only
 * those the installed build lists (`offeredEffectCommands`).
 */
export const RICH_EFFECT_COMMANDS: readonly string[] = [
  'layer.setBlendMode',
  'layer.setTrackMatte',
  'layer.addMask',
  'layer.addTextAnimator',
  'layer.addTextAnimatorProperty',
  'layer.addTextSelector',
  'layer.applyTextPreset',
  'anim.applyBuiltinPreset',
  'layer.style.gradientOverlay',
  'layer.style.stroke',
  'shape.fillStroke',
];

/**
 * Mask commands are allowed by family (`layer.mask.feather`, `mask.featherPoint.add`, …): their
 * exact ids differ between builds, and none of them reads or writes files.
 */
export const EFFECT_COMMAND_FAMILIES: readonly string[] = ['layer.mask.', 'mask.featherPoint.'];

/** Every command id an authored effect may name (families aside). */
export const EFFECT_COMMANDS: readonly string[] = [
  ...BASIC_EFFECT_COMMANDS,
  ...RICH_EFFECT_COMMANDS,
];

/** On the allowlist, by id or by family. */
export function isEffectCommand(id: string): boolean {
  return EFFECT_COMMANDS.includes(id) || EFFECT_COMMAND_FAMILIES.some((f) => id.startsWith(f));
}

/**
 * The allowed commands an installed EffectCraft lists (its `commands --json` ids), in allowlist
 * order with family members after; every allowed id when the list is unknown.
 */
export function offeredEffectCommands(listed: ReadonlySet<string> | null): string[] {
  if (!listed) return [...EFFECT_COMMANDS];
  return [
    ...EFFECT_COMMANDS.filter((id) => listed.has(id)),
    ...[...listed].filter((id) => EFFECT_COMMAND_FAMILIES.some((f) => id.startsWith(f))).sort(),
  ];
}

/**
 * Built-in animation and text presets that are refused, with the reason given to the model.
 * Strobing and flickering risk photosensitive seizures and break the flash guard's count
 * (`core/flash-plan` only knows declared flashes); shaking, bouncing and jittering are the
 * cartoon look the effects are meant to avoid; random letter scrambles are not readable.
 */
export const REFUSED_PRESETS: Readonly<Record<string, string>> = {
  strobe: 'it strobes (a photosensitivity risk the flash check cannot count)',
  flicker: 'it flickers (a photosensitivity risk the flash check cannot count)',
  blink: 'it blinks on and off (a photosensitivity risk the flash check cannot count)',
  shake: 'screen shake looks cheap in a title; use a small eased scale change instead',
  jitterScale: 'jittering looks cheap; use a slow eased scale (e.g. "breathe") instead',
  bouncingBall: 'bouncing is a cartoon look; use an eased slide or fade instead',
  rubberBand: 'squash and stretch is a cartoon look; use an eased scale of a few percent instead',
  wobble: 'wobbling is a cartoon look; use "floatUpDown" or a slow drift instead',
  heartbeat: 'a pulsing heartbeat looks cheap; use a single soft glow pulse instead',
  bounceInWords: 'bouncing words are a cartoon look; use "fadeUpCharacters" or "blurIn" instead',
  jitter: 'jittering letters look cheap; use "trackingIn" or "blurIn" instead',
  scramble: 'scrambled letters are random and hard to read; use "typewriter" or "blurIn" instead',
};

/** Commands whose `preset` parameter names a built-in preset. */
const PRESET_COMMANDS = new Set(['anim.applyBuiltinPreset', 'layer.applyTextPreset']);

/** Keys whose value is code or names a file: never accepted. */
const FORBIDDEN_KEYS = new Set([
  'expression',
  'expressions',
  'script',
  'code',
  'eval',
  'file',
  'files',
  'output',
  'out',
  'url',
  'source',
  'footage',
  'item',
  'project',
]);
const PROPERTY_PATH = /^[A-Za-z0-9 #@_.()/-]{1,120}$/;
const LOOKS_LIKE_FILE =
  /^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])|:\/\/|\.\.[\\/]|\\|\.(?:ecproj|ectemplate|png|jpe?g|gif|mov|mp4|mkv|wav|aiff?|json|jsx?|txt|exe|dll|bat|ps1|sh|lottie|svg|ttf|otf)$/i;
const MAX_PARAM_BYTES = 8_000;
const MAX_DEPTH = 6;

/** Problems with an authored effect's commands, in words the model can act on; empty = fine. */
export function effectProblems(
  commands: readonly EcCommand[],
  opts: {
    comps?: readonly string[];
    /** The installed build's command ids: allowed commands it lacks are reported. */
    listed?: ReadonlySet<string> | null;
  } = {},
): string[] {
  const comps = opts.comps ?? [EFFECT_COMP];
  const offered = offeredEffectCommands(opts.listed ?? null);
  const out: string[] = [];
  commands.forEach((c, i) => {
    const at = `command ${i + 1} (${c.command})`;
    if (!isEffectCommand(c.command)) {
      out.push(
        c.command.startsWith('comp.')
          ? `${at}: do not create or change compositions; the composition "${EFFECT_COMP}" already exists and is active`
          : `${at}: not allowed; use only ${offered.join(', ')}`,
      );
      return;
    }
    if (opts.listed && !opts.listed.has(c.command)) {
      out.push(
        `${at}: this EffectCraft does not have that command; build the look with ${offered.join(', ')}`,
      );
      return;
    }
    const p = c.params as Record<string, unknown>;
    if (PRESET_COMMANDS.has(c.command) && typeof p.preset === 'string') {
      const why = REFUSED_PRESETS[p.preset];
      if (why) out.push(`${at}: the preset "${p.preset}" is not allowed: ${why}`);
    }
    if (
      (c.command === 'layer.newShape' && p.kind === 'star') ||
      (c.command === 'layer.addMask' && p.shape === 'star')
    )
      out.push(
        `${at}: star shapes are not allowed (they read as clip art); use light, blur or a thin line`,
      );
    if (c.command === 'layer.addTextSelector' && p.kind === 'expression')
      out.push(
        `${at}: expression selectors are not allowed (no code); use kind "range" with keyframed start, end or offset`,
      );
    if (JSON.stringify(c.params).length > MAX_PARAM_BYTES)
      out.push(`${at}: parameters are too long`);
    walk(c.params, [], (path, key, v) => {
      const where = `${at}: ${[...path, key].filter(Boolean).join('.') || 'params'}`;
      if (path.length > MAX_DEPTH) return out.push(`${where}: nested too deeply`);
      if (key && FORBIDDEN_KEYS.has(key))
        return out.push(`${where}: not allowed (no files, footage or code)`);
      if (key === 'comp' && !comps.includes(String(v)))
        return out.push(
          `${where}: only the composition${comps.length > 1 ? 's' : ''} ${comps.map((c) => `"${c}"`).join(', ')} may be used`,
        );
      if (typeof v !== 'string') return;
      if (key === 'path') {
        if (!PROPERTY_PATH.test(v) || v.startsWith('/') || v.includes('..'))
          out.push(`${where}: "${v}" is not a property path such as transform/opacity`);
      } else if (LOOKS_LIKE_FILE.test(v)) out.push(`${where}: file paths and URLs are not allowed`);
    });
  });
  return out;
}

function walk(
  v: unknown,
  path: string[],
  visit: (path: string[], key: string, v: unknown) => unknown,
  key = '',
): void {
  visit(path, key, v);
  if (Array.isArray(v))
    v.forEach((x, i) => walk(x, [...path, ...(key ? [key] : [])], visit, String(i)));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) walk(x, [...path, ...(key ? [key] : [])], visit, k);
}

/**
 * The commands EffectCraft runs for an effect: TrailerForge's own composition (the picture's size
 * and rate, the effect's length, transparent) and then the authored commands as given.
 */
export function effectCommands(
  effect: AuthoredEffect,
  o: { width: number; height: number; frameRate: number; seconds: number },
): EcCommand[] {
  return [
    {
      command: 'comp.new',
      params: {
        name: EFFECT_COMP,
        width: o.width,
        height: o.height,
        frameRate: Math.round(o.frameRate * 1e6) / 1e6,
        duration: Math.round(o.seconds * 1e6) / 1e6,
      },
    },
    ...effect.commands.map((c) => ({
      command: c.command,
      params: c.params as Record<string, unknown>,
    })),
  ];
}

/**
 * An EffectCraft error made safe to show a model: file paths (the scratch folder, the project)
 * become `<file>`, and the message is cut to a readable length.
 */
export function scrubCliError(message: string): string {
  return message
    .replace(/(?:[A-Za-z]:)?[\\/][^\s"'`:;,()]*[\\/][^\s"'`:;,()]*/g, '<file>')
    .replace(/\s+/g, ' ')
    .slice(0, 600);
}
