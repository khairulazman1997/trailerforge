import { describe, expect, it } from 'vitest';
import { sampleProject } from './fixtures.js';
import { AssetLibrary, LibraryAsset } from './media.js';
import { findAssetUsages, parseProject } from './refs.js';
import { Take } from './storyboard.js';

const T = '2026-10-24T10:00:00Z';
const H = (c: string) => c.repeat(64);

function withTakes(takes: unknown[], chosenTakeId?: string) {
  const p = sampleProject() as unknown as {
    storyboard: { sections: { slots: Record<string, unknown>[] }[] };
  };
  const shot = p.storyboard.sections[0]!.slots[0]!;
  shot['takes'] = takes;
  if (chosenTakeId) shot['chosenTakeId'] = chosenTakeId;
  return p;
}
const take = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  assetId: 'asset_forest',
  matchedBy: 'code',
  attachedAt: T,
  ...extra,
});

describe('takes on shots', () => {
  it('existing projects without takes still parse, with empty defaults', () => {
    const r = parseProject(sampleProject());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const shot = r.project.storyboard!.sections[0]!.slots[0]!;
    expect(shot.kind === 'shot' && shot.takes).toEqual([]);
    expect(shot.kind === 'shot' && shot.chosenTakeId).toBeUndefined();
  });

  it('accepts takes and a chosen take', () => {
    const r = parseProject(
      withTakes([take('take_1'), take('take_2', { rejected: true })], 'take_1'),
    );
    expect(r).toMatchObject({ ok: true });
  });

  it('flags unknown assets, duplicate ids, unknown or rejected chosen takes', () => {
    const issues = (doc: unknown) => {
      const r = parseProject(doc);
      return r.ok ? [] : r.issues.map((i) => i.message);
    };
    expect(issues(withTakes([take('take_1', { assetId: 'asset_gone' })]))).toEqual([
      'unknown asset "asset_gone"',
    ]);
    expect(issues(withTakes([take('take_1'), take('take_1')])).join()).toMatch(/duplicate id/);
    expect(issues(withTakes([take('take_1')], 'take_x'))).toEqual(['unknown take "take_x"']);
    expect(issues(withTakes([take('take_1', { rejected: true })], 'take_1'))).toEqual([
      'take "take_1" is rejected',
    ]);
  });

  it('validates in/out hints as ordered integer flicks', () => {
    expect(Take.safeParse(take('t', { sourceIn: 10, sourceOut: 20 })).success).toBe(true);
    expect(Take.safeParse(take('t', { sourceIn: 20, sourceOut: 10 })).success).toBe(false);
    expect(Take.safeParse(take('t', { sourceIn: 1.5 })).success).toBe(false);
  });

  it('finds every usage of an asset', () => {
    const r = parseProject(withTakes([take('take_1')]));
    if (!r.ok) throw new Error('fixture');
    expect(findAssetUsages(r.project, 'asset_forest')).toEqual(
      expect.arrayContaining(['storyboard.sections[0].slots[0].takes[0]']),
    );
    expect(findAssetUsages(r.project, 'asset_music')).toContain('storyboard.music.trackAssetId');
    expect(findAssetUsages(r.project, 'asset_unused')).toEqual([]);
  });
});

describe('asset library', () => {
  const asset = (id: string, quickHash: string) =>
    LibraryAsset.parse({
      id,
      kind: 'video',
      uri: `/rec/${id}.mp4`,
      quickHash,
      sizeBytes: 10,
      originalName: `${id}.mp4`,
      addedAt: T,
    });

  it('requires unique ids and quick hashes', () => {
    const ok = { schemaVersion: 1, assets: [asset('a', H('a')), asset('b', H('b'))] };
    expect(AssetLibrary.safeParse(ok).success).toBe(true);
    const dupId = { schemaVersion: 1, assets: [asset('a', H('a')), asset('a', H('b'))] };
    expect(AssetLibrary.safeParse(dupId).success).toBe(false);
    const dupHash = { schemaVersion: 1, assets: [asset('a', H('a')), asset('b', H('a'))] };
    expect(AssetLibrary.safeParse(dupHash).success).toBe(false);
    expect(AssetLibrary.safeParse({ schemaVersion: 2, assets: [] }).success).toBe(false);
  });
});
