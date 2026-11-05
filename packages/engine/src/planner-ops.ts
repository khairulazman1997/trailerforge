import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  normalizeProjectDir,
  projectPaths,
  type RegisteredProjectState,
  type RegisteredProjectView,
} from '@trailerforge/core';
import {
  parseProject,
  suggestStatus,
  type CalendarSlot,
  type Campaign,
  type Project,
  type ProjectStatus,
  type StatusSuggestion,
} from '@trailerforge/schema';
import { freeDir } from './demo-ops.js';
import type { Engine } from './engine.js';
import { OpError } from './ops.js';
import { platformFormat } from './platforms.js';

/** A platform as the planner offers it. */
export interface PlannerPlatform {
  id: string;
  name: string;
  aspect: string;
  presetId: string | null;
}

/** The live fields of the project a slot is linked to. */
export interface PlannedProject {
  id: string;
  dir: string | null;
  name: string;
  state: RegisteredProjectState | 'unknown';
  status: ProjectStatus | null;
  scheduledDate: string | null;
  campaignId: string | null;
  platformTargets: string[];
  suggestion: StatusSuggestion | null;
}

export interface PlannerSlotView extends CalendarSlot {
  project: PlannedProject | null;
}

export interface SharedFootage {
  assetId: string;
  name: string;
  /** Projects of the campaign that exported with it. */
  projectIds: string[];
}

export interface PlannerCampaignView extends Campaign {
  sharedFootage: SharedFootage[];
}

export interface PlannerView {
  campaigns: PlannerCampaignView[];
  slots: PlannerSlotView[];
  /** Every known project, most recently opened first, with its live planner fields. */
  projects: PlannedProject[];
  platforms: PlannerPlatform[];
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

export function plannerPlatforms(engine: Engine): PlannerPlatform[] {
  return engine.plugins.registries.platforms.list().map((p) => {
    const a = p.aspects[0]!;
    return {
      id: p.id,
      name: p.name,
      aspect: typeof a === 'string' ? a : `${a.w}:${a.h}`,
      presetId: p.exportPresetId ?? null,
    };
  });
}

async function hasExport(dir: string): Promise<boolean> {
  const root = join(projectPaths(dir).exports, 'render');
  try {
    for (const version of await readdir(root, { withFileTypes: true })) {
      if (!version.isDirectory()) continue;
      const files = await readdir(join(root, version.name));
      if (files.some((f) => f.endsWith('.export.json'))) return true;
    }
  } catch {
    // no exports folder yet
  }
  return false;
}

/** A project's planner fields: from the open store when it is open, else from its file. */
async function plannedProject(
  engine: Engine,
  entry: RegisteredProjectView,
): Promise<PlannedProject> {
  const base: PlannedProject = {
    id: entry.id,
    dir: entry.dir,
    name: entry.name,
    state: entry.state,
    status: null,
    scheduledDate: null,
    campaignId: null,
    platformTargets: [],
    suggestion: null,
  };
  let project: Project | undefined = engine.projects.get(entry.dir)?.state;
  if (!project && entry.state === 'ok') {
    try {
      const parsed = parseProject(
        JSON.parse(await readFile(projectPaths(entry.dir).projectFile, 'utf8')),
      );
      if (parsed.ok) project = parsed.project;
      else base.state = 'unreadable';
    } catch {
      base.state = 'unreadable';
    }
  }
  if (!project) return base;
  return {
    ...base,
    name: project.name,
    status: project.status,
    scheduledDate: project.scheduledDate,
    campaignId: project.campaignId,
    platformTargets: [...project.platformTargets],
    suggestion: suggestStatus(project, { exported: await hasExport(entry.dir) }),
  };
}

/** Campaigns, slots joined with their projects' live fields, every known project, platforms. */
export async function plannerViewOp(engine: Engine): Promise<PlannerView> {
  const planner = await engine.planner.reload();
  await engine.registry.reload();
  const entries = await engine.registry.views();
  // One entry per id (a copied folder keeps its id): the most recently opened wins.
  const byId = new Map<string, PlannedProject>();
  const projects: PlannedProject[] = [];
  for (const e of entries) {
    const p = await plannedProject(engine, e);
    projects.push(p);
    if (!byId.has(e.id)) byId.set(e.id, p);
  }
  const slots = planner.slots.map((s) => {
    if (s.projectId === null) return { ...s, project: null };
    const known = byId.get(s.projectId);
    const project: PlannedProject = known ?? {
      id: s.projectId,
      dir: null,
      name: s.title,
      state: 'unknown',
      status: null,
      scheduledDate: null,
      campaignId: null,
      platformTargets: [],
      suggestion: null,
    };
    return { ...s, project };
  });
  const campaigns = planner.campaigns.map((c) => {
    const ids = new Set(projects.filter((p) => p.campaignId === c.id).map((p) => p.id));
    for (const s of planner.slots) if (s.campaignId === c.id && s.projectId) ids.add(s.projectId);
    const sharedFootage: SharedFootage[] = [];
    for (const a of engine.library.list()) {
      const used = [...new Set(a.reuseHistory.map((r) => r.projectId))].filter((id) => ids.has(id));
      if (used.length > 0)
        sharedFootage.push({ assetId: a.id, name: a.originalName, projectIds: used.sort() });
    }
    return { ...c, sharedFootage };
  });
  return {
    campaigns,
    slots,
    projects,
    platforms: plannerPlatforms(engine),
    canUndo: engine.planner.canUndo(),
    canRedo: engine.planner.canRedo(),
    undoLabel: engine.planner.undoLabel() ?? null,
    redoLabel: engine.planner.redoLabel() ?? null,
  };
}

export interface CreateFromSlotResult {
  projectId: string;
  dir: string;
  slotId: string;
  formatTargetIds: string[];
  warnings: string[];
}

const slug = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60) || 'Untitled';

