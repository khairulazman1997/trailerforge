import { describe, expect, it } from 'vitest';
import { sampleProject } from './fixtures.js';
import { Project } from './project.js';
import { parseProject, validateProjectRefs } from './refs.js';

const parsed = () => Project.parse(sampleProject());

describe('Project', () => {
  it('parses the sample project', () => {
    expect(parseProject(sampleProject())).toMatchObject({ ok: true });
  });

  it('round-trips through JSON unchanged', () => {
    const p = parsed();
    const again = Project.parse(JSON.parse(JSON.stringify(p)));
    expect(again).toEqual(p);
  });

  it('defaults campaign fields for the future Planner', () => {
    const { campaignId: _c, scheduledDate: _d, status: _s, ...rest } = sampleProject();
    const p = Project.parse(rest);
    expect(p.campaignId).toBeNull();
    expect(p.scheduledDate).toBeNull();
    expect(p.status).toBe('idea');
  });

  it('rejects a wrong schema version', () => {
    expect(Project.safeParse({ ...sampleProject(), schemaVersion: 0 }).success).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    expect(Project.safeParse({ ...sampleProject(), stray: true }).success).toBe(false);
  });

  it('keeps plugin extension data verbatim', () => {
    expect(parsed().brief.extensions['game-trailer']).toEqual({
      genre: 'action RPG',
      gamePlatforms: ['PC', 'PS5'],
    });
  });
});

describe('validateProjectRefs', () => {
  it('reports nothing for the sample project', () => {
    expect(validateProjectRefs(parsed())).toEqual([]);
  });

  it('reports dangling asset, slot, format and variant references', () => {
    const p = parsed();
    const tl = p.timelines[0]!;
    const items = tl.tracks[0]!.items;
    const first = items[0]!;
    if (first.kind !== 'clip') throw new Error('fixture changed');
    first.assetId = 'asset_gone';
    items[1]!.slotId = 'slot_gone';
    tl.formatTargetId = 'fmt_gone';
    tl.variantId = 'var_gone';
    p.storyboard!.variants[0]!.formatTargetId = 'fmt_gone';
    p.storyboard!.music.hitPoints[0]!.slotId = 'slot_gone';

    const messages = validateProjectRefs(p).map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'unknown asset "asset_gone"',
        'unknown slot "slot_gone"',
        'unknown format target "fmt_gone"',
        'unknown variant "var_gone"',
      ]),
    );
    expect(messages.length).toBeGreaterThanOrEqual(6);
  });

  it('reports duplicate ids across the project', () => {
    const p = parsed();
    p.timelines[0]!.tracks[1]!.id = 'trk_v1';
    expect(validateProjectRefs(p)[0]?.message).toMatch(/duplicate id "trk_v1"/);
  });

  it('detects nested-sequence cycles', () => {
    const p = parsed();
    const base = p.timelines[0]!;
    const nest = (id: string, target: string) => ({
      ...base,
      id,
      name: id,
      tracks: [
        {
          id: `trk_${id}`,
          kind: 'video' as const,
          name: '',
          muted: false,
          locked: false,
          transitions: [],
          items: [
            {
              id: `it_${id}`,
              kind: 'sequence' as const,
              timelineId: target,
              start: 0,
              duration: 100,
              sourceIn: 0,
              effects: [],
              extensions: {},
            },
          ],
        },
      ],
    });
    p.timelines.push(nest('tl_a', 'tl_b'), nest('tl_b', 'tl_a'));
    const cycle = validateProjectRefs(p).find((i) => i.message.includes('cycle'));
    expect(cycle?.message).toMatch(/tl_a -> tl_b -> tl_a|tl_b -> tl_a -> tl_b/);
  });

  it('parseProject surfaces schema errors with paths', () => {
    const bad = sampleProject();
    bad.formatTargets![0]!.resolution.width = -1;
    const r = parseProject(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe('formatTargets.0.resolution.width');
  });
});

describe('knowledge references', () => {
  it('reports unknown entities on slots and unknown sources on entities', () => {
    const p = parsed();
    p.knowledge[0]!.sourceId = 'src_gone';
    const slot = p.storyboard!.sections[1]!.slots[0]!;
    slot.entityIds.push('ent_gone');
    const messages = validateProjectRefs(p).map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining(['unknown source "src_gone"', 'unknown knowledge entity "ent_gone"']),
    );
  });

  it('defaults entity curation flags', () => {
    const e = parsed().knowledge[1]!;
    expect(e).toMatchObject({
      origin: 'user',
      excludedFromLlm: false,
      confidence: 1,
      sourcePaths: [],
    });
  });
});
