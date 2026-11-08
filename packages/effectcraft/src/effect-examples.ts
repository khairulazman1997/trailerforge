import type { AuthoredEffect } from './effect-spec.js';

/**
 * Worked examples of trailer-grade effects, written for a 1920×1080, 30 fps, 3 s effect. They go
 * into the author prompt verbatim (`effectExamplesText`), the tests check them against the
 * allowlist, and `scripts/showcase.mjs` renders them with the installed EffectCraft so the looks
 * can be checked by eye. Property paths beyond `transform/*`, `text/sourceText` and
 * `effects/#n/<parameter>` follow EffectCraft's After Effects naming and are unverified until
 * the showcase has run on a real build.
 */
export const EXAMPLE_SIZE = { width: 1920, height: 1080 } as const;
export const EXAMPLE_FRAME_RATE = 30;
export const EXAMPLE_SECONDS = 3;

type Cmd = AuthoredEffect['commands'][number];
type Value = number | number[];

const ease = (layer: string, path: string, times: number[]): Cmd[] => [
  { command: 'keys.select', params: { keys: times.map((time) => ({ layer, path, time })) } },
  { command: 'keys.easyEase', params: { which: 'both' } },
];
const keys = (layer: string, path: string, pairs: [number, Value][]): Cmd[] => [
  ...pairs.map(([time, value]) => ({
    command: 'prop.addKey',
    params: { layer, path, time, value },
  })),
  ...ease(
    layer,
    path,
    pairs.map(([t]) => t),
  ),
];
const title = (name: string, text: string, extra: Record<string, string | Value> = {}): Cmd => ({
  command: 'layer.newText',
  params: {
    name,
    text,
    position: [960, 540],
    font: 'Inter',
    style: 'Bold',
    size: 132,
    fill: '#F4F1EA',
    justify: 'center',
    tracking: 220,
    ...extra,
  },
});

/** A light sweep through the title: a soft white bar, alpha-matted to a copy of the title, on Screen. */
const lightSweep: AuthoredEffect = {
  name: 'Light sweep title',
  summary:
    'The title settles from 104% while fading in, then a soft band of light sweeps through the letters only.',
  commands: [
    title('Title', 'EMBER KNIGHT', { fill: '#BDB5A8' }),
    ...keys('Title', 'transform/opacity', [
      [0, 0],
      [0.6, 100],
      [2.5, 100],
      [2.95, 0],
    ]),
    ...keys('Title', 'transform/scale', [
      [0, [104, 104]],
      [1.2, [100, 100]],
    ]),
    { command: 'layer.newSolid', params: { name: 'Sweep', color: '#FFF6E0', width: 240, height: 1400 } }, // prettier-ignore
    { command: 'prop.set', params: { layer: 'Sweep', path: 'transform/rotation', value: 18 } },
    { command: 'prop.set', params: { layer: 'Sweep', path: 'transform/opacity', value: 80 } },
    { command: 'effect.apply', params: { layer: 'Sweep', effect: 'Gaussian Blur' } },
    { command: 'prop.set', params: { layer: 'Sweep', path: 'effects/#1/Blurriness', value: 70 } },
    ...keys('Sweep', 'transform/position', [
      [0.9, [-240, 540]],
      [2.1, [2160, 540]],
    ]),
    { command: 'layer.setBlendMode', params: { layers: ['Sweep'], mode: 'Screen' } },
    // The matte: a copy of the title directly above the sweep, with the same scale animation.
    title('Title Matte', 'EMBER KNIGHT'),
    ...keys('Title Matte', 'transform/scale', [
      [0, [104, 104]],
      [1.2, [100, 100]],
    ]),
    { command: 'layer.setTrackMatte', params: { layer: 'Sweep', matte: 'Title Matte', kind: 'alpha' } }, // prettier-ignore
  ],
};

