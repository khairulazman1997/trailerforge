import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BASIC_EFFECT_COMMANDS,
  EFFECT_EXAMPLES,
  EXAMPLE_FRAME_RATE,
  EXAMPLE_SECONDS,
  EXAMPLE_SIZE,
  EffectCraftRenderer,
  REFUSED_PRESETS,
  REQUIRED_COMMANDS,
  RICH_EFFECT_COMMANDS,
  compatProblem,
  describeCommands,
  effectCommands,
  effectExamplesText,
  effectProblems,
  isEffectCommand,
  offeredEffectCommands,
  type CliLocation,
} from './index.js';

const STUB = fileURLToPath(new URL('./__fixtures__/stub-cli.mjs', import.meta.url));
const stub = (mode = 'ok'): CliLocation => ({ bin: process.execPath, prefixArgs: [STUB, mode] });

describe('the effect allowlist', () => {
  it('allows the compositing and type commands and mask families, nothing that touches files', () => {
    for (const id of RICH_EFFECT_COMMANDS) expect(isEffectCommand(id)).toBe(true);
    expect(isEffectCommand('layer.mask.setFeather')).toBe(true);
    expect(isEffectCommand('mask.featherPoint.add')).toBe(true);
    for (const id of [
      'file.importLottie',
      'file.save',
      'comp.new',
      'render.queue',
      'layer.addItem',
    ])
      expect(isEffectCommand(id)).toBe(false);
  });

  it('keeps the compatibility check to the basic commands', () => {
    for (const id of RICH_EFFECT_COMMANDS) expect(REQUIRED_COMMANDS).not.toContain(id);
    for (const id of BASIC_EFFECT_COMMANDS) expect(REQUIRED_COMMANDS).toContain(id);
    expect(compatProblem('0.22.0', new Set(REQUIRED_COMMANDS))).toBeNull();
  });

  it('refuses risky and cartoon presets, expression selectors and stars, with a reason', () => {
    for (const preset of Object.keys(REFUSED_PRESETS)) {
      const [p] = effectProblems([{ command: 'anim.applyBuiltinPreset', params: { preset, layers: ['A'] } }]); // prettier-ignore
      expect(p).toContain(`the preset "${preset}" is not allowed: `);
    }
    expect(effectProblems([{ command: 'layer.applyTextPreset', params: { layer: 'A', preset: 'scramble' } }])[0]).toMatch(/random and hard to read/); // prettier-ignore
    expect(effectProblems([{ command: 'anim.applyBuiltinPreset', params: { preset: 'strobe' } }])[0]).toMatch(/photosensitivity/); // prettier-ignore
    expect(effectProblems([{ command: 'layer.addTextSelector', params: { layer: 'A', animator: 1, kind: 'expression' } }])[0]).toMatch(/expression selectors are not allowed/); // prettier-ignore
    expect(effectProblems([{ command: 'layer.addMask', params: { layer: 'A', shape: 'star' } }])[0]).toMatch(/star shapes/); // prettier-ignore
    expect(effectProblems([{ command: 'layer.newShape', params: { name: 'S', kind: 'star' } }])[0]).toMatch(/star shapes/); // prettier-ignore
    expect(
      effectProblems([
        { command: 'anim.applyBuiltinPreset', params: { preset: 'emberHaze', layers: ['Haze'] } },
        { command: 'layer.applyTextPreset', params: { layer: 'T', preset: 'blurIn' } },
        { command: 'layer.addTextSelector', params: { layer: 'T', animator: 1, kind: 'range' } },
        { command: 'layer.setTrackMatte', params: { layer: 'Sweep', matte: 'Title Matte', kind: 'alpha' } }, // prettier-ignore
        { command: 'layer.setTrackMatte', params: { layer: 'Sweep', matte: null } },
      ]),
    ).toEqual([]);
  });

  it('still refuses files, code and other compositions inside the new commands', () => {
    const probs = effectProblems([
      { command: 'layer.addTextSelector', params: { layer: 'A', animator: 1, kind: 'range', expression: 'wiggle(2,5)' } }, // prettier-ignore
      { command: 'layer.style.gradientOverlay', params: { layers: ['A'], url: 'https://x.test' } },
      { command: 'prop.editGradient', params: { layer: 'A', path: '../x', stops: [] } },
      { command: 'layer.setBlendMode', params: { layers: ['A'], mode: 'Screen', comp: 'Other' } },
    ]);
    expect(probs).toHaveLength(4);
  });

  it('reports allowed commands the installed build lacks and offers only what it lists', () => {
    const listed = new Set([
      ...BASIC_EFFECT_COMMANDS,
      'layer.setBlendMode',
      'layer.mask.setFeather',
    ]);
    expect(offeredEffectCommands(listed)).toEqual([...BASIC_EFFECT_COMMANDS, 'layer.setBlendMode', 'layer.mask.setFeather']); // prettier-ignore
    expect(offeredEffectCommands(null)).toContain('anim.applyBuiltinPreset');
    const [p] = effectProblems([{ command: 'layer.setTrackMatte', params: { layer: 'A', matte: 'B' } }], { listed }); // prettier-ignore
    expect(p).toMatch(/this EffectCraft does not have that command/);
  });

  it('reads parameter descriptions from commands --json', () => {
    const out = JSON.stringify([
      { id: 'layer.setBlendMode', label: 'Blend', enabled: true, params: { mode: 'string' } },
      { id: 'prop.set', label: 'Set', enabled: true },
    ]);
    expect(describeCommands(out, ['layer.setBlendMode', 'prop.set', 'gone'])).toEqual([
      'layer.setBlendMode: {"params":{"mode":"string"}}',
    ]);
    expect(describeCommands('nope', ['prop.set'])).toEqual([]);
  });

  it('the worked examples pass the checks and go into the prompt', () => {
    for (const { effect } of EFFECT_EXAMPLES) {
      expect(effectProblems(effect.commands)).toEqual([]);
      const cmds = effectCommands(effect, { ...EXAMPLE_SIZE, frameRate: EXAMPLE_FRAME_RATE, seconds: EXAMPLE_SECONDS }); // prettier-ignore
      expect(cmds[0]!.command).toBe('comp.new');
      for (const c of effect.commands)
        for (const k of ['time'] as const)
          if (typeof c.params[k] === 'number') expect(c.params[k]).toBeLessThanOrEqual(EXAMPLE_SECONDS); // prettier-ignore
    }
    const text = effectExamplesText();
    expect(text).toContain('Light sweep title');
    expect(text).toContain('"layer.setTrackMatte"');
    expect(text).toContain('"text/animators/#1/selectors/#1/start"');
  });
});

