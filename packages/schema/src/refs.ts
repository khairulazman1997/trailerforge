import type { z } from 'zod';
import { MigrationError, migrateProject } from './migrations.js';
import { Project } from './project.js';
const TIKTOK_FORMAT_PREFIX = /^[a-z0-9-]+\/tiktok-/;
import type { Storyboard, Take } from './storyboard.js';
import { hookVersionId, shortVersionOf } from './shorts.js';

export interface RefIssue {
  path: string;
  message: string;
}

/**
 * Cross-reference checks that a per-object schema can't express: unique ids, and every id
 * reference (slots, assets, format targets, variants, shorts, nested timelines) resolving to something
 * that exists. Returns all issues rather than stopping at the first.
 */
export function validateProjectRefs(project: Project): RefIssue[] {
  const issues: RefIssue[] = [];
  const issue = (path: string, message: string) => issues.push({ path, message });

  const seen = new Map<string, string>();
  const claim = (id: string, path: string) => {
    const prev = seen.get(id);
    if (prev) issue(path, `duplicate id "${id}" (also at ${prev})`);
    else seen.set(id, path);
  };

  const assetIds = new Set(project.assets.map((a) => a.assetId));
  const formatIds = new Set<string>();
  project.formatTargets.forEach((f, i) => {
    claim(f.id, `formatTargets[${i}]`);
    formatIds.add(f.id);
  });

  const sourceIds = new Set<string>();
  project.sources.forEach((src, i) => {
    claim(src.id, `sources[${i}]`);
    sourceIds.add(src.id);
  });
  const entityIds = new Set<string>();
  project.knowledge.forEach((e, i) => {
    claim(e.id, `knowledge[${i}]`);
    entityIds.add(e.id);
    if (e.sourceId && !sourceIds.has(e.sourceId))
      issue(`knowledge[${i}]`, `unknown source "${e.sourceId}"`);
  });

  const slotIds = new Set<string>();
  const variantIds = new Set<string>();
  const ctx: StoryboardCheck = {
    issue,
    claim,
    assetIds,
    entityIds,
    formatIds,
    slotIds,
    variantIds,
  };
  if (project.storyboard) checkStoryboard(project.storyboard, 'storyboard', ctx);

  project.concepts.forEach((c, i) => claim(c.id, `concepts[${i}]`));
  const seriesIds = new Set(project.series.map((x) => x.id));
  project.series.forEach((x, i) => {
    claim(x.id, `series[${i}]`);
    if (!TIKTOK_FORMAT_PREFIX.test(x.formatId)) issue(`series[${i}]`, `"${x.formatId}" is not a short-form format`); // prettier-ignore
  });
  project.concepts.forEach((c, i) => {
    if (c.seriesId && !seriesIds.has(c.seriesId))
      issue(`concepts[${i}]`, `unknown series "${c.seriesId}"`);
  });
  project.shorts.forEach((sh, i) => {
    const p = `shorts[${i}]`;
    claim(sh.id, p);
    if (sh.seriesId && !seriesIds.has(sh.seriesId)) issue(p, `unknown series "${sh.seriesId}"`);
    if (sh.formatTargetId && !formatIds.has(sh.formatTargetId))
      issue(p, `unknown format target "${sh.formatTargetId}"`);
    const hookIds = new Set<string>();
    sh.hooks.forEach((h, hi) => {
      if (hookIds.has(h.id)) issue(`${p}.hooks[${hi}]`, `two hook versions "${h.id}"`);
      hookIds.add(h.id);
      // A take that was cleared since is not an error: the version falls back to the chosen take.
      claim(hookVersionId(sh.id, h.id), `${p}.hooks[${hi}]`);
    });
    if (sh.storyboard) {
      if (sh.storyboard.variants.length > 0) issue(`${p}.storyboard`, 'a short has no versions');
      checkStoryboard(sh.storyboard, `${p}.storyboard`, ctx);
    }
  });

  project.brief.referenceAssetIds.forEach((id) => {
    if (!assetIds.has(id)) issue('brief.referenceAssetIds', `unknown asset "${id}"`);
  });

  // A version is the master cut (null), a version of the trailer, or a short (by its id).
  const versionOk = (v: string | null) =>
    v === null || variantIds.has(v) || shortVersionOf(project, v) !== undefined;
  project.review.comments.forEach((c, i) => {
    claim(c.id, `review.comments[${i}]`);
    if (!versionOk(c.variantId)) issue(`review.comments[${i}]`, `unknown variant "${c.variantId}"`);
  });
  const approved = new Set<string>();
  project.review.approvals.forEach((a, i) => {
    const key = a.variantId ?? '(master)';
    if (approved.has(key)) issue(`review.approvals[${i}]`, `two approvals for "${key}"`);
    approved.add(key);
    if (!versionOk(a.variantId))
      issue(`review.approvals[${i}]`, `unknown variant "${a.variantId}"`);
  });

  const timelineIds = new Set(project.timelines.map((t) => t.id));
  const nested = new Map<string, string[]>();
  project.timelines.forEach((tl, ti) => {
    const tp = `timelines[${ti}]`;
    claim(tl.id, tp);
    if (tl.variantId && !variantIds.has(tl.variantId))
      issue(tp, `unknown variant "${tl.variantId}"`);
    if (tl.formatTargetId && !formatIds.has(tl.formatTargetId)) {
      issue(tp, `unknown format target "${tl.formatTargetId}"`);
    }
    const children: string[] = [];
    // Tracks, transitions and items are unique within their timeline: every command and comment
    // names the timeline too, and a TikTok's cut uses the same track ids as the trailer's.
    const local = new Map<string, string>();
    const claimLocal = (id: string, path: string) => {
      const prev = local.get(id);
      if (prev) issue(path, `duplicate id "${id}" (also at ${prev})`);
      else local.set(id, path);
    };
    tl.tracks.forEach((track, ki) => {
      const kp = `${tp}.tracks[${ki}]`;
      claimLocal(track.id, kp);
      track.transitions.forEach((t, i) => claimLocal(t.id, `${kp}.transitions[${i}]`));
      track.items.forEach((item, ii) => {
        const ip = `${kp}.items[${ii}]`;
        claimLocal(item.id, ip);
        if (item.slotId && !slotIds.has(item.slotId)) issue(ip, `unknown slot "${item.slotId}"`);
        if (item.kind === 'clip' && !assetIds.has(item.assetId)) {
          issue(ip, `unknown asset "${item.assetId}"`);
        }
        if (item.kind === 'sequence') {
          if (!timelineIds.has(item.timelineId)) issue(ip, `unknown timeline "${item.timelineId}"`);
          else children.push(item.timelineId);
        }
      });
    });
    nested.set(tl.id, children);
  });

  const cycle = findCycle(nested);
  if (cycle) issue('timelines', `nested sequences form a cycle: ${cycle.join(' -> ')}`);

  return issues;
}

