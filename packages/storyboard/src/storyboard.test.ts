import { mkdtemp, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendDecisions,
  coreCommands,
  ProjectStore,
  projectPaths,
  readDecisions,
} from '@trailerforge/core';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { releaseTemplate } from '@trailerforge/pack-game-trailer';
import { mintId, parseProject, Project, type Storyboard } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { storyboardCommands } from './commands.js';
import { fitToBudget } from './convert.js';
import { generateStoryboard, regenerateSection } from './generate.js';

const NOW = () => new Date('2026-10-23T12:00:00Z');

const genReply = {
  rationale: 'Opens on the parry, escalates to the Warden, ends on the date.',
  sections: [
    {
      name: 'Hook',
      role: 'hook',
      slots: [
        {
          kind: 'shot',
          title: 'Perfect parry',
          seconds: 3,
          captureInstruction: 'Parry the Warden in phase 2, no HUD.',
          hud: 'off',
          entityIds: ['ent_warden', 'ent_made_up'],
          voLine: { text: 'Every blow can be answered.' },
        },
      ],
    },
    {
      name: 'Escalation',
      role: 'escalation',
      slots: [
        { kind: 'shot', title: 'Forest run', seconds: 4, entityIds: ['ent_forest'] },
        { kind: 'shot', title: 'Boss reveal', seconds: 5 },
      ],
    },
    {
      name: 'End slate',
      role: 'end-slate',
      slots: [{ kind: 'card', cardKind: 'title', title: 'Title', text: 'Ashfall', seconds: 2 }],
    },
  ],
  music: { direction: 'Hybrid orchestral', bpm: { min: 140, max: 120 } },
};

const sectionReply = {
  rationale: 'Leads with the forest before the boss.',
  section: {
    name: 'Escalation v2',
    slots: [
      { kind: 'shot', title: 'Forest run', seconds: 2 },
      { kind: 'shot', title: 'Warden lands', seconds: 2, entityIds: ['ent_warden'] },
      { kind: 'shot', title: 'First swing', seconds: 2 },
    ],
  },
};

function setup(replies: Record<string, unknown>) {
  const mock = createMockProvider(replies);
  const llm = new LlmClient({
    providers: (id) => (id === 'core/mock' ? mock : undefined),
    routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
  });
  return { mock, deps: { llm, now: NOW } };
}

function project(storyboard?: null) {
  const p = sampleProject();
  p.knowledge = [
    ...(p.knowledge ?? []),
    {
      id: 'ent_secret',
      kind: 'boss',
      name: 'Secret Final Boss',
      origin: 'user',
      excludedFromLlm: true,
    },
  ];
  if (storyboard === null) {
    p.storyboard = null;
    for (const t of p.timelines ?? [])
      for (const k of t.tracks ?? []) for (const i of k.items ?? []) delete i.slotId;
  }
  return Project.parse(p);
}

const total = (sb: Storyboard) =>
  Math.round(sb.sections.flatMap((s) => s.slots).reduce((a, s) => a + s.duration.ideal, 0) * 10) /
  10;

async function openStore(p: Project) {
  const dir = join(await mkdtemp(join(tmpdir(), 'tforge-sb-')), 'P.tforge');
  const registry = coreCommands();
  for (const c of storyboardCommands) registry.register(c);
  return ProjectStore.create(dir, p, { commands: registry, autosaveMs: 0 });
}

describe('conversion helpers', () => {
  it('fits durations to the budget exactly, at 0.1 s resolution', () => {
    const out = fitToBudget([1, 1, 1], 10);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 9);
    expect(out.every((v) => Math.round(v * 10) === v * 10)).toBe(true);
    expect(fitToBudget([100, 0.01], 5)[1]).toBe(0.1);
    expect(() => fitToBudget([1, 1], 0.1)).toThrow(RangeError);
  });

  it('mints unique, valid ids', () => {
    const taken = new Set(['sh_boss']);
    expect(mintId('sh', 'Boss!', taken)).toBe('sh_boss_2');
    expect(mintId('sh', '???', taken)).toBe('sh_x');
  });
});

