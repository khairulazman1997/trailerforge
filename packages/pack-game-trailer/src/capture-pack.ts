import type { Project } from '@trailerforge/schema';
import { z } from 'zod';
import {
  buildCaptureHints,
  ALL_GROUPS_TAG,
  DEBUG_COMMAND_TAG,
  SAVE_FILE_TAG,
} from './capture-hints.js';
import {
  excludedTerms,
  readCaptureTips,
  redactor,
  resolveCaptureTips,
  textLeaves,
} from './capture-tips.js';
import { buildCapturePlan, type CaptureGroup } from './capture.js';
import { resolveRecordingSettings, RecordingSettings } from './recording.js';

/**
 * The capture pack: everything needed to record the footage, computed from the project (nothing
 * here is stored). `CapturePack` is also the JSON the future ingest step reads, so it is
 * versioned and validated. It has no timestamps, absolute paths or ids of excluded knowledge,
 * and the same project always gives the same pack.
 */
export const CAPTURE_PACK_FORMAT = 'trailerforge.capture-pack';
export const CAPTURE_PACK_VERSION = 1;

const Hint = z.strictObject({ name: z.string(), kind: z.string(), detail: z.string() });
const Item = z.strictObject({
  slotId: z.string(),
  shotNumber: z.int().positive(),
  section: z.string(),
  title: z.string(),
  purpose: z.string(),
  priority: z.enum(['must', 'nice']),
  status: z.enum(['empty', 'recorded', 'approved', 'rejected']),
  done: z.boolean(),
  instruction: z.string(),
  framing: z.string(),
  setup: z.string(),
  location: z.string(),
  hud: z.enum(['on', 'off', 'any']),
  cutSeconds: z.strictObject({ min: z.number(), ideal: z.number(), max: z.number() }),
  handleSeconds: z.number(),
  recordSeconds: z.int(),
  alternates: z.array(z.string()),
  entities: z.array(z.strictObject({ name: z.string(), kind: z.string().nullable() })),
  notes: z.string(),
  takes: z.int().nonnegative(),
});

export const CapturePack = z.strictObject({
  format: z.literal(CAPTURE_PACK_FORMAT),
  version: z.literal(CAPTURE_PACK_VERSION),
  project: z.strictObject({ id: z.string(), name: z.string() }),
  storyboard: z.strictObject({
    id: z.string(),
    revision: z.int().nonnegative(),
    videoTypeId: z.string(),
  }),
  progress: z.strictObject({
    total: z.int().nonnegative(),
    done: z.int().nonnegative(),
    todoRecordSeconds: z.int().nonnegative(),
  }),
  recording: z.strictObject({
    settings: RecordingSettings,
    sources: z.record(z.string(), z.enum(['derived', 'override'])),
    primaryPlatform: z.string().nullable(),
    advice: z.array(
      z.strictObject({ code: z.string(), severity: z.enum(['info', 'warn']), message: z.string() }),
    ),
  }),
  /** Debug commands and save files that apply everywhere, shown once. */
  setup: z.strictObject({ debugCommands: z.array(Hint), saveFiles: z.array(Hint) }),
  groups: z.array(
    z.strictObject({
      key: z.string(),
      label: z.string(),
      location: z.string(),
      setup: z.string(),
      featured: z.string().nullable(),
      total: z.int(),
      done: z.int(),
      hints: z.strictObject({
        levels: z.array(Hint),
        featured: z.array(Hint),
        debugCommands: z.array(Hint),
        saveFiles: z.array(Hint),
      }),
      tips: z
        .strictObject({
          status: z.enum(['fresh', 'stale', 'edited']),
          tips: z.array(z.string()),
          risks: z.array(z.string()),
        })
        .nullable(),
      items: z.array(Item),
    }),
  ),
  skipped: z.array(z.strictObject({ slotId: z.string(), title: z.string() })),
});
export type CapturePack = z.infer<typeof CapturePack>;
export type CapturePackItem = z.infer<typeof Item>;

export interface CapturePackOptions {
  /** Leave out everything about entities marked `excludedFromLlm` (for a pack that is shared). */
  omitExcluded?: boolean;
}

export function groupLabel(g: Pick<CaptureGroup, 'location' | 'setup' | 'entity'>): string {
  return (
    [g.location, g.setup, g.entity?.name].filter((p) => p && p.trim()).join(' · ') || 'Anywhere'
  );
}

const SETUP_TAGS = [DEBUG_COMMAND_TAG, SAVE_FILE_TAG];

