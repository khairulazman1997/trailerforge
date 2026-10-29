import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getAt } from '@trailerforge/brief';
import { writeFileAtomic, type ProjectStore } from '@trailerforge/core';
import {
  SAVED_VIDEO_TYPE_PREFIX,
  SavedVideoType,
  isSavedVideoTypeId,
} from '@trailerforge/plugin-api';
import {
  savedTemplate,
  savedTypeFromStoryboard,
  savedVideoTypeDef,
  slugify,
} from '@trailerforge/storyboard';
import type { Engine } from './engine.js';
import { OpError, videoTypeOf } from './ops.js';

/** Registry owner of saved types; their ids are `user/<slug>`. */
const OWNER = SAVED_VIDEO_TYPE_PREFIX.slice(0, -1);

export const savedTypesDir = (home: string) => join(home, 'video-types');
const fileOf = (dir: string, id: string) =>
  join(dir, `${id.slice(SAVED_VIDEO_TYPE_PREFIX.length)}.json`);

export interface SavedTypesState {
  dir: string;
  types: SavedVideoType[];
  /** Files that could not be loaded, with why. */
  problems: { file: string; message: string }[];
}

/**
 * Read `<home>/video-types/*.json` and (re)register them as video types and templates. A file
 * that does not validate, or whose name does not match its id, is skipped and reported.
 */
export async function loadSavedTypes(engine: Engine): Promise<SavedTypesState> {
  const dir = savedTypesDir(engine.home);
  await mkdir(dir, { recursive: true });
  const reg = engine.plugins.registries;
  reg.videoTypes.removeOwner(OWNER);
  reg.templates.removeOwner(OWNER);
  const state: SavedTypesState = { dir, types: [], problems: [] };
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  for (const file of files) {
    try {
      const parsed = SavedVideoType.safeParse(JSON.parse(await readFile(join(dir, file), 'utf8')));
      if (!parsed.success) {
        throw new Error(
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      const saved = parsed.data;
      if (fileOf(dir, saved.id) !== join(dir, file)) {
        throw new Error(
          `the file name must be ${saved.id.slice(SAVED_VIDEO_TYPE_PREFIX.length)}.json`,
        );
      }
      const template = savedTemplate(saved);
      if (reg.videoTypes.get(saved.id) || reg.templates.get(template.id)) {
        throw new Error(`"${saved.id}" is already in use`);
      }
      reg.videoTypes.add(OWNER, savedVideoTypeDef(saved));
      reg.templates.add(OWNER, template);
      state.types.push(saved);
    } catch (err) {
      state.problems.push({ file, message: err instanceof Error ? err.message : String(err) });
    }
  }
  engine.savedTypes = state;
  return state;
}

export interface SavedTypeSummary {
  id: string;
  name: string;
  description: string;
  basedOn?: string;
  sections: { name: string; role?: string; slots: number }[];
  /** Seconds the storyboard it was saved from ran. */
  duration?: number;
  savedAt: string;
}

const summary = (t: SavedVideoType): SavedTypeSummary => ({
  id: t.id,
  name: t.name,
  description: t.description,
  ...(t.basedOn ? { basedOn: t.basedOn } : {}),
  sections: t.sections.map((s) => ({
    name: s.name,
    ...(s.role ? { role: s.role } : {}),
    slots: s.slots.length,
  })),
  ...(t.typicalDuration ? { duration: t.typicalDuration.max } : {}),
  savedAt: t.savedAt,
});

export function savedTypesViewOp(engine: Engine) {
  const { dir, types, problems } = engine.savedTypes;
  return { dir, types: types.map(summary), problems };
}

function requireSaved(engine: Engine, id: string): SavedVideoType {
  const t = engine.savedTypes.types.find((x) => x.id === id);
  if (!t) throw new OpError('not-found', `no saved video type "${id}"`);
  return t;
}

const cleanName = (name: string) => {
  const n = name.trim();
  if (!n) throw new OpError('usage', 'give the video type a name');
  if (n.length > 80) throw new OpError('usage', 'keep the name under 80 characters');
  return n;
};

async function write(engine: Engine, saved: SavedVideoType) {
  await writeFileAtomic(
    fileOf(engine.savedTypes.dir, saved.id),
    `${JSON.stringify(saved, null, 2)}\n`,
  );
  await loadSavedTypes(engine);
}

/**
 * Save the project's storyboard structure as a video type for other projects. The description
 * defaults to the user's own words for an open-ended type, else the type's description.
 */
export async function saveVideoTypeOp(
  engine: Engine,
  store: ProjectStore,
  opts: { name: string; description?: string | undefined },
): Promise<SavedTypeSummary> {
  const name = cleanName(opts.name);
  const vt = videoTypeOf(engine, store);
  if (!store.state.storyboard) {
    throw new OpError('not-found', 'this project has no storyboard yet; generate one first');
  }
  const own = vt.describedBy ? getAt(store.state, vt.describedBy) : undefined;
  const description = (opts.description ?? (typeof own === 'string' ? own : vt.description)).trim();
  const taken = new Set(engine.plugins.registries.videoTypes.list().map((v) => v.id));
  const base = `${SAVED_VIDEO_TYPE_PREFIX}${slugify(name)}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  let saved: SavedVideoType;
  try {
    saved = savedTypeFromStoryboard(store.state, vt, { id, name, description, now: new Date() });
  } catch (err) {
    throw new OpError('usage', err instanceof Error ? err.message : String(err));
  }
  await write(engine, saved);
  return summary(saved);
}

/** Rename a saved type or change its description. Projects made from it keep their own copy. */
export async function updateSavedTypeOp(
  engine: Engine,
  id: string,
  patch: { name?: string | undefined; description?: string | undefined },
): Promise<SavedTypeSummary> {
  const t = requireSaved(engine, id);
  const next = SavedVideoType.parse({
    ...t,
    ...(patch.name !== undefined ? { name: cleanName(patch.name) } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
  });
  await write(engine, next);
  return summary(next);
}

/** Delete a saved type's file. Projects that use it keep working from their own copy. */
export async function removeSavedTypeOp(engine: Engine, id: string): Promise<{ removed: string }> {
  if (!isSavedVideoTypeId(id)) throw new OpError('usage', `"${id}" is not a saved video type`);
  requireSaved(engine, id);
  await rm(fileOf(engine.savedTypes.dir, id), { force: true });
  await loadSavedTypes(engine);
  return { removed: id };
}

/** The copy a project keeps when it is created with (or switched to) a saved type. */
export function savedTypeSnapshot(engine: Engine, videoTypeId: string | undefined) {
  if (!videoTypeId || !isSavedVideoTypeId(videoTypeId)) return undefined;
  return engine.savedTypes.types.find((t) => t.id === videoTypeId);
}

/** Switch a project's video type; a saved type goes in with its copy (one undo step). */
export function setVideoTypeOp(engine: Engine, store: ProjectStore, videoTypeId: string) {
  if (!engine.plugins.registries.videoTypes.get(videoTypeId)) {
    throw new OpError('not-found', `video type "${videoTypeId}" is not installed`);
  }
  const saved = savedTypeSnapshot(engine, videoTypeId);
  store.dispatch('core/brief.set-video-type', { videoTypeId, ...(saved ? { saved } : {}) });
  return { videoTypeId };
}
