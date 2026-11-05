import type { LibraryAsset, Timeline } from '@trailerforge/schema';
import type { Engine } from './engine.js';

type Reuse = LibraryAsset['reuseHistory'][number];

/** The (asset, shot) pairs a timeline uses: every library recording or sound on a clip. */
export function usedAssets(timeline: Timeline): { assetId: string; slotId?: string }[] {
  const seen = new Set<string>();
  const out: { assetId: string; slotId?: string }[] = [];
  for (const track of timeline.tracks)
    for (const item of track.items) {
      if (item.kind !== 'clip') continue;
      const key = `${item.assetId}\u0000${item.slotId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ assetId: item.assetId, ...(item.slotId ? { slotId: item.slotId } : {}) });
    }
  return out;
}

/**
 * An export counts as "using" the footage: add a `reuseHistory` entry to each library asset the
 * exported timeline plays (one per asset and shot per export). Drafts, rough cuts and quality
 * checks never call this. Assets no longer in the library are skipped. Returns how many assets
 * got an entry.
 */
export async function recordReuse(
  engine: Engine,
  projectId: string,
  timeline: Timeline,
  now: Date,
): Promise<number> {
  const usedAt = now.toISOString();
  const byAsset = new Map<string, string[]>();
  for (const { assetId, slotId } of usedAssets(timeline))
    byAsset.set(assetId, [...(byAsset.get(assetId) ?? []), slotId ?? '']);
  let recorded = 0;
  for (const [assetId, slots] of byAsset) {
    if (!engine.library.get(assetId)) continue;
    const added: Reuse[] = slots.map((slotId) => ({
      projectId,
      ...(slotId ? { slotId } : {}),
      usedAt,
    }));
    await engine.library.update(assetId, (a) => ({
      ...a,
      reuseHistory: [...a.reuseHistory, ...added],
    }));
    recorded++;
  }
  return recorded;
}

export interface AssetUse {
  projectId: string;
  /** From the project list; null when the project is no longer known. */
  projectName: string | null;
  exports: number;
  lastUsedAt: string;
}

/** Where a recording was used in an export, one row per project, most recent first. */
export function assetUsage(engine: Engine, asset: Pick<LibraryAsset, 'reuseHistory'>): AssetUse[] {
  const rows = new Map<string, AssetUse>();
  // One export writes all its entries with one timestamp; count distinct timestamps.
  const stamps = new Map<string, Set<string>>();
  for (const r of asset.reuseHistory) {
    const set = stamps.get(r.projectId) ?? new Set<string>();
    set.add(r.usedAt);
    stamps.set(r.projectId, set);
    const old = rows.get(r.projectId);
    rows.set(r.projectId, {
      projectId: r.projectId,
      projectName: engine.registry.byId(r.projectId)?.name ?? null,
      exports: 0,
      lastUsedAt: old && old.lastUsedAt > r.usedAt ? old.lastUsedAt : r.usedAt,
    });
  }
  for (const [id, set] of stamps) rows.get(id)!.exports = set.size;
  return [...rows.values()].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

/** Usage of one library recording (or all that were ever used). */
export function assetUsageOp(
  engine: Engine,
  assetId?: string,
): { assetId: string; name: string; uses: AssetUse[] }[] {
  return engine.library
    .list()
    .filter((a) => (assetId ? a.id === assetId : a.reuseHistory.length > 0))
    .map((a) => ({ assetId: a.id, name: a.originalName, uses: assetUsage(engine, a) }));
}
