import { z } from 'zod';
import type { EcCommand } from './scene-commands.js';

/**
 * A custom effect as an LLM (or Claude Code through MCP) writes it (plan M8 decision 4): a name,
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
 * What an authored effect may do: make and name layers, set and animate their properties, ease
 * keyframes and apply effects. Nothing that opens, imports, saves, exports, renders or runs code.
 */
export const EFFECT_COMMANDS: readonly string[] = [
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
export function effectProblems(commands: readonly EcCommand[]): string[] {
  const out: string[] = [];
  commands.forEach((c, i) => {
    const at = `command ${i + 1} (${c.command})`;
    if (!EFFECT_COMMANDS.includes(c.command)) {
      out.push(
        c.command.startsWith('comp.')
          ? `${at}: do not create or change compositions; the composition "${EFFECT_COMP}" already exists and is active`
          : `${at}: not allowed; use only ${EFFECT_COMMANDS.join(', ')}`,
      );
      return;
    }
    if (JSON.stringify(c.params).length > MAX_PARAM_BYTES)
      out.push(`${at}: parameters are too long`);
    walk(c.params, [], (path, key, v) => {
      const where = `${at}: ${[...path, key].filter(Boolean).join('.') || 'params'}`;
      if (path.length > MAX_DEPTH) return out.push(`${where}: nested too deeply`);
      if (key && FORBIDDEN_KEYS.has(key))
        return out.push(`${where}: not allowed (no files, footage or code)`);
      if (key === 'comp' && v !== EFFECT_COMP)
        return out.push(`${where}: only the composition "${EFFECT_COMP}" may be used`);
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
