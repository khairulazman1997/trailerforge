import type { KnowledgeEntity } from '@trailerforge/schema';
import type { CaptureGroup, CapturePlan } from './capture.js';

/**
 * Setup hints for the capture checklist, derived from the project's knowledge entities (never
 * stored). Levels, bosses and other featured entities come from the repo scan (the Unity
 * extractor reads scenes and ScriptableObjects). Debug commands and save files are not
 * auto-detected: add them as knowledge entities carrying the tags below, and they are matched to
 * groups. User edits live on the entities themselves, so re-scans (which never touch edited
 * entities) cannot lose them.
 */
export const DEBUG_COMMAND_TAG = 'debug-command';
export const SAVE_FILE_TAG = 'save-file';
/** A tagged entity that applies to every group (e.g. a cheat console that works anywhere). */
export const ALL_GROUPS_TAG = 'all-levels';

export interface CaptureHint {
  entityId: string;
  kind: KnowledgeEntity['kind'];
  name: string;
  /** The command, file path or note, as written in the entity's description. */
  detail: string;
  sourcePaths: string[];
  /** `user`: added or edited by hand. */
  origin: KnowledgeEntity['origin'];
  /** The last scan no longer found it. */
  stale: boolean;
}

export interface GroupHints {
  groupKey: string;
  levels: CaptureHint[];
  /** Bosses, enemies, characters, abilities and other entities the group's shots feature. */
  featured: CaptureHint[];
  debugCommands: CaptureHint[];
  saveFiles: CaptureHint[];
}

export interface CaptureHintOptions {
  /** Drop entities marked `excludedFromLlm`: use for anything sent to a model. */
  forLlm?: boolean;
}

const norm = (s: string): string => s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
const MIN_MATCH = 3;
const byName = (a: CaptureHint, b: CaptureHint): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.entityId < b.entityId ? -1 : 1;

const toHint = (e: KnowledgeEntity): CaptureHint => ({
  entityId: e.id,
  kind: e.kind,
  name: e.name,
  detail: e.description,
  sourcePaths: [...e.sourcePaths],
  origin: e.origin,
  stale: e.tags.includes('stale'),
});

/** Either name contains the other (both long enough to mean something). */
function related(a: string, b: string): boolean {
  const [x, y] = [norm(a), norm(b)];
  return x.length >= MIN_MATCH && y.length >= MIN_MATCH && (x.includes(y) || y.includes(x));
}

function hintsForGroup(
  group: CaptureGroup,
  entities: readonly KnowledgeEntity[],
  opts: CaptureHintOptions,
): GroupHints {
  const pool = opts.forLlm ? entities.filter((e) => !e.excludedFromLlm) : entities;
  const linked = new Set(group.items.flatMap((i) => i.entities.map((e) => e.id)));
  const isSetupTag = (e: KnowledgeEntity): boolean =>
    e.tags.includes(DEBUG_COMMAND_TAG) || e.tags.includes(SAVE_FILE_TAG);

  const levels = pool.filter(
    (e) =>
      e.kind === 'level' &&
      !isSetupTag(e) &&
      (linked.has(e.id) || (group.location !== '' && related(e.name, group.location))),
  );
  const featured = pool.filter((e) => linked.has(e.id) && e.kind !== 'level' && !isSetupTag(e));

  // Names a debug-command or save-file entity may mention to say where it applies.
  const anchors = [
    group.location,
    ...levels.map((e) => e.name),
    ...featured.map((e) => e.name),
  ].filter((n) => norm(n).length >= MIN_MATCH);
  const applies = (e: KnowledgeEntity): boolean =>
    linked.has(e.id) ||
    e.tags.includes(ALL_GROUPS_TAG) ||
    anchors.some((a) => norm(`${e.name} ${e.description}`).includes(norm(a)));
  const tagged = (tag: string) => pool.filter((e) => e.tags.includes(tag) && applies(e));

  const hints = (es: KnowledgeEntity[]): CaptureHint[] => es.map(toHint).sort(byName);
  return {
    groupKey: group.key,
    levels: hints(levels),
    featured: hints(featured),
    debugCommands: hints(tagged(DEBUG_COMMAND_TAG)),
    saveFiles: hints(tagged(SAVE_FILE_TAG)),
  };
}

/**
 * One `GroupHints` per capture group, in plan order. Pure and deterministic. With `forLlm`, no
 * entity the user excluded appears anywhere in the result, so it is safe to put in a prompt.
 */
export function buildCaptureHints(
  plan: Pick<CapturePlan, 'groups'>,
  knowledge: readonly KnowledgeEntity[],
  opts: CaptureHintOptions = {},
): GroupHints[] {
  return plan.groups.map((g) => hintsForGroup(g, knowledge, opts));
}
