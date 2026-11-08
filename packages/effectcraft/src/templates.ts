import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinRegistry, type GraphicTemplate } from '@trailerforge/graphics';
import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import type { EcCommand } from './scene-commands.js';

/**
 * The three EffectCraft templates TrailerForge ships (plan M10 decision 6). Each is an Essential
 * Graphics `.ectemplate` rendered with `--values`, where the values are the slot's `text` (and
 * `subtitle`) mapped to the template's control names. They are made for one frame size and a
 * length of up to `maxSeconds`; anything else, or an EffectCraft that is not available, draws the
 * nearest built-in template instead (`fallback`), with a warning.
 */
export interface EcTemplateDef {
  id: string;
  name: string;
  kind: 'card' | 'overlay';
  /** The built-in template that draws the same words when EffectCraft cannot. */
  fallback: string;
  /** Param name → the template's control name. Params without a control are not passed on. */
  controls: Record<string, string>;
  /** File name under the templates folder. */
  file: string;
  size: { width: number; height: number };
  frameRate: number;
  /** Length of the template's composition, seconds. */
  maxSeconds: number;
  /** Animation of the main text layer: keyframes as [seconds, value], opacity in %, scale in %. */
  motion: {
    opacity?: [number, number][];
    scale?: [number, number][];
    position?: [number, [number, number]][];
  };
  /** Duration in seconds: default and shortest sensible. */
  duration: { default: number; min: number };
}

export const EC_TEMPLATES: readonly EcTemplateDef[] = [
  {
    id: 'effectcraft/title-reveal',
    name: 'Title reveal (EffectCraft)',
    kind: 'card',
    fallback: 'core/title-card',
    controls: { text: 'Title', subtitle: 'Subtitle' },
    file: 'title-reveal.ectemplate',
    size: { width: 1920, height: 1080 },
    frameRate: 30,
    maxSeconds: 10,
    motion: {
      opacity: [
        [0, 0],
        [0.5, 100],
      ],
      scale: [
        [0, 90],
        [1.2, 100],
      ],
    },
    duration: { default: 3, min: 1.5 },
  },
  {
    id: 'effectcraft/logo-sting',
    name: 'Logo sting (EffectCraft)',
    kind: 'card',
    fallback: 'core/logo-card',
    controls: { text: 'Name' },
    file: 'logo-sting.ectemplate',
    size: { width: 1920, height: 1080 },
    frameRate: 30,
    maxSeconds: 10,
    motion: {
      scale: [
        [0, 0],
        [0.35, 112],
        [0.6, 100],
      ],
      opacity: [
        [0, 0],
        [0.2, 100],
      ],
    },
    duration: { default: 2.5, min: 1.2 },
  },
  {
    id: 'effectcraft/kinetic-text',
    name: 'Kinetic text (EffectCraft)',
    kind: 'card',
    fallback: 'core/tagline-card',
    controls: { text: 'Text' },
    file: 'kinetic-text.ectemplate',
    size: { width: 1920, height: 1080 },
    frameRate: 30,
    maxSeconds: 10,
    motion: {
      position: [
        [0, [560, 540]],
        [0.7, [960, 540]],
      ],
      opacity: [
        [0, 0],
        [0.4, 100],
      ],
    },
    duration: { default: 3, min: 1.5 },
  },
];

/** `TFORGE_EFFECTCRAFT_TEMPLATES`, else the `templates` folder of this package. */
export function defaultTemplatesDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.TFORGE_EFFECTCRAFT_TEMPLATES?.trim() ||
    fileURLToPath(new URL('../templates', import.meta.url))
  );
}

export const ecTemplateById = (id: string): EcTemplateDef | undefined =>
  EC_TEMPLATES.find((t) => t.id === id);

/**
 * The EffectCraft commands that author a template's source composition (run by
 * `scripts/build-templates.mjs`, which ends with `essential.exportTemplate`): a dark background, a
 * centred text layer per control with the template's motion on the first, and one Essential
 * Graphics control per text layer. Everything is named, so nothing depends on layer numbers.
 */
