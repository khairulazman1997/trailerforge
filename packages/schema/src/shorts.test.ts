import { describe, expect, it } from 'vitest';
import { sampleConcept, sampleProject, sampleShortProject } from './fixtures.js';
import { Project } from './project.js';
import { findAssetUsages, parseProject } from './refs.js';
import { Concept, Short, shortTimelineId } from './shorts.js';

const issuesOf = (input: unknown) => {
  const r = parseProject(input);
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
};

describe('concepts and shorts', () => {
  it('a project without them parses with empty lists (no schema-version bump)', () => {
    const p = Project.parse(sampleProject());
    expect(p.concepts).toEqual([]);
    expect(p.shorts).toEqual([]);
  });

  it('the sample short project passes the schema and every cross-reference check', () => {
    const r = parseProject(sampleShortProject());
    expect(r.ok ? [] : r.issues).toEqual([]);
    const p = Project.parse(sampleShortProject());
    const sb = p.shorts[0]!.storyboard!;
    expect(sb.voLines[0]!.takes[0]!.input).toBe('voiceover');
    expect(sb.voLines[1]!.takes).toEqual([]);
    const art = sb.sections[0]!.slots[1]!;
    expect(art.kind === 'shot' && art.accepts).toEqual(['image', 'video']);
  });

  it('a trailer shot needs no accepts list; an empty one is refused', () => {
    const shot = Project.parse(sampleProject()).storyboard!.sections[0]!.slots[0]!;
    expect(shot.kind === 'shot' && shot.accepts).toBeUndefined();
    const p = sampleShortProject();
    (p.shorts![0]!.storyboard!.sections![0]!.slots![1] as { accepts: string[] }).accepts = [];
    expect(Project.safeParse(p).success).toBe(false);
  });

  it('concepts: trimmed text, bounded lists and lengths, a known source', () => {
    const c = Concept.parse({ ...sampleConcept(), title: '  Parry  ' });
    expect(c.title).toBe('Parry');
    expect(Concept.safeParse({ ...sampleConcept(), source: 'twitter' }).success).toBe(false);
    expect(Concept.safeParse({ ...sampleConcept(), hook: ' ' }).success).toBe(false);
    expect(Concept.safeParse({ ...sampleConcept(), targetSeconds: 400 }).success).toBe(false);
    expect(Concept.safeParse({ ...sampleConcept(), shotList: Array(13).fill('x') }).success).toBe(false); // prettier-ignore
    expect(Concept.safeParse({ ...sampleConcept(), extra: 1 }).success).toBe(false);
    expect(Concept.parse({ ...sampleConcept(), voiceover: undefined }).voiceover).toEqual([]);
  });

  it('short ids leave room for the timeline prefix', () => {
    const base = sampleShortProject().shorts![0]!;
    expect(Short.safeParse({ ...base, id: 'a'.repeat(52) }).success).toBe(true);
    expect(Short.safeParse({ ...base, id: 'a'.repeat(53) }).success).toBe(false);
    expect(shortTimelineId('a'.repeat(52)).length).toBeLessThanOrEqual(64);
    expect(shortTimelineId('short_parry')).toBe('tl_short_short_parry');
  });

  it('reports broken references inside shorts', () => {
    const p = sampleShortProject();
    const sh = p.shorts![0]!;
    sh.formatTargetId = 'fmt_nope';
    sh.storyboard!.voLines![0]!.takes![0]!.assetId = 'asset_gone';
    sh.storyboard!.voLines![1]!.chosenTakeId = 'svtake_nope';
    sh.storyboard!.voLines![1]!.linkedSlotIds = ['shot_parry']; // the trailer's slot, not the short's
    sh.storyboard!.sections![0]!.slots![0]!.entityIds = ['ent_nope'];
    sh.storyboard!.variants = [{ id: 'var_x', formatTargetId: 'fmt_tt' }];
    expect(issuesOf(p)).toEqual(
      expect.arrayContaining([
        'shorts[0]: unknown format target "fmt_nope"',
        'shorts[0].storyboard.voLines[0].takes[0]: unknown asset "asset_gone"',
        'shorts[0].storyboard.voLines[1].chosenTakeId: unknown take "svtake_nope"',
        'shorts[0].storyboard.voLines[1]: unknown slot "shot_parry"',
        'shorts[0].storyboard.sections[0].slots[0]: unknown knowledge entity "ent_nope"',
        'shorts[0].storyboard: a short has no versions',
      ]),
    );
  });

  it('ids are unique across the trailer, concepts and shorts', () => {
    const p = sampleShortProject();
    p.concepts![0]!.id = 'shot_parry';
    p.shorts![0]!.storyboard!.sections![1]!.id = 'sec_hook';
    const issues = issuesOf(p);
    expect(issues.some((i) => i.startsWith('concepts[0]: duplicate id "shot_parry"'))).toBe(true);
    expect(issues.some((i) => i.startsWith('shorts[0].storyboard.sections[1]: duplicate id "sec_hook"'))).toBe(true); // prettier-ignore
  });

  it('timeline items may name a short’s slot', () => {
    const p = sampleShortProject();
    p.timelines = [
      {
        id: shortTimelineId('short_parry'),
        name: 'Parry or die',
        resolution: { width: 1080, height: 1920 },
        frameRate: { num: 30, den: 1 },
        tracks: [
          {
            id: 'trk_v1',
            kind: 'video',
            items: [
              { id: 'it_1', kind: 'clip', assetId: 'asset_keyart', slotId: 'sshot_art', start: 0, duration: 705600000, sourceIn: 0 }, // prettier-ignore
            ],
          },
        ],
      },
    ];
    expect(issuesOf(p)).toEqual([]);
  });

  it('asset usages include short takes and voiceover takes', () => {
    const p = Project.parse(sampleShortProject());
    expect(findAssetUsages(p, 'asset_forest')).toContain('shorts[0].storyboard.sections[0].slots[0].takes[0]'); // prettier-ignore
    expect(findAssetUsages(p, 'asset_vo')).toEqual(['shorts[0].storyboard.voLines[0].takes[0]']);
  });
});
