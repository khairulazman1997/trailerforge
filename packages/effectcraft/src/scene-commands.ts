import type { Layer, Scene } from '@trailerforge/graphics';
import { FLICKS_PER_SECOND, type Animatable, type Easing, type Rate } from '@trailerforge/schema';

/** One EffectCraft engine command, as `effectcraft-cli run <command> <params>` takes it. */
export interface EcCommand {
  command: string;
  params: Record<string, unknown>;
}

export interface SceneCommands {
  compName: string;
  commands: EcCommand[];
  /** What the EffectCraft version cannot show the way the built-in renderer does. */
  warnings: string[];
}

/**
 * The EffectCraft commands that build a TrailerForge `Scene` as a composition: a solid for the
 * background, a solid per rect layer, a point-text layer per text layer, and keyframes for the
 * opacity, translate and scale animations, eased with Easy Ease (EffectCraft's own curve, so
 * eased motion is close to, not identical with, the built-in renderer's CSS curves). Layers are
 * named `tf_<layer id>` and referenced by name, so later commands (an LLM's edits, 8.4b) can find
 * them. Image layers and reveal animations are left out with a warning: logos come with the
 * templates (8.4), reveals have no single-property equivalent.
 */
export function sceneCommands(
  scene: Scene,
  rate: Rate,
  opts: { compName?: string } = {},
): SceneCommands {
  const compName = opts.compName ?? 'TrailerForge';
  const warnings: string[] = [];
  const commands: EcCommand[] = [
    {
      command: 'comp.new',
      params: {
        name: compName,
        width: scene.size.width,
        height: scene.size.height,
        frameRate: round6(rate.num / rate.den),
        duration: round6(scene.duration / FLICKS_PER_SECOND),
      },
    },
  ];
  if (scene.background)
    commands.push({
      command: 'layer.newSolid',
      params: {
        name: 'tf_background',
        color: scene.background,
        width: scene.size.width,
        height: scene.size.height,
      },
    });
  // EffectCraft stacks each new layer on top, the order the scene draws in.
  for (const layer of scene.layers) {
    const name = `tf_${layer.id}`;
    const centre: [number, number] = [layer.box.x + layer.box.w / 2, layer.box.y + layer.box.h / 2];
    if (layer.kind === 'image') {
      warnings.push(`image layer ${layer.id} is not drawn by the EffectCraft version`);
      continue;
    }
    if (layer.kind === 'rect') {
      commands.push({
        command: 'layer.newSolid',
        params: {
          name,
          color: layer.fill,
          width: Math.max(1, Math.round(layer.box.w)),
          height: Math.max(1, Math.round(layer.box.h)),
        },
      });
      if (layer.radius) warnings.push(`rect layer ${layer.id}: rounded corners are not drawn`);
      commands.push(set(name, 'transform/position', centre));
    } else {
      commands.push(...textLayer(layer, name, centre));
    }
    commands.push(...animation(layer, name, centre, warnings));
  }
  return { compName, commands, warnings };
}

function textLayer(
  layer: Extract<Layer, { kind: 'text' }>,
  name: string,
  centre: [number, number],
): EcCommand[] {
  const { layout } = layer;
  const first = layout.lines[0];
  const origin: [number, number] = first ? [first.x, first.y] : centre;
  const params: Record<string, unknown> = {
    name,
    text: layout.lines.map((l) => l.text).join('\n'),
    position: origin,
    font: layer.font.family,
    style: layer.font.weight >= 600 ? 'Bold' : 'Regular',
    size: layout.size,
    fill: layer.fill,
    justify: layout.align === 'start' ? 'left' : layout.align === 'end' ? 'right' : 'center',
  };
  if (layout.lines.length > 1) params.leading = round6(layout.lines[1]!.y - layout.lines[0]!.y);
  if (layer.letterSpacing) params.tracking = round6((layer.letterSpacing / layout.size) * 1000);
  // Scale about the block's centre, as the built-in renderer does: the anchor moves to the centre
  // (in layer space, whose origin is the first line's anchor) and the position follows it.
  return [
    { command: 'layer.newText', params },
    set(name, 'transform/anchor', [centre[0] - origin[0], centre[1] - origin[1]]),
    set(name, 'transform/position', centre),
  ];
}

type Key = { at: number; value: number | number[]; easing: Easing };

