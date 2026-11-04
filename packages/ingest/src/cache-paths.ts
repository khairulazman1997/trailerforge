import { join } from 'node:path';

/**
 * Previews of a library asset live under the app home, shared by every project that uses the
 * asset and keyed by its quick hash, so a moved or re-imported file keeps them. They are cache:
 * always safe to delete, and rebuilt on demand.
 */
export function assetCachePaths(home: string, quickHash: string) {
  const dir = join(home, 'library', 'cache', quickHash);
  return {
    dir,
    thumbnail: join(dir, 'thumb.jpg'),
    filmstrip: join(dir, 'filmstrip.jpg'),
    proxy: join(dir, 'proxy.mp4'),
    /** The editing copy of an image: a JPEG no larger than 1920 on its long side. */
    still: join(dir, 'still.jpg'),
  };
}
export type AssetCachePaths = ReturnType<typeof assetCachePaths>;
