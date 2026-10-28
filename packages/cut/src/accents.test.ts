import { generatedCatalog } from '@trailerforge/effects';
import {
  FLICKS_PER_SECOND,
  Project,
  Timeline,
  flicksPerFrame,
  itemEnd,
  type ShotSlot,
} from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { withDucks } from './accents.js';
import { resolveMusicGrid } from './grid.js';
import { mergeRoughCut } from './merge.js';
import { buildRoughCut, timelineHash, type RoughCutInput, type TakeSource } from './rough-cut.js';
import { steady } from './test-support.js';

const F = FLICKS_PER_SECOND;
const RATE = { num: 30, den: 1 };
const FPF = flicksPerFrame(RATE);

function input(edit?: (p: Project) => void): RoughCutInput {
  const p = Project.parse(sampleProject());
  edit?.(p);
  const sb = p.storyboard!;
  const shots = sb.sections.flatMap((s) => s.slots).filter((s): s is ShotSlot => s.kind === 'shot');
  for (const s of shots)
    s.takes = [
      {
        id: `take_${s.id}`,
        assetId: `asset_${s.id}`,
        matchedBy: 'code',
        rejected: false,
        note: '',
        attachedAt: '2026-10-28T10:00:00.000Z',
      },
    ];
  const sources = new Map<string, TakeSource>(
    shots.map((s) => [`asset_${s.id}`, { duration: 20 * F }]),
  );
  return {
    storyboard: sb,
    grid: resolveMusicGrid(steady(120, 64)),
    sources,
    timeline: { id: 'tl_rough', frameRate: RATE, resolution: { width: 1920, height: 1080 } },
    now: new Date('2026-10-28T12:00:00Z'),
  };
}
const slot = (p: Project, id: string) =>
  p.storyboard!.sections.flatMap((s) => s.slots).find((s) => s.id === id)!;
const picture = (t: Timeline) => t.tracks.find((k) => k.id === 'trk_picture')!;
const itemOf = (t: Timeline, slotId: string) => picture(t).items.find((i) => i.slotId === slotId)!;

