import { join } from 'node:path';

/**
 * On-disk project folder (`MyGame.tforge/`):
 *
 *   project.json          single source of truth
 *   history/              patches.jsonl + periodic snapshots + pre-migration backups
 *   media/                user-chosen copies of media (by default media is referenced, not copied)
 *   cache/                proxies, thumbnails, analysis; always safe to delete
 *   logs/decisions.jsonl  why automated steps chose what they chose
 *   .lock                 held by the app instance editing the project
 */
export function projectPaths(dir: string) {
  return {
    dir,
    projectFile: join(dir, 'project.json'),
    history: join(dir, 'history'),
    patchLog: join(dir, 'history', 'patches.jsonl'),
    snapshot: (seq: number) =>
      join(dir, 'history', `snapshot-${String(seq).padStart(8, '0')}.json`),
    media: join(dir, 'media'),
    cache: join(dir, 'cache'),
    logs: join(dir, 'logs'),
    decisions: join(dir, 'logs', 'decisions.jsonl'),
    lock: join(dir, '.lock'),
  };
}
export type ProjectPaths = ReturnType<typeof projectPaths>;

export const SNAPSHOT_PREFIX = 'snapshot-';