/** Letters resolve one by one from blur and wide tracking; a thin accent rule wipes on through a soft-edged matte. */
const letterReveal: AuthoredEffect = {
  name: 'Letter blur reveal',
  summary:
    'The tagline resolves letter by letter from blurred, widely spaced type, while a thin accent rule wipes on beneath it with a soft edge.',
  commands: [
    title('Tagline', 'THE LAST FLAME BURNS', {
      style: 'Regular',
      size: 64,
      tracking: 400,
      fill: '#E8E2D6',
      position: [960, 530],
    }),
    {
      command: 'layer.addTextAnimator',
      params: { layer: 'Tagline', properties: ['opacity', 'blur', 'tracking'] },
    },
    { command: 'prop.set', params: { layer: 'Tagline', path: 'text/animators/#1/properties/opacity', value: 0 } }, // prettier-ignore
    { command: 'prop.set', params: { layer: 'Tagline', path: 'text/animators/#1/properties/blur', value: [24, 24] } }, // prettier-ignore
    { command: 'prop.set', params: { layer: 'Tagline', path: 'text/animators/#1/properties/tracking', value: 60 } }, // prettier-ignore
    ...keys('Tagline', 'text/animators/#1/selectors/#1/start', [
      [0.1, 0],
      [1.7, 100],
    ]),
    ...keys('Tagline', 'transform/opacity', [
      [2.5, 100],
      [2.95, 0],
    ]),
    { command: 'layer.newSolid', params: { name: 'Rule', color: '#D9893B', width: 520, height: 3 } }, // prettier-ignore
    { command: 'prop.set', params: { layer: 'Rule', path: 'transform/position', value: [960, 600] } }, // prettier-ignore
    ...keys('Rule', 'transform/opacity', [
      [2.5, 100],
      [2.95, 0],
    ]),
    // A blurred solid sliding in from the left: its soft edge is the feathered wipe.
    { command: 'layer.newSolid', params: { name: 'Wipe', color: '#FFFFFF', width: 700, height: 200 } }, // prettier-ignore
    { command: 'effect.apply', params: { layer: 'Wipe', effect: 'Gaussian Blur' } },
    { command: 'prop.set', params: { layer: 'Wipe', path: 'effects/#1/Blurriness', value: 60 } },
    ...keys('Wipe', 'transform/position', [
      [0.6, [180, 600]],
      [1.8, [960, 600]],
    ]),
    { command: 'layer.setTrackMatte', params: { layer: 'Rule', matte: 'Wipe', kind: 'alpha' } },
  ],
};

/** Embers drifting behind a title that is first a thin outline, then fills in. */
const emberOutline: AuthoredEffect = {
  name: 'Ember haze outline title',
  summary:
    'Faint embers drift up behind a thin outlined title, whose solid fill then wipes in from the left with a soft edge.',
  commands: [
    // The haze: a full-frame solid with the preset, luma-matted to a copy of itself so only its
    // light shows over the video, kept faint.
    { command: 'layer.newSolid', params: { name: 'Haze', color: '#000000', width: 1920, height: 1080 } }, // prettier-ignore
    { command: 'anim.applyBuiltinPreset', params: { preset: 'emberHaze', layers: ['Haze'] } },
    ...keys('Haze', 'transform/opacity', [
      [0, 0],
      [0.8, 45],
      [2.4, 45],
      [3, 0],
    ]),
    { command: 'layer.newSolid', params: { name: 'Haze Luma', color: '#000000', width: 1920, height: 1080 } }, // prettier-ignore
    { command: 'anim.applyBuiltinPreset', params: { preset: 'emberHaze', layers: ['Haze Luma'] } },
    { command: 'layer.setTrackMatte', params: { layer: 'Haze', matte: 'Haze Luma', kind: 'luma' } },
    // The outline: the title with a thin stroke, its own fill kept dim.
    title('Outline', 'RISE OF EMBERS', { tracking: 260 }),
    { command: 'layer.style.stroke', params: { layers: ['Outline'], color: '#F4F1EA', size: 2 } },
    ...keys('Outline', 'transform/opacity', [
      [0.2, 0],
      [0.8, 35],
      [2.5, 35],
      [2.95, 0],
    ]),
    // The fill, revealed by a soft-edged matte sliding across.
    title('Fill', 'RISE OF EMBERS', { tracking: 260 }),
    ...keys('Fill', 'transform/opacity', [
      [2.5, 100],
      [2.95, 0],
    ]),
    { command: 'layer.newSolid', params: { name: 'Fill Wipe', color: '#FFFFFF', width: 1700, height: 400 } }, // prettier-ignore
    { command: 'effect.apply', params: { layer: 'Fill Wipe', effect: 'Gaussian Blur' } },
    { command: 'prop.set', params: { layer: 'Fill Wipe', path: 'effects/#1/Blurriness', value: 120 } }, // prettier-ignore
    ...keys('Fill Wipe', 'transform/position', [
      [1.0, [-900, 540]],
      [2.0, [960, 540]],
    ]),
    { command: 'layer.setTrackMatte', params: { layer: 'Fill', matte: 'Fill Wipe', kind: 'alpha' } }, // prettier-ignore
  ],
};

export const EFFECT_EXAMPLES: readonly { id: string; effect: AuthoredEffect }[] = [
  { id: 'light-sweep', effect: lightSweep },
  { id: 'letter-reveal', effect: letterReveal },
  { id: 'ember-outline', effect: emberOutline },
];

/** The examples as the author prompt shows them: one compact command per line. */
export function effectExamplesText(): string {
  return EFFECT_EXAMPLES.map(({ effect }, i) =>
    [
      `Example ${i + 1}: ${effect.name}. ${effect.summary}`,
      '```json',
      `{"name": ${JSON.stringify(effect.name)}, "summary": ${JSON.stringify(effect.summary)}, "commands": [`,
      effect.commands.map((c) => `  ${JSON.stringify(c)}`).join(',\n'),
      ']}',
      '```',
    ].join('\n'),
  ).join('\n\n');
}
