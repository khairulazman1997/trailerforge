import type { z } from 'zod';
import { MigrationError, migrateProject } from './migrations.js';
import { Project } from './project.js';

export interface RefIssue {
  path: string;
  message: string;
}

/**
 * Cross-reference checks that a per-object schema can't express: unique ids, and every id
 * reference (slots, assets, format targets, variants, nested timelines) resolving to something
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

  const sectionIds = new Set<string>();
  const slotIds = new Set<string>();
  const variantIds = new Set<string>();
  const sb = project.storyboard;
  if (sb) {
    claim(sb.id, 'storyboard');
    sb.sections.forEach((s, si) => {
      claim(s.id, `storyboard.sections[${si}]`);
      sectionIds.add(s.id);
      s.slots.forEach((slot, i) => {
        const p = `storyboard.sections[${si}].slots[${i}]`;
        claim(slot.id, p);
        slotIds.add(slot.id);
        slot.entityIds.forEach((id) => {
          if (!entityIds.has(id)) issue(p, `unknown knowledge entity "${id}"`);
        });
        if (slot.kind === 'shot') {
          slot.overlays.forEach((o, oi) => claim(o.id, `${p}.overlays[${oi}]`));
          const takeIds = new Set<string>();
          slot.takes.forEach((t, ti) => {
            claim(t.id, `${p}.takes[${ti}]`);
            takeIds.add(t.id);
            if (!assetIds.has(t.assetId))
              issue(`${p}.takes[${ti}]`, `unknown asset "${t.assetId}"`);
          });
          if (slot.chosenTakeId !== undefined) {
            const chosen = slot.takes.find((t) => t.id === slot.chosenTakeId);
            if (!chosen) issue(`${p}.chosenTakeId`, `unknown take "${slot.chosenTakeId}"`);
            else if (chosen.rejected) issue(`${p}.chosenTakeId`, `take "${chosen.id}" is rejected`);
          }
        }
      });
    });
    sb.voLines.forEach((v, i) => {
      claim(v.id, `storyboard.voLines[${i}]`);
      v.linkedSlotIds.forEach((id) => {
        if (!slotIds.has(id)) issue(`storyboard.voLines[${i}]`, `unknown slot "${id}"`);
      });
    });
    const m = sb.music;
    if (m.trackAssetId && !assetIds.has(m.trackAssetId)) {
      issue('storyboard.music.trackAssetId', `unknown asset "${m.trackAssetId}"`);
    }
    m.structure.forEach((part, i) => {
      claim(part.id, `storyboard.music.structure[${i}]`);
      part.sectionIds.forEach((id) => {
        if (!sectionIds.has(id))
          issue(`storyboard.music.structure[${i}]`, `unknown section "${id}"`);
      });
    });
    m.hitPoints.forEach((h, i) => {
      claim(h.id, `storyboard.music.hitPoints[${i}]`);
      if (!slotIds.has(h.slotId))
        issue(`storyboard.music.hitPoints[${i}]`, `unknown slot "${h.slotId}"`);
    });
    m.sfxCues.forEach((c, i) => {
      claim(c.id, `storyboard.music.sfxCues[${i}]`);
      if (!slotIds.has(c.slotId))
        issue(`storyboard.music.sfxCues[${i}]`, `unknown slot "${c.slotId}"`);
      if (c.assetId && !assetIds.has(c.assetId)) {
        issue(`storyboard.music.sfxCues[${i}]`, `unknown asset "${c.assetId}"`);
      }
    });
    sb.variants.forEach((v, i) => {
      claim(v.id, `storyboard.variants[${i}]`);
      variantIds.add(v.id);
      if (!formatIds.has(v.formatTargetId)) {
        issue(`storyboard.variants[${i}]`, `unknown format target "${v.formatTargetId}"`);
      }
      Object.keys(v.overrides).forEach((id) => {
        if (!slotIds.has(id)) issue(`storyboard.variants[${i}].overrides`, `unknown slot "${id}"`);
      });
    });
  }

  project.brief.referenceAssetIds.forEach((id) => {
    if (!assetIds.has(id)) issue('brief.referenceAssetIds', `unknown asset "${id}"`);
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
    tl.tracks.forEach((track, ki) => {
      const kp = `${tp}.tracks[${ki}]`;
      claim(track.id, kp);
      track.transitions.forEach((t, i) => claim(t.id, `${kp}.transitions[${i}]`));
      track.items.forEach((item, ii) => {
        const ip = `${kp}.items[${ii}]`;
        claim(item.id, ip);
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

/**
 * Every place in the project that refers to `assetId`, as paths. Used to refuse removing an asset
 * that is still in use, with a message that says where.
 */
export function findAssetUsages(project: Project, assetId: string): string[] {
  const uses: string[] = [];
  const sb = project.storyboard;
  if (sb) {
    sb.sections.forEach((s, si) =>
      s.slots.forEach((slot, i) => {
        if (slot.kind !== 'shot') return;
        slot.takes.forEach((t, ti) => {
          if (t.assetId === assetId)
            uses.push(`storyboard.sections[${si}].slots[${i}].takes[${ti}]`);
        });
      }),
    );
    if (sb.music.trackAssetId === assetId) uses.push('storyboard.music.trackAssetId');
    sb.music.sfxCues.forEach((c, i) => {
      if (c.assetId === assetId) uses.push(`storyboard.music.sfxCues[${i}]`);
    });
  }
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