export function templateAuthoringCommands(def: EcTemplateDef, outPath: string): EcCommand[] {
  const { width, height } = def.size;
  const comp = def.id.replace('effectcraft/', 'tf-');
  const cmds: EcCommand[] = [
    {
      command: 'comp.new',
      params: { name: comp, width, height, frameRate: def.frameRate, duration: def.maxSeconds },
    },
    {
      command: 'layer.newSolid',
      params: { name: 'Background', color: '#0b0b0f', width, height },
    },
  ];
  const names = Object.values(def.controls);
  names.forEach((name, i) => {
    const size = i === 0 ? 180 : 80;
    cmds.push({
      command: 'layer.newText',
      params: {
        name,
        text: name.toUpperCase(),
        size,
        fill: i === 0 ? '#ffffff' : '#c8c8d0',
        position: [width / 2, height / 2 + i * 150],
        justify: 'center',
      },
    });
  });
  const main = names[0]!;
  const key = (path: string, time: number, value: unknown): EcCommand => ({
    command: 'prop.addKey',
    params: { layer: main, path, time, value },
  });
  for (const [t, v] of def.motion.opacity ?? []) cmds.push(key('transform/opacity', t, v));
  for (const [t, v] of def.motion.scale ?? []) cmds.push(key('transform/scale', t, [v, v]));
  for (const [t, v] of def.motion.position ?? []) cmds.push(key('transform/position', t, v));
  for (const name of names)
    cmds.push({
      command: 'essential.addProperty',
      params: { comp, layer: name, path: 'text/sourceText', name },
    });
  cmds.push({ command: 'essential.exportTemplate', params: { comp, path: outPath } });
  return cmds;
}

/** What `scripts/build-templates.mjs` records beside the files it makes. */
export interface TemplateManifest {
  effectcraft: string;
  templates: Record<string, { file: string; sha256: string }>;
}

export interface TemplateFile {
  file: string;
  controls: Record<string, string>;
  size: { width: number; height: number };
}

/**
 * The shipped templates that exist and match the manifest's hashes, by template id. Missing or
 * changed files are left out (with the reason in `problems`): a template that cannot be trusted is
 * not offered, and its slots use the built-in fallback.
 */
export function loadTemplateFiles(
  dir: string,
  expectedVersion: string,
): { files: Record<string, TemplateFile>; problems: string[] } {
  const files: Record<string, TemplateFile> = {};
  const problems: string[] = [];
  let manifest: TemplateManifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as TemplateManifest;
  } catch {
    return { files, problems: [`no EffectCraft templates found in ${dir}`] };
  }
  if (manifest.effectcraft !== expectedVersion)
    return {
      files,
      problems: [
        `the templates were made with EffectCraft ${manifest.effectcraft}, not ${expectedVersion}`,
      ],
    };
  for (const def of EC_TEMPLATES) {
    const entry = manifest.templates[def.id];
    const path = join(dir, def.file);
    if (!entry || !existsSync(path)) {
      problems.push(`template ${def.id} is missing`);
      continue;
    }
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== entry.sha256) {
      problems.push(`template ${def.id} does not match its recorded hash`);
      continue;
    }
    files[def.id] = { file: path, controls: def.controls, size: def.size };
  }
  return { files, problems };
}

/**
 * Registry entries for the shipped templates: same params as their built-in fallback and, for the
 * preview and any path that cannot use EffectCraft, the same scene (the "stand-in"). They are
 * registered only when EffectCraft is available and the file is there.
 */
export function ecGraphicTemplates(available: ReadonlySet<string>): GraphicTemplate<unknown>[] {
  const builtin = builtinRegistry();
  const out: GraphicTemplate<unknown>[] = [];
  for (const def of EC_TEMPLATES) {
    if (!available.has(def.id)) continue;
    const base = builtin.get(def.fallback);
    if (!base) continue;
    out.push({
      id: def.id,
      name: def.name,
      kind: def.kind,
      // Never picked by default for a card kind; the generator and the user choose it by id.
      serves: [],
      params: base.params,
      duration: {
        default: Math.round(def.duration.default * FLICKS_PER_SECOND),
        min: Math.round(def.duration.min * FLICKS_PER_SECOND),
      },
      build: (ctx) => base.build(ctx),
    });
  }
  return out;
}

/**
 * Why a template cannot draw this item with EffectCraft, or null when it can: it is made for one
 * frame size (a smaller picture of the same shape is rendered scaled down) and a length of up to
 * `maxSeconds`.
 */
export function templateMisfit(
  def: EcTemplateDef,
  size: { width: number; height: number },
  seconds: number,
): string | null {
  const k = size.width / def.size.width;
  const scaled =
    k <= 1 &&
    Math.round(def.size.width * k) === size.width &&
    Math.round(def.size.height * k) === size.height;
  if (!scaled)
    return `${def.name} is made for ${def.size.width}×${def.size.height}, this picture is ${size.width}×${size.height}`;
  if (seconds > def.maxSeconds) return `${def.name} runs at most ${def.maxSeconds} s`;
  return null;
}