interface StoryboardCheck {
  issue: (path: string, message: string) => void;
  claim: (id: string, path: string) => void;
  assetIds: Set<string>;
  entityIds: Set<string>;
  formatIds: Set<string>;
  /** Filled: every slot id across the project's storyboards (timeline items may name any). */
  slotIds: Set<string>;
  variantIds: Set<string>;
}

function checkTakes(
  takes: readonly Take[],
  chosenTakeId: string | undefined,
  p: string,
  ctx: StoryboardCheck,
): Set<string> {
  const takeIds = new Set<string>();
  takes.forEach((t, ti) => {
    ctx.claim(t.id, `${p}.takes[${ti}]`);
    takeIds.add(t.id);
    if (!ctx.assetIds.has(t.assetId))
      ctx.issue(`${p}.takes[${ti}]`, `unknown asset "${t.assetId}"`);
  });
  if (chosenTakeId !== undefined) {
    const chosen = takes.find((t) => t.id === chosenTakeId);
    if (!chosen) ctx.issue(`${p}.chosenTakeId`, `unknown take "${chosenTakeId}"`);
    else if (chosen.rejected) ctx.issue(`${p}.chosenTakeId`, `take "${chosen.id}" is rejected`);
  }
  return takeIds;
}

function checkStoryboard(sb: Storyboard, base: string, ctx: StoryboardCheck): void {
  const { issue, claim } = ctx;
  const sectionIds = new Set<string>();
  const slotIds = new Set<string>();
  const takesBySlot = new Map<string, Set<string>>();
  claim(sb.id, base);
  sb.sections.forEach((s, si) => {
    claim(s.id, `${base}.sections[${si}]`);
    sectionIds.add(s.id);
    s.slots.forEach((slot, i) => {
      const p = `${base}.sections[${si}].slots[${i}]`;
      claim(slot.id, p);
      slotIds.add(slot.id);
      ctx.slotIds.add(slot.id);
      slot.entityIds.forEach((id) => {
        if (!ctx.entityIds.has(id)) issue(p, `unknown knowledge entity "${id}"`);
      });
      if (slot.kind === 'shot') {
        slot.overlays.forEach((o, oi) => claim(o.id, `${p}.overlays[${oi}]`));
        takesBySlot.set(slot.id, checkTakes(slot.takes, slot.chosenTakeId, p, ctx));
      }
    });
  });
  sb.voLines.forEach((v, i) => {
    const p = `${base}.voLines[${i}]`;
    claim(v.id, p);
    v.linkedSlotIds.forEach((id) => {
      if (!slotIds.has(id)) issue(p, `unknown slot "${id}"`);
    });
    checkTakes(v.takes, v.chosenTakeId, p, ctx);
  });
  const m = sb.music;
  if (m.trackAssetId && !ctx.assetIds.has(m.trackAssetId)) {
    issue(`${base}.music.trackAssetId`, `unknown asset "${m.trackAssetId}"`);
  }
  m.structure.forEach((part, i) => {
    claim(part.id, `${base}.music.structure[${i}]`);
    part.sectionIds.forEach((id) => {
      if (!sectionIds.has(id)) issue(`${base}.music.structure[${i}]`, `unknown section "${id}"`);
    });
  });
  m.hitPoints.forEach((h, i) => {
    claim(h.id, `${base}.music.hitPoints[${i}]`);
    if (!slotIds.has(h.slotId))
      issue(`${base}.music.hitPoints[${i}]`, `unknown slot "${h.slotId}"`);
  });
  m.sfxCues.forEach((c, i) => {
    claim(c.id, `${base}.music.sfxCues[${i}]`);
    if (!slotIds.has(c.slotId)) issue(`${base}.music.sfxCues[${i}]`, `unknown slot "${c.slotId}"`);
    if (c.assetId && !ctx.assetIds.has(c.assetId)) {
      issue(`${base}.music.sfxCues[${i}]`, `unknown asset "${c.assetId}"`);
    }
  });
  sb.variants.forEach((v, i) => {
    claim(v.id, `${base}.variants[${i}]`);
    ctx.variantIds.add(v.id);
    if (!ctx.formatIds.has(v.formatTargetId)) {
      issue(`${base}.variants[${i}]`, `unknown format target "${v.formatTargetId}"`);
    }
    Object.entries(v.overrides).forEach(([id, o]) => {
      if (!slotIds.has(id)) issue(`${base}.variants[${i}].overrides`, `unknown slot "${id}"`);
      else if (o.takeId !== undefined && !takesBySlot.get(id)?.has(o.takeId)) {
        issue(`${base}.variants[${i}].overrides.${id}`, `unknown take "${o.takeId}"`);
      }
    });
  });
  sb.comments.forEach((c, i) => {
    const p = `${base}.comments[${i}]`;
    claim(c.id, p);
    if (!sectionIds.has(c.sectionId)) issue(p, `unknown section "${c.sectionId}"`);
    if (c.slotId !== undefined) {
      const home = sb.sections.find((s) => s.id === c.sectionId);
      if (!home?.slots.some((x) => x.id === c.slotId))
        issue(p, `slot "${c.slotId}" is not in section "${c.sectionId}"`);
    }
  });
}

