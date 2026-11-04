import { Concept, Project, Storyboard, type Short } from '@trailerforge/schema';
import { sampleConcept, sampleShortProject } from '@trailerforge/schema/fixtures';
import { parseProject } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import {
  buildShortStoryboard,
  rebuildShortStoryboard,
  shortTemplates,
  TIKTOK_FORMAT_IDS,
} from './index.js';

const concept = () => ({
  ...sampleConcept(),
  shotList: ['A perfect parry on the Ash Warden', 'The key art', 'A phone clip of the dev playing'],
  voiceover: ['This boss has one tell.', 'Miss it and you are done.', 'Wishlist Ember Knight.'],
});
const picture = (sb: Storyboard) =>
  sb.sections.flatMap((s) => s.slots).filter((x) => x.kind === 'shot');

function shortWith(formatId: string, targetSeconds = 20): Short {
  const base = Project.parse(sampleShortProject()).shorts[0]!;
  const c = Concept.parse({ ...concept(), formatId, targetSeconds });
  return { ...base, concept: c, storyboard: null };
}
const rebuilt = (s: Short, extra: object = {}) => rebuildShortStoryboard({ short: s, ...extra });

describe.each(TIKTOK_FORMAT_IDS)('%s', (formatId) => {
  it.each([15, 20, 35, 60])('builds a valid storyboard of exactly %s s', (secs) => {
    const sb = Storyboard.parse(
      buildShortStoryboard({
        formatId,
        idPrefix: 'short_x',
        targetSeconds: secs,
        concept: concept(),
      }),
    );
    const total = sb.sections.flatMap((s) => s.slots).reduce((a, x) => a + x.duration.ideal, 0);
    expect(Math.round(total * 10) / 10).toBe(secs);
    expect(sb.meta).toMatchObject({ videoTypeId: 'game-trailer/tiktok', templateId: formatId });
    for (const x of sb.sections.flatMap((s) => s.slots)) {
      expect(x.duration.min).toBeLessThanOrEqual(x.duration.ideal);
      expect(x.duration.max).toBeGreaterThanOrEqual(x.duration.ideal);
    }
    // The hook is quick, whatever the length.
    expect(sb.sections[0]!.slots[0]!.duration.ideal).toBeLessThanOrEqual(2.5);
    expect(sb.sections.at(-1)!.role).toBe('end-slate');
  });

  it('is deterministic and every picture slot says what it accepts', () => {
    const o = { formatId, idPrefix: 'short_x', targetSeconds: 25, concept: concept() };
    expect(buildShortStoryboard(o)).toEqual(buildShortStoryboard(o));
    const sb = Storyboard.parse(buildShortStoryboard(o));
    for (const s of picture(sb)) expect(s.kind === 'shot' && s.accepts?.length).toBeGreaterThan(0);
  });

  it('fits a project: ids unique across the trailer and the short, within 64 characters', () => {
    const p = sampleShortProject();
    const id = 'x'.repeat(52);
    const sb = buildShortStoryboard({
      formatId,
      idPrefix: id,
      targetSeconds: 40,
      concept: concept(),
    });
    const ids = JSON.stringify(sb)
      .match(/"id":"([^"]+)"/g)!
      .map((m) => m.slice(6, -1));
    expect(Math.max(...ids.map((i) => i.length))).toBeLessThanOrEqual(64);
    expect(new Set(ids).size).toBe(ids.length);
    const short = { ...p.shorts![0]!, id, concept: { ...concept(), formatId }, storyboard: sb };
    const r = parseProject({ ...p, shorts: [short] });
    expect(r.ok ? [] : r.issues).toEqual([]);
  });
});