describe('generateStoryboard', () => {
  it('builds a valid storyboard from a fresh brief and logs the decision', async () => {
    const { mock, deps } = setup({ 'storyboard.generate': genReply });
    const p = project(null);
    const { storyboard, decisions } = await generateStoryboard(deps, p, {
      template: releaseTemplate,
      targetDuration: 30,
    });
    expect(total(storyboard)).toBe(30);
    expect(storyboard.meta).toMatchObject({
      videoTypeId: 'game-trailer/release-trailer',
      templateId: 'game-trailer/tpl-release',
      targetDuration: 30,
    });
    const slots = storyboard.sections.flatMap((s) => s.slots);
    expect(slots[0]?.entityIds).toEqual(['ent_warden']); // invented id dropped
    const card = slots.at(-1);
    expect(card?.kind === 'card' && card.templateId).toBe('core/title-card'); // from the template
    expect(storyboard.voLines[0]?.linkedSlotIds).toEqual([slots[0]?.id]);
    expect(storyboard.music.bpm).toEqual({ min: 120, max: 140 });

    const prompt = mock.calls[0]!.prompt;
    expect(prompt).toMatch(/The Ash Warden/);
    expect(prompt).not.toMatch(/Secret Final Boss/);
    expect(prompt).toMatch(/fill 30 seconds/);

    // Through the store: timeline items that filled the old slots are unlinked, not broken.
    const store = await openStore(p);
    try {
      const state = store.dispatch('core/storyboard.set', storyboard);
      expect(parseProject(state).ok).toBe(true);
      expect(
        state.timelines.flatMap((t) => t.tracks.flatMap((k) => k.items)).some((i) => i.slotId),
      ).toBe(false);
    } finally {
      await store.close();
    }

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      step: 'core/storyboard-generate',
      subject: { kind: 'storyboard', id: storyboard.id },
      summary: genReply.rationale,
      reasons: { provider: 'core/mock', requestedSeconds: 14, budget: 30 },
    });
  });

  it('keeps locked sections verbatim and in place, generating only the remaining time', async () => {
    const { mock, deps } = setup({ 'storyboard.generate': genReply });
    const p = project();
    const lockedBefore = p.storyboard!.sections.find((s) => s.locked)!;
    const { storyboard } = await generateStoryboard(deps, p, {
      template: releaseTemplate,
      targetDuration: 60,
    });
    expect(storyboard.sections.at(-1)).toEqual(lockedBefore);
    expect(storyboard.sections.filter((s) => s.id === lockedBefore.id)).toHaveLength(1);
    expect(total(storyboard)).toBe(60);
    expect(storyboard.revision).toBe(p.storyboard!.revision + 1);
    expect(mock.calls[0]!.prompt).toMatch(/fill 57 seconds/);
    // The reply's own end slate was dropped in favour of the locked one.
    expect(storyboard.sections.map((s) => s.role)).toEqual(['hook', 'escalation', 'end-slate']);

    const store = await openStore(p);
    try {
      const state = store.dispatch('core/storyboard.set', storyboard);
      expect(parseProject(state).ok).toBe(true);
      expect(state.storyboard?.sections.at(-1)).toEqual(lockedBefore);
      // Timeline items that filled the replaced slots are unlinked, not left dangling.
      const linked = state.timelines
        .flatMap((t) => t.tracks.flatMap((k) => k.items))
        .filter((i) => i.slotId);
      expect(linked.every((i) => i.slotId === 'card_end')).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('repairs an invalid first reply', async () => {
    const { mock, deps } = setup({ 'storyboard.generate': [{ sections: [] }, genReply] });
    await generateStoryboard(deps, project(null), {
      template: releaseTemplate,
      targetDuration: 30,
    });
    expect(mock.calls).toHaveLength(2);
  });
});

describe('regenerateSection', () => {
  it('replaces one section in the same time, leaving the others untouched', async () => {
    const { deps } = setup({ 'storyboard.regenerate-section': sectionReply });
    const p = project();
    const sb = p.storyboard!;
    const { payload, decisions } = await regenerateSection(deps, p, {
      sectionId: 'sec_escalation',
      instruction: 'more forest',
    });
    expect(payload.section.id).toBe('sec_escalation');
    expect(payload.section.role).toBe('escalation');

    const store = await openStore(p);
    try {
      const next = store.dispatch('core/storyboard.replace-section', payload).storyboard!;
      const idx = sb.sections.findIndex((s) => s.id === 'sec_escalation');
      sb.sections.forEach((s, i) => {
        if (i !== idx) expect(next.sections[i]).toEqual(s);
      });
      const seconds = (s: Storyboard['sections'][number]) =>
        s.slots.reduce((a, x) => a + x.duration.ideal, 0);
      expect(seconds(next.sections[idx]!)).toBeCloseTo(seconds(sb.sections[idx]!), 9);
      // shot_boss is gone, so its hit point and SFX cue go with it; the hook's VO line stays.
      expect(next.music.hitPoints).toEqual([]);
      expect(next.music.sfxCues).toEqual([]);
      expect(next.voLines.map((v) => v.id)).toEqual(['vo_1']);
      expect(next.revision).toBe(sb.revision + 1);
      expect(parseProject(store.state).ok).toBe(true);
    } finally {
      await store.close();
    }
    expect(decisions[0]).toMatchObject({
      step: 'core/storyboard-regenerate-section',
      subject: { kind: 'section', id: 'sec_escalation' },
      reasons: { instruction: 'more forest', replacedSlotIds: ['shot_boss'] },
    });
  });

  it('refuses locked sections, both when generating and when dispatching', async () => {
    const { mock, deps } = setup({ 'storyboard.regenerate-section': sectionReply });
    const p = project();
    await expect(regenerateSection(deps, p, { sectionId: 'sec_end' })).rejects.toThrow(/locked/);
    expect(mock.calls).toHaveLength(0);

    const store = await openStore(p);
    try {
      const { payload } = await regenerateSection(deps, p, { sectionId: 'sec_escalation' });
      expect(() =>
        store.dispatch('core/storyboard.replace-section', { ...payload, sectionId: 'sec_end' }),
      ).toThrow(/locked/);
      const edited = structuredClone(p.storyboard!) as Storyboard;
      edited.sections.at(-1)!.name = 'Changed';
      expect(() => store.dispatch('core/storyboard.set', edited)).toThrow(/locked/);
      store.dispatch('core/storyboard.set-section-locked', { sectionId: 'sec_end', locked: false });
      store.dispatch('core/storyboard.set', edited);
      expect(store.state.storyboard?.sections.at(-1)?.name).toBe('Changed');
    } finally {
      await store.close();
    }
  });
});

describe('decision log', () => {
  it('appends validated records and tolerates a torn tail', async () => {
    const { deps } = setup({ 'storyboard.generate': genReply });
    const { decisions } = await generateStoryboard(deps, project(null), {
      template: releaseTemplate,
      targetDuration: 30,
    });
    const paths = projectPaths(join(await mkdtemp(join(tmpdir(), 'tforge-dec-')), 'P.tforge'));
    await appendDecisions(paths.decisions, decisions);
    await appendFile(paths.decisions, '{"id":"dec_torn","at":');
    expect(await readDecisions(paths.decisions)).toEqual(decisions);
  });
});