async function isEmptyOrMissing(dir: string): Promise<'missing' | 'empty' | 'used'> {
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) return 'used';
    return (await readdir(dir)).length === 0 ? 'empty' : 'used';
  } catch {
    return 'missing';
  }
}

/**
 * Make a project from a calendar slot: the slot's title, campaign, date, platforms (a format
 * target per known platform, whose versions export with that platform's preset) and video
 * type, in `dir` (default `<home>/projects/<campaign>/<title>.tforge`, numbered if taken). The
 * slot is linked and the project registered. All or nothing: on any failure the folder, the
 * registry entry and the link are undone.
 */
export async function createFromCalendarSlotOp(
  engine: Engine,
  slotId: string,
  opts: { dir?: string | undefined } = {},
): Promise<CreateFromSlotResult> {
  const planner = await engine.planner.reload();
  const slot = planner.slots.find((s) => s.id === slotId);
  if (!slot) throw new OpError('not-found', `no calendar slot "${slotId}"`);
  if (slot.projectId !== null)
    throw new OpError('usage', `"${slot.title}" already has a project; unlink it first`);
  const campaign = planner.campaigns.find((c) => c.id === slot.campaignId);

  let dir: string;
  if (opts.dir) {
    dir = normalizeProjectDir(opts.dir);
    if ((await isEmptyOrMissing(dir)) === 'used')
      throw new OpError('usage', `the folder is not empty: ${dir}`);
  } else {
    const parent = join(engine.home, 'projects', slug(campaign?.name ?? 'Unplanned'));
    await mkdir(parent, { recursive: true });
    dir = normalizeProjectDir(await freeDir(join(parent, slug(slot.title))));
  }
  const existedBefore = (await isEmptyOrMissing(dir)) !== 'missing';

  const warnings: string[] = [];
  const profiles = engine.plugins.registries.platforms.list();
  const formatTargets = [];
  for (const id of slot.platformTargets) {
    const profile = profiles.find((p) => p.id === id);
    if (profile) formatTargets.push(platformFormat(profile));
    else warnings.push(`Platform ${id} is not installed: no version was made for it.`);
  }

  let created = false;
  try {
    const store = await engine.createProject(dir, {
      name: slot.title,
      campaignId: slot.campaignId,
      scheduledDate: slot.date,
      platformTargets: [...slot.platformTargets],
      formatTargets: formatTargets as never,
      ...(slot.videoTypeId ? { brief: { videoTypeId: slot.videoTypeId } as never } : {}),
    });
    created = true;
    await store.save();
    await engine.planner.dispatch('planner/slot.link', { slotId, projectId: store.state.id });
    return {
      projectId: store.state.id,
      dir: store.paths.dir,
      slotId,
      formatTargetIds: store.state.formatTargets.map((f) => f.id),
      warnings,
    };
  } catch (err) {
    if (created || (await isEmptyOrMissing(dir)) !== 'missing') {
      await engine.closeProject(dir).catch(() => {});
      if (existedBefore) {
        for (const name of await readdir(dir).catch(() => [] as string[]))
          await rm(join(dir, name), { recursive: true, force: true });
      } else await rm(dir, { recursive: true, force: true });
    }
    await engine.registry.forget(resolve(dir)).catch(() => false);
    if (err instanceof OpError) throw err;
    throw new OpError('failed', `could not make the project: ${(err as Error).message}`, {
      cause: String(err),
    });
  }
}

export interface ImportKnownResult {
  /** Folders put on the known-projects list, in the order given. */
  added: string[];
  skipped: { dir: string; reason: string }[];
}

/**
 * Put project folders on the known-projects list without opening them (for the recent
 * projects an older version of the app kept in the browser). A folder counts only if it holds
 * a `project.json` with an id and a name; nothing is changed in the folder. `dirs` is most
 * recent first, and the list keeps that order.
 */
export async function importKnownProjectsOp(
  engine: Engine,
  dirs: readonly string[],
): Promise<ImportKnownResult> {
  const out: ImportKnownResult = { added: [], skipped: [] };
  const found: { id: string; name: string; dir: string }[] = [];
  for (const raw of dirs) {
    const dir = normalizeProjectDir(raw);
    if (engine.registry.byDir(dir)) {
      out.skipped.push({ dir, reason: 'already on the list' });
      continue;
    }
    try {
      const doc = JSON.parse(await readFile(projectPaths(dir).projectFile, 'utf8')) as {
        id?: unknown;
        name?: unknown;
      };
      if (typeof doc.id !== 'string' || typeof doc.name !== 'string')
        throw new Error('not a project file');
      found.push({ id: doc.id, name: doc.name, dir });
    } catch {
      out.skipped.push({ dir, reason: 'no project there' });
    }
  }
  // Oldest first, so the most recent ends up with the latest "opened" time.
  for (const p of [...found].reverse()) {
    await engine.registry.register(p);
    out.added.unshift(p.dir);
    await new Promise((r) => setTimeout(r, 2));
  }
  return out;
}
