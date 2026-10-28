import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreCommands, ProjectStore } from '@trailerforge/core';
import { FilterRegistry, builtinFilters, crossfade, vignette } from '@trailerforge/effects';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { releaseTemplate } from '@trailerforge/pack-game-trailer';
import { Project } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { storyboardCommands } from './commands.js';
import { generateStoryboard, regenerateSection } from './generate.js';
import { GeneratedStoryboard, builtinPicks, generationSchemas } from './output.js';

const NOW = () => new Date('2026-10-28T10:00:00Z');
const shot = (title: string, extra: object = {}) => ({ kind: 'shot', title, seconds: 2, ...extra });

/** Nine slots; the model put a pick on six of them (too many) and one id it should not know. */
const reply = {
  rationale: 'Builds to the Warden.',
  sections: [
    {
      name: 'Hook',
      role: 'hook',
      slots: [
        shot('Parry', {
          effect: {
            id: 'core/vignette',
            params: { strength: 0.4 },
            why: 'Pulls the eye to the parry',
          },
        }),
        shot('Dodge'),
        shot('Combo', { sound: { kind: 'impact', why: 'Lands the combo finisher' } }),
      ],
    },
    {
      name: 'Escalation',
      role: 'escalation',
      slots: [
        shot('Forest'),
        shot('Warden', {
          transitionIn: { id: 'core/whip', seconds: 0.3, why: 'Snaps to the boss reveal' },
          sound: { kind: 'whoosh', why: 'Carries the whip' },
        }),
        shot('Fire', { effect: { id: 'core/glow', params: { strength: 7 }, why: 'Embers glow' } }),
        shot('Fall', { transitionIn: { id: 'core/flash', why: 'Hit frame' } }),
      ],
    },
    {
      name: 'End',
      role: 'end-slate',
      slots: [
        shot('Last look', { sound: { kind: 'riser', why: 'Into the title' } }),
        {
          kind: 'card',
          cardKind: 'title',
          title: 'Title',
          text: 'Ashfall',
          seconds: 2,
          transitionIn: { id: 'core/dip', why: 'Breath before the title' },
        },
      ],
    },
  ],
  music: { direction: 'Hybrid orchestral' },
};

/** The sample project without its storyboard (so nothing is locked). */
function fresh() {
  const p = sampleProject();
  p.storyboard = null;
  for (const t of p.timelines ?? [])
    for (const k of t.tracks ?? []) for (const i of k.items ?? []) delete i.slotId;
  return Project.parse(p);
}

function setup(replies: Record<string, unknown>, filters?: FilterRegistry) {
  const mock = createMockProvider(replies);
  const llm = new LlmClient({
    providers: (id) => (id === 'core/mock' ? mock : undefined),
    routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
  });
  return { mock, deps: { llm, now: NOW, ...(filters ? { filters } : {}) } };
}

describe('the generator schema', () => {
  it('only accepts installed ids: an unknown one fails validation', () => {
    const base = { rationale: 'x', sections: [{ name: 'A', slots: [shot('S')] }] };
    const withPick = (pick: object) => ({
      ...base,
      sections: [{ name: 'A', slots: [shot('S', pick)] }],
    });
    expect(
      GeneratedStoryboard.safeParse(withPick({ transitionIn: { id: 'core/whip', why: 'w' } }))
        .success,
    ).toBe(true);
    expect(
      GeneratedStoryboard.safeParse(withPick({ transitionIn: { id: 'core/star-wipe', why: 'w' } }))
        .success,
    ).toBe(false);
    expect(
      GeneratedStoryboard.safeParse(withPick({ effect: { id: 'core/whip', why: 'w' } })).success,
    ).toBe(false); // a transition is not an effect
    expect(
      GeneratedStoryboard.safeParse(withPick({ sound: { kind: 'laser', why: 'w' } })).success,
    ).toBe(false);
    expect(
      GeneratedStoryboard.safeParse(withPick({ effect: { id: 'core/vignette' } })).success,
    ).toBe(false); // needs a reason
    // A smaller installed set: the schema follows it, and empty lists drop the field.
    const small = generationSchemas({
      transitions: ['core/crossfade'],
      effects: [],
      sounds: ['impact'],
    }).GeneratedStoryboard;
    expect(small.safeParse(withPick({ transitionIn: { id: 'core/whip', why: 'w' } })).success).toBe(
      false,
    );
    expect(small.safeParse(withPick({ effect: { id: 'core/vignette', why: 'w' } })).success).toBe(
      false,
    );
    expect(builtinPicks().transitions).toContain('core/whip');
  });
});