describe("the storyboard's accents on the rough cut", () => {
  it("puts a slot's effects on its items and its transition between it and the shot before, each with a decision", () => {
    const cut = buildRoughCut(
      input((p) => {
        const boss = slot(p, 'shot_boss');
        boss.transitionIn = {
          transitionId: 'core/whip',
          duration: 0.25,
          params: { direction: 'left', blur: 0.03 },
        };
        boss.effects = [{ effectId: 'core/vignette', params: { strength: 0.6 } }];
      }),
    );
    const boss = itemOf(cut.timeline, 'shot_boss');
    const parry = itemOf(cut.timeline, 'shot_parry');
    expect(boss.kind === 'clip' && boss.effects).toEqual([
      { id: `${boss.id}_fx1`, effectId: 'core/vignette', enabled: true, params: { strength: 0.6 } },
    ]);
    expect(parry.kind === 'clip' && parry.effects).toEqual([]); // most slots carry nothing
    const [tr, ...rest] = picture(cut.timeline).transitions;
    expect(rest).toEqual([]);
    expect(tr).toMatchObject({
      id: 'tr_shot_boss',
      transitionId: 'core/whip',
      fromItemId: parry.id,
      toItemId: boss.id,
    });
    expect(tr!.duration % FPF).toBe(0);
    expect(Math.abs(tr!.duration - 0.25 * F)).toBeLessThanOrEqual(FPF);
    expect(itemEnd(parry)).toBe(boss.start);
    const why = (id: string) => cut.decisions.find((d) => d.subject.id === id)?.summary;
    expect(why('tr_shot_boss')).toMatch(
      /^Whip pan into "Boss reveal" over 0\.2\d? s, as the storyboard asks$/,
    );
    expect(why(`${boss.id}_fx1`)).toMatch(/Effect vignette on .* as the storyboard asks/);
    expect(tr!.decisionId).toBe(cut.decisions.find((d) => d.subject.id === 'tr_shot_boss')!.id);
    // The same inputs give the same cut.
    expect(
      timelineHash(
        buildRoughCut(
          input((p) => {
            const b = slot(p, 'shot_boss');
            b.transitionIn = {
              transitionId: 'core/whip',
              duration: 0.25,
              params: { direction: 'left', blur: 0.03 },
            };
            b.effects = [{ effectId: 'core/vignette', params: { strength: 0.6 } }];
          }),
        ).timeline,
      ),
    ).toBe(timelineHash(cut.timeline));
  });

  it('refuses a transition that would flash more than three times a second, and says why', () => {
    const cut = buildRoughCut(
      input((p) => {
        slot(p, 'shot_boss').transitionIn = {
          transitionId: 'core/glitch',
          duration: 1,
          params: { rate: 8, shift: 0.02 },
        };
      }),
    );
    expect(picture(cut.timeline).transitions).toEqual([]);
    expect(cut.warnings).toContainEqual(
      expect.stringMatching(/glitch was left out: .*flash more than three times in a second/),
    );
  });

  it('says when a transition cannot be placed (a card on its own track) or is not installed', () => {
    const cut = buildRoughCut(
      input((p) => {
        slot(p, 'card_end').transitionIn = { transitionId: 'core/dip', duration: 0.5, params: {} };
        slot(p, 'shot_boss').transitionIn = {
          transitionId: 'acme/star-wipe',
          duration: 0.5,
          params: {},
        };
      }),
    );
    expect(cut.warnings).toContainEqual(
      expect.stringMatching(/dip transition needs the item before it on the same track/),
    );
    expect(cut.warnings).toContainEqual(
      expect.stringMatching(/acme\/star-wipe is not installed; a hard cut instead/),
    );
    expect(cut.timeline.tracks.every((t) => t.transitions.length === 0)).toBe(true);
  });

  it('places the sound cues on the audio, ducks the music under them, and explains each', () => {
    const bare = buildRoughCut(input());
    expect(bare.warnings).toContainEqual(
      '1 sound cue is not placed: no sound effects are set up yet',
    );
    const catalog = generatedCatalog();
    const assetIds = new Map(catalog.map((o) => [o.id, `asset_${o.kind}`]));
    const base = input((p) => {
      p.storyboard!.music.sfxCues.push({
        id: 'sfx_hit',
        kind: 'impact',
        slotId: 'shot_boss',
        position: 'start',
      });
    });
    const cut = buildRoughCut({ ...base, options: { sound: { catalog, assetIds } } });
    const sfx = cut.timeline.tracks.filter((t) => t.id.startsWith('trk_sfx'));
    expect(sfx.flatMap((t) => t.items.map((i) => i.id)).sort()).toEqual([
      'sfx_sfx_hit',
      'sfx_sfx_whoosh',
    ]);
    for (const t of sfx) expect(t.kind).toBe('audio');
    const music = cut.timeline.tracks.find((t) => t.id === 'trk_music')!.items[0]!;
    const gain = music.kind === 'clip' ? music.gainDb : 0;
    expect(
      typeof gain === 'object' &&
        !Array.isArray(gain) &&
        gain.keyframes.some((k) => (k.value as number) < 0 && (k.value as number) > -60),
    ).toBe(true);
    expect(cut.decisions.find((d) => d.subject.id === 'sfx_sfx_hit')?.summary).toMatch(
      /^Impact sound: impact on the music's hit point/,
    );
    expect(() => Timeline.parse(cut.timeline)).not.toThrow();
  });

  it('keeps hand-edited effects when the cut is rebuilt', () => {
    const edit = (p: Project) => {
      slot(p, 'shot_boss').effects = [{ effectId: 'core/vignette', params: {} }];
      slot(p, 'shot_boss').transitionIn = {
        transitionId: 'core/crossfade',
        duration: 0.5,
        params: {},
      };
    };
    const first = buildRoughCut(input(edit));
    const boss = itemOf(first.timeline, 'shot_boss');
    // The user swaps the vignette for grain on the timeline (what `core/timeline.set-effects` does).
    const edited: Timeline = {
      ...first.timeline,
      tracks: first.timeline.tracks.map((t) => ({
        ...t,
        items: t.items.map((i) =>
          i.id === boss.id && i.kind === 'clip'
            ? {
                ...i,
                effects: [
                  {
                    id: 'fx_mine',
                    effectId: 'core/grain',
                    enabled: true,
                    params: { strength: 20 },
                  },
                ],
                extensions: { core: { userEdited: true } },
              }
            : i,
        ),
      })),
    };
    const again = input(edit);
    const merged = mergeRoughCut(edited, buildRoughCut(again).timeline, again.sources);
    const kept = itemOf(merged.timeline, 'shot_boss');
    expect(kept.kind === 'clip' && kept.effects.map((e) => e.effectId)).toEqual(['core/grain']);
    expect(picture(merged.timeline).transitions.map((t) => t.transitionId)).toEqual([
      'core/crossfade',
    ]);
    expect(() => Timeline.parse(merged.timeline)).not.toThrow();
  });
});

