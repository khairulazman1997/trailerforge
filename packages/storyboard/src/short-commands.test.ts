import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreCommands, ProjectStore } from '@trailerforge/core';
import { rebuildShortStoryboard } from '@trailerforge/pack-game-trailer';
import { parseProject, Project } from '@trailerforge/schema';
import { sampleShortProject } from '@trailerforge/schema/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storyboardCommands } from './commands.js';
import { shortStoryboardCommands } from './short-commands.js';
import { userEditedFields } from './user-edits.js';

let store: ProjectStore;
const SHORT = 'short_parry';
beforeEach(async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'tforge-shortsb-')), 'P.tforge');
  const registry = coreCommands();
  for (const c of [...storyboardCommands, ...shortStoryboardCommands]) registry.register(c);
  store = await ProjectStore.create(dir, Project.parse(sampleShortProject()), {
    commands: registry,
    autosaveMs: 0,
  });
  const short = store.state.shorts[0]!;
  const built = rebuildShortStoryboard({
    short: { ...short, concept: { ...short.concept, formatId: 'game-trailer/tiktok-voiceover' } },
  });
  store.dispatch('core/shorts.set-storyboard', { shortId: SHORT, storyboard: built.storyboard });
});
afterEach(() => store.close());

const sb = () => store.state.shorts[0]!.storyboard!;
const slot = (id: string) =>
  sb()
    .sections.flatMap((s) => s.slots)
    .find((x) => x.id === id)!;
const valid = () => expect(parseProject(store.state).ok).toBe(true);
const b1 = `${SHORT}_b1`;

describe('core/shorts.storyboard.* (the trailer’s storyboard commands, on a short)', () => {
  it('has a twin of every storyboard command except set', () => {
    const types = shortStoryboardCommands.map((c) => c.type);
    expect(types).toContain('core/shorts.storyboard.update-slot');
    expect(types).toContain('core/shorts.storyboard.replace-section');
    expect(types).not.toContain('core/shorts.storyboard.set');
    expect(types).toHaveLength(storyboardCommands.length - 1);
  });

  it('edits the short’s storyboard, marks the edit, leaves the trailer alone, and undoes', () => {
    const main = JSON.stringify(store.state.storyboard);
    store.dispatch('core/shorts.storyboard.update-slot', {
      shortId: SHORT,
      edit: { slotId: b1, patch: { title: 'My own beat' } },
    });
    expect(slot(b1).title).toBe('My own beat');
    expect(userEditedFields(slot(b1))).toEqual(['title']);
    expect(JSON.stringify(store.state.storyboard)).toBe(main);
    valid();
    store.undo();
    expect(slot(b1).title).not.toBe('My own beat');
    expect(userEditedFields(slot(b1))).toEqual([]);
  });

  it('a hand-edited slot survives a rebuild from a changed concept', () => {
    store.dispatch('core/shorts.storyboard.update-slot', {
      shortId: SHORT,
      edit: { slotId: b1, patch: { title: 'My own beat' } },
    });
    store.dispatch('core/shorts.set-concept', { shortId: SHORT, concept: { shotList: ['X', 'Y', 'Z'] } }); // prettier-ignore
    const short = store.state.shorts[0]!;
    const r = rebuildShortStoryboard({ short });
    expect(r.kept).toContain(b1);
    store.dispatch('core/shorts.set-storyboard', { shortId: SHORT, storyboard: r.storyboard });
    expect(slot(b1).title).toBe('My own beat');
    expect(slot(`${SHORT}_b2`).title).toBe('Y');
    valid();
  });

  it('respects locks, cleans up after removed slots, and takes comments', () => {
    const section = sb().sections[1]!;
    store.dispatch('core/shorts.storyboard.set-section-locked', { shortId: SHORT, edit: { sectionId: section.id, locked: true } }); // prettier-ignore
    expect(() => store.dispatch('core/shorts.storyboard.update-slot', { shortId: SHORT, edit: { slotId: b1, patch: { title: 'No' } } })).toThrow(/locked/); // prettier-ignore
    store.dispatch('core/shorts.storyboard.set-section-locked', { shortId: SHORT, edit: { sectionId: section.id, locked: false } }); // prettier-ignore

    expect(sb().voLines.some((v) => v.linkedSlotIds.includes(b1))).toBe(true);
    store.dispatch('core/shorts.storyboard.remove-slot', { shortId: SHORT, edit: { slotId: b1 } });
    expect(sb().voLines.some((v) => v.linkedSlotIds.includes(b1))).toBe(false);
    valid();

    store.dispatch('core/shorts.storyboard.comment', { shortId: SHORT, edit: { sectionId: section.id, text: 'Tighter.' } }); // prettier-ignore
    expect(sb().comments.map((c) => c.text)).toEqual(['Tighter.']);
    expect(store.state.storyboard!.comments).toEqual([]);
    valid();
  });

  it('says what is wrong: unknown short, no template', () => {
    const bad = (shortId: string) => () =>
      store.dispatch('core/shorts.storyboard.update-slot', { shortId, edit: { slotId: b1, patch: { title: 'x' } } }); // prettier-ignore
    expect(bad('short_nope')).toThrow(/no short/);
    store.dispatch('core/shorts.set-storyboard', { shortId: SHORT, storyboard: null });
    expect(bad(SHORT)).toThrow(/no template yet/);
    expect(store.state.storyboard).not.toBeNull();
  });
});