describe('suggested transitions, effects and sounds', () => {
  it('are converted with checked params, kept sparing, and each gets a decision', async () => {
    const { deps, mock } = setup({ 'storyboard.generate': reply });
    const p = fresh();
    const { storyboard, decisions, warnings } = await generateStoryboard(deps, p, {
      template: releaseTemplate,
      targetDuration: 30,
    });
    expect(mock.calls[0]!.prompt).toMatch(
      /Transitions \(transitionIn\.id\): core\/crossfade, .*core\/whip/,
    );
    expect(mock.calls[0]!.prompt).toMatch(/Most slots get none/);
    const slots = storyboard.sections.flatMap((s) => s.slots);
    const plain = slots.filter(
      (s) =>
        !s.transitionIn &&
        s.effects.length === 0 &&
        !storyboard.music.sfxCues.some((c) => c.slotId === s.id),
    );
    // Nine slots: at most a third carry anything, so six stay plain.
    expect(plain.length).toBeGreaterThanOrEqual(6);
    expect(warnings).toContainEqual(
      expect.stringMatching(
        /more slots had a transition, effect or sound suggested; kept to 3 of 9/,
      ),
    );
    const parry = slots.find((s) => s.title === 'Parry')!;
    expect(parry.effects).toEqual([{ effectId: 'core/vignette', params: { strength: 0.4 } }]);
    const combo = slots.find((s) => s.title === 'Combo')!;
    const warden = slots.find((s) => s.title === 'Warden')!;
    expect(storyboard.music.sfxCues).toEqual([
      expect.objectContaining({ kind: 'impact', slotId: combo.id, position: 'start' }),
      expect.objectContaining({ kind: 'whoosh', slotId: warden.id, position: 'before' }),
    ]);
    expect(warden.transitionIn).toEqual({
      transitionId: 'core/whip',
      duration: 0.3,
      params: { direction: 'left', blur: 0.03 },
    });
    const suggest = decisions.filter((d) => d.step === 'core/storyboard-suggest');
    expect(suggest.map((d) => d.summary)).toEqual([
      'Suggested effect vignette: Pulls the eye to the parry',
      'Suggested sound impact: Lands the combo finisher',
      'Suggested transition whip: Snaps to the boss reveal',
      'Suggested sound whoosh: Carries the whip',
    ]);
    expect(suggest.every((d) => d.subject.kind === 'slot')).toBe(true);
  });

  it('fall back to defaults for params that do not fit, and leave out ids not installed', async () => {
    const r = {
      rationale: 'x',
      sections: [
        {
          name: 'A',
          role: 'hook',
          slots: [
            shot('Fire', {
              effect: { id: 'core/vignette', params: { strength: 7 }, why: 'Embers' },
            }),
            shot('B'),
            shot('C'),
          ],
        },
      ],
      music: { direction: '' },
    };
    const only = new FilterRegistry().register(vignette as never).register(crossfade as never);
    const { deps } = setup({ 'storyboard.generate': r }, only);
    const { storyboard, warnings } = await generateStoryboard(
      deps,
      Project.parse(sampleProject()),
      { template: releaseTemplate, targetDuration: 30 },
    );
    const fire = storyboard.sections.flatMap((s) => s.slots).find((s) => s.title === 'Fire')!;
    expect(fire.effects).toEqual([{ effectId: 'core/vignette', params: { strength: 0.5 } }]);
    expect(warnings).toContainEqual(
      expect.stringMatching(/settings suggested for core\/vignette did not fit/),
    );
  });

  it('come with a regenerated section too, and can be removed by hand', async () => {
    const section = {
      rationale: 'Sharper.',
      section: {
        name: 'Escalation',
        slots: [
          shot('One', { sound: { kind: 'sub-drop', position: 'end', why: 'Drop out' } }),
          shot('Two'),
          shot('Three'),
        ],
      },
    };
    const { deps } = setup({ 'storyboard.regenerate-section': section });
    const p = Project.parse(sampleProject());
    const target = p.storyboard!.sections[1]!;
    const { payload, decisions } = await regenerateSection(deps, p, { sectionId: target.id });
    expect(payload.sfxCues).toEqual([
      expect.objectContaining({ kind: 'sub-drop', position: 'end' }),
    ]);
    expect(decisions.some((d) => d.step === 'core/storyboard-suggest')).toBe(true);

    const dir = join(await mkdtemp(join(tmpdir(), 'tforge-suggest-')), 'S.tforge');
    const registry = coreCommands();
    for (const c of storyboardCommands) registry.register(c);
    const store = await ProjectStore.create(dir, sampleProject(), {
      commands: registry,
      autosaveMs: 0,
    });
    try {
      store.dispatch('core/storyboard.replace-section', payload);
      const cue = store.state.storyboard!.music.sfxCues.find((c) => c.kind === 'sub-drop')!;
      store.dispatch('core/storyboard.remove-sfx-cue', { cueId: cue.id });
      expect(store.state.storyboard!.music.sfxCues.some((c) => c.id === cue.id)).toBe(false);
      const slotId = payload.section.slots[1]!.id;
      store.dispatch('core/storyboard.add-sfx-cue', { slotId, kind: 'impact' });
      expect(store.state.storyboard!.music.sfxCues.at(-1)).toMatchObject({
        slotId,
        kind: 'impact',
        position: 'start',
      });
      store.dispatch('core/storyboard.update-slot', {
        slotId,
        patch: { effects: [{ effectId: 'core/grain', params: {} }] },
      });
      store.dispatch('core/storyboard.update-slot', { slotId, patch: { effects: [] } });
      expect(
        store.state.storyboard!.sections.flatMap((s) => s.slots).find((s) => s.id === slotId)!
          .effects,
      ).toEqual([]);
      void builtinFilters;
    } finally {
      await store.close();
    }
  });
});