describe('hand-set transitions on a rebuild', () => {
  it("stay, while the storyboard's own transition into the same clip wins", () => {
    const plain = (p: Project) => {
      delete slot(p, 'shot_parry').transitionOut; // the sample flashes out of the parry shot
    };
    const first = buildRoughCut(input(plain));
    const [a, b, c] = first.timeline.tracks.find((k) => k.id === 'trk_picture')!.items;
    const mine = {
      id: 'tr_mine',
      transitionId: 'core/dip',
      fromItemId: a!.id,
      toItemId: b!.id,
      duration: 3 * FPF,
      params: {},
    };
    const edited: Timeline = {
      ...first.timeline,
      tracks: first.timeline.tracks.map((t) =>
        t.id === 'trk_picture' ? { ...t, transitions: [mine] } : t,
      ),
    };
    const again = input(plain);
    const merged = mergeRoughCut(edited, buildRoughCut(again).timeline, again.sources);
    expect(picture(merged.timeline).transitions.map((t) => t.id)).toContain('tr_mine');
    // The storyboard asks for a whip into that same clip: its transition replaces the hand-set one.
    const withWhip = input((p) => {
      plain(p);
      const slotId = b!.slotId!;
      slot(p, slotId).transitionIn = { transitionId: 'core/whip', duration: 0.25, params: {} };
    });
    const m2 = mergeRoughCut(edited, buildRoughCut(withWhip).timeline, withWhip.sources);
    expect(
      picture(m2.timeline)
        .transitions.filter((t) => t.toItemId === b!.id)
        .map((t) => t.transitionId),
    ).toEqual(['core/whip']);
    void c;
  });
});

describe('withDucks', () => {
  it('dips the music under each duck and keeps the fade at the end', () => {
    const fade = {
      keyframes: [
        { at: 90 * FPF, value: 0, easing: 'linear' as const },
        { at: 120 * FPF, value: -60, easing: 'linear' as const },
      ],
    };
    const g = withDucks(
      fade,
      [
        { start: 30 * FPF, duration: 15 * FPF, db: 4 },
        { start: 100 * FPF, duration: 10 * FPF, db: 3 },
      ],
      0,
      120 * FPF,
      2 * FPF,
    );
    expect(
      typeof g === 'object' && !Array.isArray(g) && g.keyframes.map((k) => [k.at / FPF, k.value]),
    ).toEqual([
      [28, 0],
      [30, -4],
      [45, -4],
      [47, 0],
      [90, 0],
      [120, -60],
    ]); // the second duck reached into the fade and was left out
    expect(withDucks(0, [], 0, 10, 1)).toBe(0);
  });
});