describe('seeding from the concept', () => {
  it('shot list → picture slots in order, hook → caption, extra lines → alternates of the last', () => {
    const c = { ...concept(), shotList: ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'] };
    const sb = Storyboard.parse(
      buildShortStoryboard({ formatId: 'game-trailer/tiktok-montage', idPrefix: 's', targetSeconds: 20, concept: c }), // prettier-ignore
    );
    const shots = picture(sb);
    expect(shots.map((s) => s.title).slice(1, 4)).toEqual(['One', 'Two', 'Three']);
    // The hook shot has its own instruction, so the list starts at the first montage shot.
    expect(shots[1]!.kind === 'shot' && shots[1]!.captureInstruction).toBe('One');
    const last = shots.at(-1)!;
    expect(last.kind === 'shot' && last.alternates).toEqual(['Four', 'Five', 'Six', 'Seven']);
    const hook = shots[0]!;
    expect(hook.kind === 'shot' && hook.overlays.map((o) => [o.templateId, o.text])).toEqual([
      ['core/caption', c.hook],
    ]);
  });

  it('long lines become short titles; the call to action comes from the brief', () => {
    const long = 'word '.repeat(30).trim();
    const sb = Storyboard.parse(
      buildShortStoryboard({ formatId: 'game-trailer/tiktok-progress', idPrefix: 's', targetSeconds: 20, concept: { ...concept(), shotList: [long] }, callToAction: 'Wishlist on Steam' }), // prettier-ignore
    );
    expect(picture(sb)[1]!.title.length).toBeLessThanOrEqual(61);
    expect(picture(sb)[1]!.title.endsWith('…')).toBe(true);
    const cta = sb.sections.at(-1)!.slots[0]!;
    expect(cta.kind === 'card' && cta.text).toBe('Wishlist on Steam');
    const dflt = Storyboard.parse(buildShortStoryboard({ formatId: 'game-trailer/tiktok-progress', idPrefix: 's', targetSeconds: 20 })); // prettier-ignore
    expect(dflt.sections.at(-1)!.slots[0]).toMatchObject({ text: 'Wishlist now' });
  });

  it('voiceover lines are spread in order over the voice section’s slots', () => {
    const sb = Storyboard.parse(
      buildShortStoryboard({ formatId: 'game-trailer/tiktok-voiceover', idPrefix: 's', targetSeconds: 25, concept: concept() }), // prettier-ignore
    );
    expect(sb.voLines.map((v) => [v.speaker, v.text, v.linkedSlotIds[0]])).toEqual([
      ['Dev', 'This boss has one tell.', 's_b1'],
      ['Dev', 'Miss it and you are done.', 's_b2'],
      ['Dev', 'Wishlist Ember Knight.', 's_b3'],
    ]);
    const none = Storyboard.parse(buildShortStoryboard({ formatId: 'game-trailer/tiktok-montage', idPrefix: 's', targetSeconds: 20, concept: { ...concept(), voiceover: [] } })); // prettier-ignore
    expect(none.voLines).toEqual([]);
  });

  it('longer cuts add the nice-to-have slots, shorter ones leave them out', () => {
    const count = (secs: number) =>
      picture(Storyboard.parse(buildShortStoryboard({ formatId: 'game-trailer/tiktok-montage', idPrefix: 's', targetSeconds: secs }))).length; // prettier-ignore
    expect([count(15), count(25), count(40)]).toEqual([4, 5, 6]);
    const sb = Storyboard.parse(buildShortStoryboard({ formatId: 'game-trailer/tiktok-montage', idPrefix: 's', targetSeconds: 40 })); // prettier-ignore
    expect(picture(sb).at(-1)!.priority).toBe('nice');
  });

  it('refuses an unknown format, a bad length and a too-long prefix', () => {
    expect(() => buildShortStoryboard({ formatId: 'game-trailer/tiktok-dance', idPrefix: 's', targetSeconds: 20 })).toThrow(/unknown TikTok format/); // prettier-ignore
    expect(() => buildShortStoryboard({ formatId: TIKTOK_FORMAT_IDS[0], idPrefix: 's', targetSeconds: 0 })).toThrow(); // prettier-ignore
    expect(() => buildShortStoryboard({ formatId: TIKTOK_FORMAT_IDS[0], idPrefix: 'x'.repeat(53), targetSeconds: 20 })).toThrow(/idPrefix/); // prettier-ignore
  });

  it('is registered as one template per format, for the TikTok video type', () => {
    expect(shortTemplates.map((t) => t.id)).toEqual(TIKTOK_FORMAT_IDS);
    expect(new Set(shortTemplates.map((t) => t.videoTypeId))).toEqual(new Set(['game-trailer/tiktok'])); // prettier-ignore
    expect(() => Storyboard.parse(shortTemplates[0]!.build({ targetDuration: 20 }))).not.toThrow();
  });
});

describe('rebuildShortStoryboard', () => {
  const fmt = 'game-trailer/tiktok-voiceover';

  it('builds everything the first time and is stable when nothing was touched', () => {
    const s = shortWith(fmt);
    const first = rebuilt(s);
    expect(first.kept).toEqual([]);
    expect(first.rebuilt).toHaveLength(picture(first.storyboard).length + 1);
    const again = rebuilt({ ...s, storyboard: first.storyboard });
    expect(again.kept).toEqual([]);
    expect({ ...again.storyboard, revision: 0 }).toEqual({ ...first.storyboard, revision: 0 });
    expect(again.storyboard.revision).toBe(first.storyboard.revision + 1);
  });

  it('keeps slots with recordings or hand edits, the rest follow the new concept', () => {
    const s0 = shortWith(fmt);
    const sb = structuredClone(rebuilt(s0).storyboard);
    const [hook, b1, b2] = picture(sb);
    if (hook?.kind !== 'shot' || b1?.kind !== 'shot' || b2?.kind !== 'shot') throw new Error('x');
    b1.takes.push({ id: 'tk1', assetId: 'asset_forest', matchedBy: 'manual', rejected: false, note: '', input: 'gameplay', attachedAt: '2026-11-04T10:00:00.000Z' } as never); // prettier-ignore
    b1.status = 'recorded';
    b2.title = 'My own title';
    b2.extensions = { core: { userEdited: ['title'] } };
    const s1 = { ...s0, storyboard: sb, concept: { ...s0.concept, shotList: ['New A', 'New B', 'New C'], hook: 'New hook' } }; // prettier-ignore
    const r = rebuilt(s1);
    const after = picture(r.storyboard);
    expect(r.kept).toEqual([b1.id, b2.id]);
    expect(after[1]).toBe(after.find((x) => x.id === b1.id));
    expect(after.find((x) => x.id === b1.id)!.kind === 'shot' && (after.find((x) => x.id === b1.id) as never as { takes: unknown[] }).takes).toHaveLength(1); // prettier-ignore
    expect(after.find((x) => x.id === b2.id)!.title).toBe('My own title');
    // The untouched hook slot picked up the new hook text.
    const newHook = after.find((x) => x.id === hook.id)!;
    expect(newHook.kind === 'shot' && newHook.overlays[0]!.text).toBe('New hook');
    expect(r.rebuilt).toContain(hook.id);
  });

  it('leaves locked sections, sections not asked for, and the user’s own slots alone', () => {
    const s0 = shortWith(fmt);
    const sb = structuredClone(rebuilt(s0).storyboard);
    sb.sections[1]!.locked = true;
    const own = { ...structuredClone(sb.sections[0]!.slots[0]!), id: 'mine', title: 'Mine' };
    sb.sections[0]!.slots.push(own);
    const s1 = { ...s0, storyboard: sb, concept: { ...s0.concept, shotList: ['X', 'Y', 'Z'] } };
    const r = rebuilt(s1);
    expect(r.storyboard.sections[1]!.locked).toBe(true);
    expect(r.storyboard.sections[1]).toEqual(sb.sections[1]);
    expect(r.storyboard.sections[0]!.slots.map((x) => x.id)).toContain('mine');
    expect(r.kept).toContain('mine');

    const onlyEnd = rebuilt(s1, { sectionIds: [sb.sections.at(-1)!.id] });
    expect(onlyEnd.rebuilt).toEqual([sb.sections.at(-1)!.slots[0]!.id]);
    expect(onlyEnd.storyboard.sections[0]).toEqual(sb.sections[0]);
  });

  it('voiceover lines follow the concept unless they have recordings; those stay', () => {
    const s0 = shortWith(fmt);
    const sb = structuredClone(rebuilt(s0).storyboard);
    sb.voLines[0]!.takes.push({ id: 'vt1', assetId: 'asset_vo', matchedBy: 'manual', rejected: false, note: '', input: 'voiceover', attachedAt: '2026-11-04T10:00:00.000Z' } as never); // prettier-ignore
    const concept2 = { ...s0.concept, voiceover: ['Brand new first line.'] };
    const r = rebuilt({ ...s0, storyboard: sb, concept: concept2 });
    expect(r.storyboard.voLines.map((v) => v.text)).toEqual(['This boss has one tell.']);
    expect(r.storyboard.voLines[0]!.takes).toHaveLength(1);
    const noTakes = rebuilt({ ...s0, storyboard: rebuilt(s0).storyboard, concept: concept2 });
    expect(noTakes.storyboard.voLines.map((v) => v.text)).toEqual(['Brand new first line.']);
  });

  it('stays valid in a project and keeps the format in the meta', () => {
    const p = sampleShortProject();
    const s = shortWith('game-trailer/tiktok-list', 30);
    const r = rebuilt(s);
    const short = { ...p.shorts![0]!, concept: s.concept, storyboard: r.storyboard };
    const ok = parseProject({ ...p, shorts: [short] });
    expect(ok.ok ? [] : ok.issues).toEqual([]);
    expect(r.storyboard.meta.templateId).toBe('game-trailer/tiktok-list');
  });
});
