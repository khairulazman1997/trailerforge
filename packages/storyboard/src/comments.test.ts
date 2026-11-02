import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreCommands, ProjectStore } from '@trailerforge/core';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { parseProject, Project } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { storyboardCommands } from './commands.js';
import { commentedSectionIds, openComments } from './comments.js';
import { regenerateSection } from './generate.js';
import { markUserEdited } from './user-edits.js';

const NOW = () => new Date('2026-11-02T12:00:00Z');
const AT = '2026-11-01T10:00:00.000Z';

const sectionReply = {
  rationale: 'Moves the boss reveal later, as asked.',
  section: {
    name: 'Escalation',
    slots: [
      { kind: 'shot', title: 'Forest run', seconds: 1 },
      { kind: 'shot', title: 'Warden lands', seconds: 1 },
    ],
  },
};

function setup() {
  const mock = createMockProvider({ 'storyboard.regenerate-section': sectionReply });
  const llm = new LlmClient({
    providers: (id) => (id === 'core/mock' ? mock : undefined),
    routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
  });
  return { mock, deps: { llm, now: NOW } };
}

const stores: ProjectStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function openStore(p = Project.parse(sampleProject())) {
  const dir = join(await mkdtemp(join(tmpdir(), 'tforge-sbc-')), 'P.tforge');
  const registry = coreCommands();
  for (const c of storyboardCommands) registry.register(c);
  const store = await ProjectStore.create(dir, p, { commands: registry, autosaveMs: 0 });
  stores.push(store);
  return store;
}

const comments = (s: ProjectStore) => s.state.storyboard!.comments;

describe('storyboard comments', () => {
  it('adds, edits, resolves and deletes comments on sections and slots, all undoable', async () => {
    const store = await openStore();
    store.dispatch('core/storyboard.comment', {
      id: 'sbc_a',
      slotId: 'shot_boss',
      text: '  Too early for the boss  ',
      createdAt: AT,
    });
    store.dispatch('core/storyboard.comment', {
      id: 'sbc_b',
      sectionId: 'sec_end',
      text: 'Needs a date',
      createdAt: AT,
    });
    expect(comments(store)[0]).toEqual({
      id: 'sbc_a',
      sectionId: 'sec_escalation',
      slotId: 'shot_boss',
      slotLabel: expect.any(String),
      text: 'Too early for the boss',
      resolved: false,
      createdAt: AT,
    });
    // Commenting on a locked section is fine: a note does not change it.
    expect(store.state.storyboard!.sections.find((s) => s.id === 'sec_end')!.locked).toBe(true);
    expect(commentedSectionIds(store.state.storyboard!)).toEqual(['sec_escalation', 'sec_end']);
    const revision = store.state.storyboard!.revision;

    store.dispatch('core/storyboard.edit-comment', { commentId: 'sbc_b', text: 'Add the date' });
    store.dispatch('core/storyboard.resolve-comment', { commentId: 'sbc_b' });
    expect(openComments(store.state.storyboard!, 'sec_end')).toEqual([]);
    store.dispatch('core/storyboard.delete-comment', { commentId: 'sbc_a' });
    expect(comments(store).map((c) => c.id)).toEqual(['sbc_b']);
    expect(store.state.storyboard!.revision).toBe(revision);
    expect(parseProject(store.state).ok).toBe(true);

    store.undo();
    store.undo();
    expect(comments(store).map((c) => [c.id, c.resolved])).toEqual([
      ['sbc_a', false],
      ['sbc_b', false],
    ]);
    expect(() =>
      store.dispatch('core/storyboard.comment', {
        sectionId: 'sec_hook',
        slotId: 'shot_boss',
        text: 'x',
      }),
    ).toThrow(/not in section/);
    expect(() => store.dispatch('core/storyboard.comment', { text: 'x' })).toThrow(/which section/);
  });

  it('follows its slot when it moves, and stays on the section when the slot goes', async () => {
    const store = await openStore();
    store.dispatch('core/storyboard.comment', { id: 'sbc_a', slotId: 'shot_boss', text: 'Hmm' });
    store.dispatch('core/storyboard.move-slot', { slotId: 'shot_boss', toSectionId: 'sec_hook' });
    expect(comments(store)[0]).toMatchObject({ sectionId: 'sec_hook', slotId: 'shot_boss' });
    store.dispatch('core/storyboard.remove-slot', { slotId: 'shot_boss' });
    expect(comments(store)[0]!.slotId).toBeUndefined();
    expect(comments(store)[0]!.sectionId).toBe('sec_hook');
    expect(parseProject(store.state).ok).toBe(true);
    store.dispatch('core/storyboard.remove-section', { sectionId: 'sec_hook' });
    expect(comments(store)).toEqual([]);
  });

  it('survives a new storyboard while its section does', async () => {
    const store = await openStore();
    store.dispatch('core/storyboard.comment', { id: 'sbc_a', sectionId: 'sec_end', text: 'Keep' });
    store.dispatch('core/storyboard.comment', { id: 'sbc_b', sectionId: 'sec_hook', text: 'Gone' });
    const next = structuredClone(store.state.storyboard!);
    next.sections = next.sections.filter((s) => s.id === 'sec_end');
    next.comments = [];
    next.voLines = [];
    next.music.structure = [];
    next.music.hitPoints = [];
    next.music.sfxCues = [];
    next.variants = [];
    store.dispatch('core/storyboard.set', next);
    expect(comments(store).map((c) => c.id)).toEqual(['sbc_a']);
  });
});

