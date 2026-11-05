import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Timeline } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from './engine.js';
import { assetUsage, assetUsageOp, recordReuse, usedAssets } from './reuse-ops.js';

let home: string;
let engine: Engine;
let footage: string;
let music: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tforge-reuse-'));
  engine = await Engine.start({ home, autosaveMs: 0 });
  await writeFile(join(home, 'a.mp4'), 'footage bytes');
  await writeFile(join(home, 'b.wav'), 'music bytes');
  footage = (await engine.library.importFile(join(home, 'a.mp4'))).asset.id;
  music = (await engine.library.importFile(join(home, 'b.wav'))).asset.id;
});
afterEach(() => engine.close());

/** The fixture cut with its two recordings swapped for the library's. */
function cut(): Timeline {
  const tl = structuredClone(Timeline.parse(sampleProject().timelines![0]));
  for (const track of tl.tracks)
    for (const item of track.items)
      if (item.kind === 'clip') item.assetId = item.assetId === 'asset_music' ? music : footage;
  return Timeline.parse(tl);
}

describe('reuse history', () => {
  it('lists each recording once per shot', () => {
    expect(usedAssets(cut())).toEqual([
      { assetId: footage, slotId: 'shot_parry' },
      { assetId: music },
    ]);
  });

  it('adds one entry per asset and shot per export, and counts exports per project', async () => {
    const at = new Date('2026-11-06T10:00:00Z');
    expect(await recordReuse(engine, 'proj_a', cut(), at)).toBe(2);
    await recordReuse(engine, 'proj_a', cut(), new Date('2026-11-06T11:00:00Z'));
    await recordReuse(engine, 'proj_b', cut(), new Date('2026-11-06T12:00:00Z'));
    const clip = engine.library.get(footage)!;
    expect(clip.reuseHistory).toHaveLength(3);
    expect(clip.reuseHistory[0]).toEqual({
      projectId: 'proj_a',
      slotId: 'shot_parry',
      usedAt: '2026-11-06T10:00:00.000Z',
    });
    expect(engine.library.get(music)!.reuseHistory[0]).not.toHaveProperty('slotId');
    expect(assetUsage(engine, clip)).toEqual([
      {
        projectId: 'proj_b',
        projectName: null,
        exports: 1,
        lastUsedAt: '2026-11-06T12:00:00.000Z',
      },
      {
        projectId: 'proj_a',
        projectName: null,
        exports: 2,
        lastUsedAt: '2026-11-06T11:00:00.000Z',
      },
    ]);
    // Persisted, and only used recordings are listed without an id.
    expect(
      assetUsageOp(engine)
        .map((a) => a.assetId)
        .sort(),
    ).toEqual([footage, music].sort());
  });

  it('skips recordings that left the library and names known projects', async () => {
    const store = await engine.createProject(join(home, 'P.tforge'), { name: 'Pilot' });
    await engine.library.remove(music);
    expect(await recordReuse(engine, store.state.id, cut(), new Date())).toBe(1);
    expect(assetUsageOp(engine, footage)[0]!.uses[0]).toMatchObject({ projectName: 'Pilot' });
  });
});
