import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProject, shortTimelineId, type ShotSlot } from '@trailerforge/schema';
import { sampleConcept, sampleShortProject } from '@trailerforge/schema/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coreCommands } from './project-commands.js';
import { ProjectStore } from './store/project-store.js';

let store: ProjectStore;
beforeEach(async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'tforge-shorts-')), 'S.tforge');
  store = await ProjectStore.create(dir, sampleShortProject(), {
    commands: coreCommands(),
    autosaveMs: 0,
  });
});
afterEach(() => store.close());

const T = '2026-11-04T10:00:00.000Z';
const short = (id = 'short_parry') => store.state.shorts.find((s) => s.id === id)!;
const slot = (id: string) =>
  short()
    .storyboard!.sections.flatMap((s) => s.slots)
    .find((s) => s.id === id) as ShotSlot;
const vo = (id: string) => short().storyboard!.voLines.find((v) => v.id === id)!;
const valid = () => expect(parseProject(store.state).ok).toBe(true);

describe('core/concepts', () => {
  it('adds concepts with minted ids and the clock, and removes them; undoable', () => {
    const { id: _id, createdAt: _at, ...rest } = sampleConcept();
    store.dispatch('core/concepts.add', { concepts: [rest, { ...rest, title: 'Second idea' }] });
    expect(store.state.concepts.map((c) => c.id)).toEqual([
      'con_waiting',
      'con_parry_or_die',
      'con_second_idea',
    ]);
    expect(store.state.concepts[1]!.createdAt).toMatch(/^\d{4}-/);
    valid();
    store.dispatch('core/concepts.remove', { conceptIds: ['con_waiting'] });
    expect(store.state.concepts).toHaveLength(2);
    store.undo();
    store.undo();
    expect(store.state.concepts.map((c) => c.id)).toEqual(['con_waiting']);
  });

  it('refuses a used id, an unknown source and removing what is not there', () => {
    expect(() => store.dispatch('core/concepts.add', { concepts: [{ ...sampleConcept(), id: 'shot_parry' }] })).toThrow(/is used/); // prettier-ignore
    expect(() => store.dispatch('core/concepts.add', { concepts: [{ ...sampleConcept('con_x'), source: 'web' }] })).toThrow(); // prettier-ignore
    expect(() => store.dispatch('core/concepts.remove', { conceptIds: ['con_nope'] })).toThrow(/no concept/); // prettier-ignore
  });
});

describe('core/shorts', () => {
  it('picking a waiting concept makes a short at the 9:16 format target and takes it off the list', () => {
    store.dispatch('core/shorts.add', { conceptId: 'con_waiting', createdAt: T });
    const made = store.state.shorts[1]!;
    expect(made).toMatchObject({
      id: 'short_parry_or_die',
      name: 'Parry or die',
      createdAt: T,
      formatTargetId: 'fmt_tt',
      storyboard: null,
      concept: { id: 'con_waiting', source: 'app', title: 'Parry or die' },
    });
    expect(store.state.concepts).toEqual([]);
    valid();
    store.undo();
    expect(store.state.shorts).toHaveLength(1);
    expect(store.state.concepts).toHaveLength(1);
  });

  it('makes a short from the user’s own concept; exactly one source is required', () => {
    const { id: _id, createdAt: _at, ...rest } = sampleConcept();
    store.dispatch('core/shorts.add', { id: 'short_mine', name: 'Mine', concept: { ...rest, source: 'user' } }); // prettier-ignore
    expect(short('short_mine').concept).toMatchObject({ id: 'con_parry_or_die', source: 'user' });
    valid();
    expect(() => store.dispatch('core/shorts.add', {})).toThrow();
    expect(() => store.dispatch('core/shorts.add', { conceptId: 'con_waiting', concept: rest })).toThrow(); // prettier-ignore
    expect(() => store.dispatch('core/shorts.add', { conceptId: 'con_nope' })).toThrow(/no concept/); // prettier-ignore
    expect(() => store.dispatch('core/shorts.add', { id: 'short_parry', conceptId: 'con_waiting' })).toThrow(/is used/); // prettier-ignore
    expect(() => store.dispatch('core/shorts.add', { conceptId: 'con_waiting', formatTargetId: 'fmt_x' })).toThrow(/format target/); // prettier-ignore
  });

  it('renames (quick repeats merge), edits only the concept fields given, removes with its timeline', () => {
    store.dispatch('core/shorts.rename', { shortId: 'short_parry', name: 'Parry' });
    store.dispatch('core/shorts.rename', { shortId: 'short_parry', name: 'Parry!' });
    expect(short().name).toBe('Parry!');
    store.undo();
    expect(short().name).toBe('Parry or die');

    store.dispatch('core/shorts.set-concept', { shortId: 'short_parry', concept: { hook: 'New hook', targetSeconds: 30 } }); // prettier-ignore
    expect(short().concept).toMatchObject({ hook: 'New hook', targetSeconds: 30, title: 'Parry or die' }); // prettier-ignore
    expect(short().concept.voiceover).toHaveLength(2);
    expect(() => store.dispatch('core/shorts.set-concept', { shortId: 'short_parry', concept: { hook: '' } })).toThrow(); // prettier-ignore

    store.dispatch('core/timeline.set', {
      timeline: {
        id: shortTimelineId('short_parry'),
        name: 'Parry',
        resolution: { width: 1080, height: 1920 },
        frameRate: { num: 30, den: 1 },
        tracks: [],
      },
    });
    store.dispatch('core/shorts.remove', { shortId: 'short_parry' });
    expect(store.state.shorts).toEqual([]);
    expect(store.state.timelines.some((t) => t.id === shortTimelineId('short_parry'))).toBe(false);
    valid();
    store.undo();
    expect(short().storyboard).not.toBeNull();
  });

  it('sets and clears the storyboard and export settings; a storyboard with versions is refused', () => {
    const sb = short().storyboard!;
    store.dispatch('core/shorts.set-storyboard', { shortId: 'short_parry', storyboard: null });
    expect(short().storyboard).toBeNull();
    store.dispatch('core/shorts.set-storyboard', { shortId: 'short_parry', storyboard: sb });
    expect(short().storyboard!.id).toBe('sb_short_parry');
    expect(() => store.dispatch('core/shorts.set-storyboard', { shortId: 'short_parry', storyboard: { ...sb, variants: [{ id: 'v', formatTargetId: 'fmt_tt' }] } })).toThrow(/no versions/); // prettier-ignore
    store.dispatch('core/shorts.set-export', { shortId: 'short_parry', export: { presetId: 'core/vertical' } }); // prettier-ignore
    expect(short().export).toEqual({ presetId: 'core/vertical' });
    store.dispatch('core/shorts.set-export', { shortId: 'short_parry', export: null });
    expect(short().export).toBeUndefined();
  });
});