export function buildCapturePack(project: Project, opts: CapturePackOptions = {}): CapturePack {
  const sb = project.storyboard;
  if (!sb) throw new Error('the project has no storyboard to build a capture pack from');
  const omit = opts.omitExcluded ?? false;
  const plan = buildCapturePlan(sb, project.knowledge);
  const hints = buildCaptureHints(plan, project.knowledge, { forLlm: omit });
  const rec = resolveRecordingSettings(project);

  const visible = project.knowledge.filter((e) => !(omit && e.excludedFromLlm));
  const everywhere = visible.filter(
    (e) => e.tags.includes(ALL_GROUPS_TAG) && SETUP_TAGS.some((t) => e.tags.includes(t)),
  );
  const everywhereIds = new Set(everywhere.map((e) => e.id));
  const asHint = (e: { name: string; kind: string; description: string }) => ({
    name: e.name,
    kind: e.kind,
    detail: e.description,
  });
  const fromHint = (h: { name: string; kind: string; detail: string }) => ({
    name: h.name,
    kind: h.kind,
    detail: h.detail,
  });
  const byName = <T extends { name: string }>(xs: T[]): T[] =>
    [...xs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const withTag = (tag: string) =>
    byName(everywhere.filter((e) => e.tags.includes(tag)).map(asHint));

  const stored = readCaptureTips(project);
  const tipStatus = new Map(
    resolveCaptureTips(project).groups.map((g) => [g.groupKey, g.status] as const),
  );

  const groups = plan.groups.map((g, i) => {
    const h = hints[i]!;
    const own = (xs: typeof h.levels) =>
      xs.filter((x) => !everywhereIds.has(x.entityId)).map(fromHint);
    const entry = stored[g.key];
    const status = tipStatus.get(g.key);
    return {
      key: g.key,
      label: groupLabel(g),
      location: g.location,
      setup: g.setup,
      featured: g.entity && !(omit && g.entity.excludedFromLlm) ? g.entity.name : null,
      total: g.total,
      done: g.done,
      hints: {
        levels: own(h.levels),
        featured: own(h.featured),
        debugCommands: own(h.debugCommands),
        saveFiles: own(h.saveFiles),
      },
      tips:
        entry && status && status !== 'none' && (entry.tips.length || entry.risks.length)
          ? { status, tips: entry.tips, risks: entry.risks }
          : null,
      items: g.items.map((it) => ({
        slotId: it.slotId,
        shotNumber: it.shotNumber,
        section: it.sectionName,
        title: it.title,
        purpose: it.purpose,
        priority: it.priority,
        status: it.status,
        done: !it.todo,
        instruction: it.instruction,
        framing: it.framing,
        setup: it.setup,
        location: it.location,
        hud: it.hud,
        cutSeconds: it.duration,
        handleSeconds: it.handle,
        recordSeconds: it.recordSeconds,
        alternates: it.alternates,
        entities: it.entities
          .filter((e) => !(omit && e.excludedFromLlm))
          .map((e) => ({ name: e.name, kind: e.kind })),
        notes: it.notes,
        takes: it.takes,
      })),
    };
  });

  const titles = new Map(
    sb.sections.flatMap((s) => s.slots).map((s) => [s.id, s.title || s.id] as const),
  );
  const pack = CapturePack.parse({
    format: CAPTURE_PACK_FORMAT,
    version: CAPTURE_PACK_VERSION,
    project: { id: project.id, name: project.name },
    storyboard: { id: sb.id, revision: sb.revision, videoTypeId: sb.meta.videoTypeId },
    progress: {
      total: plan.total,
      done: plan.done,
      todoRecordSeconds: plan.todoRecordSeconds,
    },
    recording: {
      settings: rec.settings,
      sources: rec.sources,
      primaryPlatform: rec.primaryPlatform,
      advice: rec.advice,
    },
    setup: { debugCommands: withTag(DEBUG_COMMAND_TAG), saveFiles: withTag(SAVE_FILE_TAG) },
    groups,
    skipped: plan.skippedSlotIds.map((slotId) => ({ slotId, title: titles.get(slotId) ?? slotId })),
  });
  return omit ? omitExcludedFrom(pack, project) : pack;
}

const OMITTED = '(omitted)';
/** Fields that hold enums, ids or settings rather than text a person wrote. */
const STRUCTURAL = new Set([
  'format',
  'id',
  'videoTypeId',
  'slotId',
  'key',
  'status',
  'priority',
  'hud',
  'kind',
  'settings',
  'sources',
  'code',
  'severity',
]);

/**
 * A shareable copy: every string loses the name, id and source path of each entity the user
 * excluded (other entities' descriptions may mention them), and group keys, which embed entity
 * ids, become `group-N`. Fails rather than let a term through.
 */
function omitExcludedFrom(pack: CapturePack, project: Project): CapturePack {
  const terms = excludedTerms(project.knowledge);
  if (terms.length === 0) return pack;
  const redact = redactor(terms, OMITTED);
  // Only free text is rewritten; enums, ids and settings keep their values so the pack stays
  // valid even when an excluded name is a short word like "Off".
  const walk = (v: unknown): unknown =>
    typeof v === 'string'
      ? redact(v)
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v).map(([k, x]) => [k, STRUCTURAL.has(k) ? x : walk(x)]),
            )
          : v;
  const clean = walk(pack) as CapturePack;
  clean.groups.forEach((g, i) => {
    g.key = `group-${i + 1}`;
  });
  const out = CapturePack.parse(clean);
  const text = textLeaves(out, [...STRUCTURAL])
    .join('\n')
    .toLowerCase();
  if (terms.some((t) => text.includes(t.toLowerCase()))) {
    throw new Error('refusing to export: excluded knowledge is still present in the pack');
  }
  return out;
}

/** Stable JSON: keys in schema order, two-space indent, trailing newline. */
export function capturePackJson(pack: CapturePack): string {
  return `${JSON.stringify(pack, null, 2)}\n`;
}