function keysOf(a: Animatable | undefined): Key[] | null {
  if (a === undefined) return null;
  if (typeof a === 'number' || Array.isArray(a)) return [{ at: 0, value: a, easing: 'linear' }];
  return a.keyframes.map((k) => ({ at: k.at, value: k.value, easing: k.easing ?? 'linear' }));
}

function animation(
  layer: Layer,
  name: string,
  centre: [number, number],
  warnings: string[],
): EcCommand[] {
  const out: EcCommand[] = [];
  const a = layer.animation ?? {};
  if (a.reveal !== undefined)
    warnings.push(
      `layer ${layer.id}: the reveal animation is not drawn by the EffectCraft version`,
    );
  const props: [path: string, keys: Key[] | null, map: (v: number | number[]) => unknown][] = [
    ['transform/opacity', keysOf(a.opacity), (v) => round6(first(v) * 100)],
    [
      'transform/position',
      keysOf(a.translate),
      (v) => vec2(v).map((d, i) => round6(centre[i]! + d)),
    ],
    ['transform/scale', keysOf(a.scale), (v) => vec2(v).map((s) => round6(s * 100))],
  ];
  for (const [path, keys, map] of props) {
    if (!keys) continue;
    if (keys.length === 1) {
      out.push(set(name, path, map(keys[0]!.value)));
      continue;
    }
    for (const k of keys)
      out.push({
        command: 'prop.addKey',
        params: { layer: name, path, time: seconds(k.at), value: map(k.value) },
      });
    out.push(...easing(name, path, keys, warnings, layer.id));
  }
  return out;
}

/**
 * A keyframe's easing shapes the segment leaving it (TrailerForge's convention); in EffectCraft
 * ease belongs to a key's in or out side. ease-in slows the start (the key's out side),
 * ease-out the end (the next key's in side).
 */
function easing(
  layer: string,
  path: string,
  keys: Key[],
  warnings: string[],
  id: string,
): EcCommand[] {
  const sides = keys.map(() => ({ in: false, out: false, hold: false }));
  keys.forEach((k, i) => {
    if (i === keys.length - 1) return;
    const e = k.easing;
    if (e === 'linear') return;
    if (e === 'hold') sides[i]!.hold = true;
    else if (e === 'ease-in') sides[i]!.out = true;
    else if (e === 'ease-out') sides[i + 1]!.in = true;
    else if (e === 'ease-in-out') {
      sides[i]!.out = true;
      sides[i + 1]!.in = true;
    } else {
      const [x1, , x2] = e.cubicBezier;
      if (x1 > 0.05) sides[i]!.out = true;
      if (x2 < 0.95) sides[i + 1]!.in = true;
      warnings.push(`layer ${id}: a custom curve on ${path} is approximated by Easy Ease`);
    }
  });
  const out: EcCommand[] = [];
  keys.forEach((k, i) => {
    const s = sides[i]!;
    if (!s.in && !s.out && !s.hold) return;
    out.push({
      command: 'keys.select',
      params: { keys: [{ layer, path, time: seconds(k.at) }] },
    });
    if (s.in || s.out)
      out.push({
        command: 'keys.easyEase',
        params: { which: s.in && s.out ? 'both' : s.in ? 'in' : 'out' },
      });
    if (s.hold) out.push({ command: 'keys.toggleHold', params: {} });
  });
  return out;
}

function set(layer: string, path: string, value: unknown): EcCommand {
  return { command: 'prop.set', params: { layer, path, value } };
}
const seconds = (f: number) => round6(f / FLICKS_PER_SECOND);
const first = (v: number | number[]) => (typeof v === 'number' ? v : (v[0] ?? 0));
const vec2 = (v: number | number[]): [number, number] =>
  typeof v === 'number' ? [v, v] : [v[0] ?? 0, v[1] ?? v[0] ?? 0];
/** Six decimals: the same scene always gives byte-identical command text. */
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * Splits commands into `run` calls whose argument text stays under `budget` characters (Windows
 * limits a command line to 32 767), keeping the order.
 */
export function chunkCommands(commands: EcCommand[], budget = 24_000): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const c of commands) {
    const pair = [c.command, JSON.stringify(c.params)];
    const n = pair[0]!.length + pair[1]!.length + 8;
    if (n > budget) throw new Error(`${c.command}: parameters too long for one command line`);
    if (size + n > budget && cur.length) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(...pair);
    size += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}
