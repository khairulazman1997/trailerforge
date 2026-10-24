import type { KnowledgeEntity } from '@trailerforge/schema';
import {
  ALL_GROUPS_TAG,
  DEBUG_COMMAND_TAG,
  SAVE_FILE_TAG,
  type CaptureGroup,
  type CaptureHint,
  type GroupHints,
  type RecordingSettings,
} from '@trailerforge/pack-game-trailer/browser';

/** Framework-free helpers for the Capture screen, so they can be unit tested. */

export const groupTitle = (g: Pick<CaptureGroup, 'location' | 'setup' | 'entity'>): string =>
  [g.location, g.setup, g.entity?.name].filter((p) => p && p.trim()).join(' · ') || 'Anywhere';

export function formatSeconds(s: number): string {
  if (s < 90) return `${Math.round(s * 10) / 10} s`;
  return `${Math.round(s / 6) / 10} min`;
}

export const percent = (done: number, total: number): number =>
  total === 0 ? 0 : Math.round((done / total) * 100);

export interface SetupView {
  /** Debug commands and save files that apply to every group, shown once. */
  everywhere: { debugCommands: CaptureHint[]; saveFiles: CaptureHint[] };
  /** Each group's hints without the ones shown once above. */
  groups: GroupHints[];
}

const byName = (a: CaptureHint, b: CaptureHint) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Split the "applies everywhere" setup out of every group's hints. */
export function splitSetup(
  hints: readonly GroupHints[],
  knowledge: readonly KnowledgeEntity[],
): SetupView {
  const all = knowledge.filter((e) => e.tags.includes(ALL_GROUPS_TAG));
  const hint = (e: KnowledgeEntity): CaptureHint => ({
    entityId: e.id,
    kind: e.kind,
    name: e.name,
    detail: e.description,
    sourcePaths: [...e.sourcePaths],
    origin: e.origin,
    stale: e.tags.includes('stale'),
  });
  const withTag = (tag: string) =>
    all
      .filter((e) => e.tags.includes(tag))
      .map(hint)
      .sort(byName);
  const everywhere = {
    debugCommands: withTag(DEBUG_COMMAND_TAG),
    saveFiles: withTag(SAVE_FILE_TAG),
  };
  const hidden = new Set(
    [...everywhere.debugCommands, ...everywhere.saveFiles].map((h) => h.entityId),
  );
  const keep = (xs: CaptureHint[]) => xs.filter((x) => !hidden.has(x.entityId));
  return {
    everywhere,
    groups: hints.map((h) => ({
      ...h,
      levels: keep(h.levels),
      featured: keep(h.featured),
      debugCommands: keep(h.debugCommands),
      saveFiles: keep(h.saveFiles),
    })),
  };
}

/** Moves `id` one place up or down; null when it can't move. */
export function moveWithin(ids: readonly string[], id: string, dir: -1 | 1): string[] | null {
  const from = ids.indexOf(id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

/** Drops `id` just before `before` (or at the end when `before` is null); null if nothing changes. */
export function moveBefore(
  ids: readonly string[],
  id: string,
  before: string | null,
): string[] | null {
  if (!ids.includes(id) || id === before || (before !== null && !ids.includes(before))) return null;
  const rest = ids.filter((x) => x !== id);
  const at = before === null ? rest.length : rest.indexOf(before);
  const next = [...rest.slice(0, at), id, ...rest.slice(at)];
  return next.every((x, i) => x === ids[i]) ? null : next;
}

export const RESOLUTIONS = [
  { width: 3840, height: 2160 },
  { width: 2560, height: 1440 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
] as const;

export const resolutionKey = (r: { width: number; height: number }) => `${r.width}x${r.height}`;
export const resolutionLabel = (r: { width: number; height: number }) => `${r.width}×${r.height}`;

export function parseResolution(key: string): { width: number; height: number } | null {
  const m = /^(\d+)x(\d+)$/.exec(key);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** A number typed into a settings field: a positive finite value, or null. */
export function parsePositive(text: string, opts: { integer?: boolean } = {}): number | null {
  const n = Number(text.trim());
  if (!text.trim() || !Number.isFinite(n) || n <= 0) return null;
  return opts.integer && !Number.isInteger(n) ? null : n;
}

export const SETTING_LABELS: Record<keyof RecordingSettings, string> = {
  resolution: 'Resolution',
  fps: 'Frame rate (fps)',
  bitrateMbps: 'Bitrate (Mbps)',
  codec: 'Codec',
  container: 'Container',
  hud: 'HUD',
  hdr: 'HDR',
};