/**
 * Every place in the project that refers to `assetId`, as paths. Used to refuse removing an asset
 * that is still in use, with a message that says where.
 */
export function findAssetUsages(project: Project, assetId: string): string[] {
  const uses: string[] = [];
  const inStoryboard = (sb: Storyboard, base: string) => {
    sb.sections.forEach((s, si) =>
      s.slots.forEach((slot, i) => {
        if (slot.kind !== 'shot') return;
        slot.takes.forEach((t, ti) => {
          if (t.assetId === assetId) uses.push(`${base}.sections[${si}].slots[${i}].takes[${ti}]`);
        });
      }),
    );
    sb.voLines.forEach((v, i) =>
      v.takes.forEach((t, ti) => {
        if (t.assetId === assetId) uses.push(`${base}.voLines[${i}].takes[${ti}]`);
      }),
    );
    if (sb.music.trackAssetId === assetId) uses.push(`${base}.music.trackAssetId`);
    sb.music.sfxCues.forEach((c, i) => {
      if (c.assetId === assetId) uses.push(`${base}.music.sfxCues[${i}]`);
    });
  };
  if (project.storyboard) inStoryboard(project.storyboard, 'storyboard');
  project.shorts.forEach((sh, i) => {
    if (sh.storyboard) inStoryboard(sh.storyboard, `shorts[${i}].storyboard`);
  });
  if (project.brief.referenceAssetIds.includes(assetId)) uses.push('brief.referenceAssetIds');
  project.timelines.forEach((tl, ti) =>
    tl.tracks.forEach((track, ki) =>
      track.items.forEach((item, ii) => {
        if (item.kind === 'clip' && item.assetId === assetId)
          uses.push(`timelines[${ti}].tracks[${ki}].items[${ii}]`);
      }),
    ),
  );
  return uses;
}

function findCycle(graph: Map<string, string[]>): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    if (state.get(node) === 'done') return null;
    if (state.get(node) === 'visiting') return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };
  for (const node of graph.keys()) {
    const found = visit(node);
    if (found) return found;
  }
  return null;
}

export type ParseProjectResult =
  | { ok: true; project: Project; migratedFrom: number | null; applied: string[] }
  | { ok: false; issues: RefIssue[] };

/**
 * The gate for loading any project document: migrate to the current schema version, validate,
 * then cross-check references. `migratedFrom` is set when migrations ran (callers back up the
 * original file before saving the upgraded one).
 */
export function parseProject(input: unknown): ParseProjectResult {
  let migrated;
  try {
    migrated = migrateProject(input);
  } catch (err) {
    if (err instanceof MigrationError)
      return { ok: false, issues: [{ path: 'schemaVersion', message: err.message }] };
    throw err;
  }
  const parsed = Project.safeParse(migrated.doc);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const refIssues = validateProjectRefs(parsed.data);
  if (refIssues.length) return { ok: false, issues: refIssues };
  const ran = migrated.applied.length > 0;
  return {
    ok: true,
    project: parsed.data,
    migratedFrom: ran ? migrated.fromVersion : null,
    applied: migrated.applied,
  };
}

function zodIssues(error: z.ZodError): RefIssue[] {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}