describe('the command set a model is offered', () => {
  let work: string;
  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'tforge-ecset-'));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('follows the installed build, with its own parameter descriptions', async () => {
    const full = await new EffectCraftRenderer({ cli: stub('ok'), workRoot: work }).effectCommandSet(); // prettier-ignore
    expect(full.offered).toContain('layer.setTrackMatte');
    expect(full.offered).toContain('layer.mask.setFeather');
    expect(full.described).toEqual([
      'anim.applyBuiltinPreset: {"params":{"preset":"string","layers":"string[]?"}}',
    ]);

    const basic = new EffectCraftRenderer({ cli: stub('basic'), workRoot: work });
    expect((await basic.available()).ok).toBe(true);
    const set = await basic.effectCommandSet();
    expect(set.offered).toEqual([...BASIC_EFFECT_COMMANDS]);
    expect(set.described).toEqual([]);
  });

  it('builds the worked examples on the stand-in CLI', async () => {
    const r = new EffectCraftRenderer({ cli: stub('ok'), workRoot: work });
    for (const { id, effect } of EFFECT_EXAMPLES) {
      const p = await r.authorProject(
        effectCommands(effect, { ...EXAMPLE_SIZE, frameRate: EXAMPLE_FRAME_RATE, seconds: EXAMPLE_SECONDS }), // prettier-ignore
        join(work, `${id}.ecproj`),
        new AbortController().signal,
      );
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