describe('core/shorts.fill-slot and clear-slot', () => {
  it('fills a picture slot with an accepted kind, adds the asset with a fitting role and chooses it', () => {
    store.dispatch('core/shorts.fill-slot', { shortId: 'short_parry', target: { slotId: 'sshot_art' }, assetId: 'asset_shot1', input: 'image', attachedAt: T }); // prettier-ignore
    expect(slot('sshot_art')).toMatchObject({
      status: 'recorded',
      chosenTakeId: 'take_shot1',
      takes: [{ id: 'take_shot1', assetId: 'asset_shot1', input: 'image', matchedBy: 'manual' }],
    });
    expect(store.state.assets.find((a) => a.assetId === 'asset_shot1')!.role).toBe('graphic');
    valid();
    store.undo();
    expect(slot('sshot_art').takes).toEqual([]);
    expect(store.state.assets.some((a) => a.assetId === 'asset_shot1')).toBe(false);
  });

  it('refuses kinds the slot does not take, voiceover in a picture slot, cards and missing templates', () => {
    const fill = (target: object, input: string) => () =>
      store.dispatch('core/shorts.fill-slot', { shortId: 'short_parry', target, assetId: 'asset_x', input }); // prettier-ignore
    expect(fill({ slotId: 'sshot_art' }, 'gameplay')).toThrow(/takes image or video, not gameplay/);
    expect(fill({ slotId: 'sshot_parry' }, 'voiceover')).toThrow(/takes gameplay/);
    expect(fill({ slotId: 'scard_cta' }, 'image')).toThrow(/is a card/);
    expect(fill({ voLineId: 'svo_2' }, 'video')).toThrow(/voiceover recording/);
    expect(fill({ slotId: 'nope' }, 'image')).toThrow(/no slot/);
    store.dispatch('core/shorts.set-storyboard', { shortId: 'short_parry', storyboard: null });
    expect(fill({ slotId: 'sshot_art' }, 'image')).toThrow(/no template yet/);
  });

  it('a trailer-style shot without accepts takes gameplay only', () => {
    const sb = structuredClone(short().storyboard!);
    delete (sb.sections[0]!.slots[1] as { accepts?: unknown }).accepts;
    store.dispatch('core/shorts.set-storyboard', { shortId: 'short_parry', storyboard: sb });
    expect(() => store.dispatch('core/shorts.fill-slot', { shortId: 'short_parry', target: { slotId: 'sshot_art' }, assetId: 'asset_x', input: 'video' })).toThrow(/takes gameplay/); // prettier-ignore
  });

  it('voiceover: a part of one long take per line; filling with the same file again re-chooses it with the new in/out', () => {
    const fill = (voLineId: string, sourceIn: number, sourceOut: number) =>
      store.dispatch('core/shorts.fill-slot', { shortId: 'short_parry', target: { voLineId }, assetId: 'asset_vo', input: 'voiceover', sourceIn, sourceOut }); // prettier-ignore
    fill('svo_2', 1000, 2000);
    expect(vo('svo_2')).toMatchObject({ status: 'recorded', takes: [{ assetId: 'asset_vo', sourceIn: 1000, sourceOut: 2000 }] }); // prettier-ignore
    fill('svo_2', 1500, 2500);
    expect(vo('svo_2').takes).toHaveLength(1);
    expect(vo('svo_2').takes[0]).toMatchObject({ sourceIn: 1500, sourceOut: 2500 });
    valid();
    expect(() => fill('svo_2', 3000, 2000)).toThrow();
  });

  it('a second file becomes another take and is chosen; clearing one falls back, clearing all empties', () => {
    store.dispatch('core/shorts.fill-slot', { shortId: 'short_parry', target: { slotId: 'sshot_parry' }, assetId: 'asset_shot2', input: 'gameplay' }); // prettier-ignore
    expect(slot('sshot_parry').takes.map((t) => t.id)).toEqual(['stake_forest', 'take_shot2']);
    expect(slot('sshot_parry').chosenTakeId).toBe('take_shot2');
    store.dispatch('core/shorts.clear-slot', { shortId: 'short_parry', target: { slotId: 'sshot_parry' }, takeId: 'take_shot2' }); // prettier-ignore
    expect(slot('sshot_parry').chosenTakeId).toBeUndefined();
    expect(slot('sshot_parry').status).toBe('recorded');
    store.dispatch('core/shorts.clear-slot', { shortId: 'short_parry', target: { slotId: 'sshot_parry' } }); // prettier-ignore
    expect(slot('sshot_parry')).toMatchObject({ takes: [], status: 'empty' });
    valid();
    expect(() => store.dispatch('core/shorts.clear-slot', { shortId: 'short_parry', target: { voLineId: 'svo_1' }, takeId: 'nope' })).toThrow(/no take/); // prettier-ignore
  });

  it('places several voiceover lines from one recording as one step, marked as suggested', () => {
    store.dispatch('core/shorts.fill-voice', {
      shortId: 'short_parry',
      lines: [
        { voLineId: 'svo_1', assetId: 'asset_take', sourceIn: 100, sourceOut: 900 },
        { voLineId: 'svo_2', assetId: 'asset_take', sourceIn: 1000, sourceOut: 1800 },
      ],
    });
    expect(vo('svo_1').takes.at(-1)).toMatchObject({ assetId: 'asset_take', sourceIn: 100, sourceOut: 900, matchedBy: 'suggestion', input: 'voiceover' }); // prettier-ignore
    expect(vo('svo_1').chosenTakeId).toBe(vo('svo_1').takes.at(-1)!.id);
    expect(vo('svo_2')).toMatchObject({ status: 'recorded', takes: [{ sourceIn: 1000, sourceOut: 1800 }] }); // prettier-ignore
    expect(store.state.assets.find((a) => a.assetId === 'asset_take')!.role).toBe('voiceover');
    valid();
    store.undo();
    expect(vo('svo_2').takes).toEqual([]);
    expect(() => store.dispatch('core/shorts.fill-voice', { shortId: 'short_parry', lines: [{ voLineId: 'svo_1', assetId: 'a', sourceIn: 5, sourceOut: 5 }] })).toThrow(); // prettier-ignore
    expect(() => store.dispatch('core/shorts.fill-voice', { shortId: 'short_parry', lines: [{ voLineId: 'sshot_parry', assetId: 'a', sourceIn: 0, sourceOut: 5 }] })).toThrow(/no voiceover line/); // prettier-ignore
  });

  it('subtitles: on/off, style and platform; cue edits upsert, merge, clear and reset', () => {
    expect(short().subtitles).toEqual({ enabled: false, style: 'lines', edits: [] });
    expect(short().platform).toBe('tiktok');
    store.dispatch('core/shorts.set-subtitles', { shortId: 'short_parry', enabled: true, style: 'word-pop', platform: 'reels' }); // prettier-ignore
    expect(short()).toMatchObject({
      platform: 'reels',
      subtitles: { enabled: true, style: 'word-pop' },
    });
    expect(() => store.dispatch('core/shorts.set-subtitles', { shortId: 'short_parry' })).toThrow();

    const edit = (o: object) => store.dispatch('core/shorts.edit-cue', { shortId: 'short_parry', key: 'svo_1#0', words: 'this boss has', ...o }); // prettier-ignore
    edit({ text: 'This boss has' });
    edit({ nudgeIn: -2000 });
    expect(short().subtitles.edits).toEqual([{ key: 'svo_1#0', words: 'this boss has', text: 'This boss has', nudgeIn: -2000 }]); // prettier-ignore
    edit({ text: null });
    expect(short().subtitles.edits).toEqual([{ key: 'svo_1#0', words: 'this boss has', nudgeIn: -2000 }]); // prettier-ignore
    edit({ nudgeIn: null });
    expect(short().subtitles.edits).toEqual([]);
    // Quick edits of one cue are one undo step.
    store.undo();
    expect(short().subtitles.edits).toEqual([]);
    expect(short().subtitles.enabled).toBe(true);

    edit({ text: 'A' });
    store.dispatch('core/shorts.edit-cue', { shortId: 'short_parry', key: 'svo_2#1', words: 'x', text: 'B' }); // prettier-ignore
    store.dispatch('core/shorts.reset-cues', { shortId: 'short_parry', keys: ['svo_2#1'] });
    expect(short().subtitles.edits.map((e) => e.key)).toEqual(['svo_1#0']);
    store.dispatch('core/shorts.reset-cues', { shortId: 'short_parry' });
    expect(short().subtitles.edits).toEqual([]);
    expect(() => edit({ nudgeOut: 10 * 705_600_000 })).toThrow();
    expect(() => store.dispatch('core/shorts.edit-cue', { shortId: 'short_parry', key: 'bad key', words: '', text: 'x' })).toThrow(); // prettier-ignore
    valid();
  });

  it('a short is a version: export settings, comments and approvals use its id, and removing it drops them', () => {
    store.dispatch('core/export.set', { variantId: 'short_parry', presetId: 'core/tiktok', fileName: '{project}-tiktok' }); // prettier-ignore
    expect(short().export).toEqual({ presetId: 'core/tiktok', fileName: '{project}-tiktok' });
    store.dispatch('core/export.reset', { variantId: 'short_parry' });
    expect(short().export).toBeUndefined();
    store.dispatch('core/review.comment', {
      variantId: 'short_parry',
      at: 0,
      text: 'Hook is slow',
    });
    store.dispatch('core/review.approve', { variantId: 'short_parry', planHash: 'a'.repeat(64) });
    expect(store.state.review.approvals.map((a) => a.variantId)).toEqual(['short_parry']);
    valid();
    expect(() => store.dispatch('core/review.comment', { variantId: 'short_nope', at: 0, text: 'x' })).toThrow(/no version/); // prettier-ignore
    expect(() => store.dispatch('core/export.set', { variantId: 'short_nope', presetId: 'core/tiktok' })).toThrow(/no version/); // prettier-ignore
    store.dispatch('core/shorts.remove', { shortId: 'short_parry' });
    expect(store.state.review).toEqual({ comments: [], approvals: [] });
    valid();
  });

  it('music: a track (for timing only, if asked) and a tapped-in tempo; the music option of an export', () => {
    store.dispatch('core/shorts.set-grid', { shortId: 'short_parry', patch: { tempo: 128, offset: 1000 } }); // prettier-ignore
    expect(short().storyboard!.music.grid).toMatchObject({ tempo: 128, offset: 1000 });
    store.dispatch('core/shorts.set-grid', { shortId: 'short_parry', patch: { tempo: null } });
    expect(short().storyboard!.music.grid?.tempo).toBeUndefined();
    const id = 'ast_ref';
    store.dispatch('core/shorts.set-music', { shortId: 'short_parry', assetId: id, timingOnly: true }); // prettier-ignore
    expect(short().storyboard!.music).toMatchObject({ trackAssetId: id, timingOnly: true });
    expect(store.state.assets.some((a) => a.assetId === id && a.role === 'music')).toBe(true);
    store.dispatch('core/shorts.set-music', { shortId: 'short_parry', assetId: id });
    expect(short().storyboard!.music.timingOnly).toBeUndefined();
    store.dispatch('core/shorts.set-music', { shortId: 'short_parry', assetId: null });
    expect(short().storyboard!.music.trackAssetId).toBeUndefined();
    store.dispatch('core/export.set', { variantId: 'short_parry', presetId: 'core/tiktok', music: 'without' }); // prettier-ignore
    expect(short().export).toEqual({ presetId: 'core/tiktok', music: 'without' });
    store.dispatch('core/export.set', { variantId: 'short_parry', music: null });
    expect(short().export).toEqual({ presetId: 'core/tiktok' });
    valid();
  });
});