describe('rewriting a section from its comments', () => {
  it('sends the open comments, rewrites commented hand-edited slots and resolves the comments', async () => {
    const { mock, deps } = setup();
    const store = await openStore();
    store.dispatch('core/storyboard.update-slot', {
      slotId: 'shot_boss',
      patch: { title: 'Boss intro' },
    });
    store.dispatch('core/storyboard.comment', {
      id: 'sbc_a',
      slotId: 'shot_boss',
      text: 'Show the arena first',
    });
    store.dispatch('core/storyboard.comment', {
      id: 'sbc_b',
      sectionId: 'sec_escalation',
      text: 'More tension',
    });
    store.dispatch('core/storyboard.comment', {
      id: 'sbc_c',
      sectionId: 'sec_escalation',
      text: 'Old',
    });
    store.dispatch('core/storyboard.resolve-comment', { commentId: 'sbc_c' });

    const { payload, decisions } = await regenerateSection(deps, store.state, {
      sectionId: 'sec_escalation',
    });
    const prompt = mock.calls[0]!.prompt;
    expect(prompt).toContain('- on slot #1 "Boss intro": Show the arena first');
    expect(prompt).toContain('- on the whole section: More tension');
    expect(prompt).not.toContain('Old');
    expect(prompt).not.toContain('shot_boss');
    // The hand-edited slot has a comment, so it is rewritten rather than kept.
    expect(payload.section.slots.map((s) => s.id)).not.toContain('shot_boss');
    expect(payload.addressedCommentIds).toEqual(['sbc_a', 'sbc_b']);
    expect(decisions[0]!.reasons.comments).toHaveLength(2);

    store.dispatch('core/storyboard.replace-section', payload);
    const after = comments(store);
    expect(after.find((c) => c.id === 'sbc_a')).toMatchObject({
      resolved: true,
      addressedAt: NOW().toISOString(),
      slotLabel: 'Boss intro',
    });
    expect(after.find((c) => c.id === 'sbc_a')!.slotId).toBeUndefined();
    expect(after.find((c) => c.id === 'sbc_b')!.resolved).toBe(true);
    expect(parseProject(store.state).ok).toBe(true);

    // One undo step brings back the old section and the open comments.
    store.undo();
    expect(openComments(store.state.storyboard!, 'sec_escalation').map((c) => c.id)).toEqual([
      'sbc_a',
      'sbc_b',
    ]);
  });

  it('leaves comments out when asked to, and keeps hand-edited slots without comments', async () => {
    const { mock, deps } = setup();
    const p = Project.parse(sampleProject());
    const esc = p.storyboard!.sections.find((s) => s.id === 'sec_escalation')!;
    esc.slots.push({ ...structuredClone(esc.slots[0]!), id: 'shot_extra', title: 'Extra' });
    markUserEdited(esc.slots[1]!, ['title']);
    p.storyboard!.comments.push({
      id: 'sbc_a',
      sectionId: 'sec_escalation',
      text: 'Faster',
      resolved: false,
      createdAt: AT,
    });
    const { payload } = await regenerateSection(deps, p, {
      sectionId: 'sec_escalation',
      useComments: false,
    });
    expect(mock.calls[0]!.prompt).not.toContain('Faster');
    expect(payload.addressedCommentIds).toEqual([]);
    expect(payload.section.slots.map((s) => s.id)).toContain('shot_extra');
  });
});
