import type {
  KnowledgeEntity,
  Section,
  ShotSlot,
  SlotStatus,
  Storyboard,
} from '@trailerforge/schema';
import { z } from 'zod';
import { PACK_ID } from './brief-ext.js';

/**
 * Per-shot capture state the user edits (via 3.3's commands), stored on the slot at
 * `slot.extensions['game-trailer'].capture`. Recorded/approved status itself is the
 * slot's own `status`. Everything else in a capture plan is derived, never stored.
 */
export const CaptureSlotExt = z.strictObject({
  notes: z.string().default(''),
  /** Takes recorded so far. */
  takes: z.int().nonnegative().default(0),
  /** Position within its capture group; unset items follow, in storyboard order. */
  order: z.int().optional(),
  /** The user chose not to record this shot; it is left out of the plan. */
  skipped: z.boolean().default(false),
});
export type CaptureSlotExt = z.infer<typeof CaptureSlotExt>;

const DEFAULT_CAPTURE: CaptureSlotExt = { notes: '', takes: 0, skipped: false };

/** Reads a slot's capture state; missing or malformed data yields the defaults. */
export function readCaptureExt(slot: Pick<ShotSlot, 'extensions'>): CaptureSlotExt {
  const ext = slot.extensions[PACK_ID];
  const raw =
    ext !== null && typeof ext === 'object' && !Array.isArray(ext) ? ext['capture'] : undefined;
  const parsed = CaptureSlotExt.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_CAPTURE;
}

/**
 * Padding: record `handle` seconds before and after the longest usable cut so the editor
 * can trim and add transitions. handle = clamp(ideal × 0.5, 1, 3); the recording length is
 * max + 2 × handle (+ the incoming/outgoing transition durations), rounded up to whole
 * seconds and never below MIN_RECORD_SECONDS.
 */
export const HANDLE_RATIO = 0.5;
export const MIN_HANDLE_SECONDS = 1;
export const MAX_HANDLE_SECONDS = 3;
export const MIN_RECORD_SECONDS = 5;

export interface CapturePadding {
  /** Seconds to keep before and after the cut. */
  handle: number;
  /** Whole seconds to record. */
  recordSeconds: number;
}

export function capturePadding(
  slot: Pick<ShotSlot, 'duration' | 'transitionIn' | 'transitionOut'>,
): CapturePadding {
  const { ideal, max } = slot.duration;
  const handle = Math.min(MAX_HANDLE_SECONDS, Math.max(MIN_HANDLE_SECONDS, ideal * HANDLE_RATIO));
  const transitions = (slot.transitionIn?.duration ?? 0) + (slot.transitionOut?.duration ?? 0);
  // Round to millis first so float noise (2.0000000001) doesn't add a whole second.
  const raw = Math.round((max + 2 * handle + transitions) * 1000) / 1000;
  return { handle, recordSeconds: Math.max(MIN_RECORD_SECONDS, Math.ceil(raw)) };
}

export interface CaptureEntityRef {
  id: string;
  /** Knowledge name, or the id when the entity is unknown. */
  name: string;
  kind: KnowledgeEntity['kind'] | null;
  /** Never put this entity into anything sent to an LLM. Unknown ids count as excluded. */
  excludedFromLlm: boolean;
}

export interface CaptureItem {
  slotId: string;
  sectionId: string;
  sectionName: string;
  /** 1-based position among all shot slots in the storyboard. */
  shotNumber: number;
  title: string;
  purpose: string;
  priority: ShotSlot['priority'];
  status: SlotStatus;
  /** Status is `empty` or `rejected`: still needs (re)recording. */
  todo: boolean;
  instruction: string;
  framing: string;
  setup: string;
  location: string;
  hud: ShotSlot['hud'];
  /** Target cut length in seconds. */
  duration: ShotSlot['duration'];
  handle: number;
  recordSeconds: number;
  alternates: string[];
  entities: CaptureEntityRef[];
  notes: string;
  takes: number;
}

export interface CaptureGroup {
  /** Stable id derived from the grouping key, e.g. `forest|boss arena|ent_warden`. */
  key: string;
  location: string;
  setup: string;
  /** Featured entity (the shot's first entity), or null. */
  entity: CaptureEntityRef | null;
  items: CaptureItem[];
  total: number;
  done: number;
}

export interface CapturePlan {
  storyboardId: string;
  storyboardRevision: number;
  groups: CaptureGroup[];
  /** Shots the user marked as skipped, in storyboard order. */
  skippedSlotIds: string[];
  total: number;
  done: number;
  /** Sum of recordSeconds over items still to record. */
  todoRecordSeconds: number;
}

export interface CapturePlanOptions {
  /** `todo` keeps only shots still to (re)record. Default `all` (done items are ticked). */
  include?: 'all' | 'todo';
}

const isTodo = (s: SlotStatus): boolean => s === 'empty' || s === 'rejected';

/** Grouping key part: locale-independent, case- and whitespace-insensitive. */
function norm(s: string): string {
  return s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Code-unit comparison: identical on every machine, unlike localeCompare. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Empty values sort after named ones. */
function cmpPart(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '') return 1;
  if (b === '') return -1;
  return cmp(a, b);
}

interface Draft {
  item: CaptureItem;
  order: number | undefined;
  locKey: string;
  setupKey: string;
  entityKey: string;
  /** Entities sort by name, then id, so groups read alphabetically. */
  entitySort: string;
}

/**
 * Builds the capture checklist from the storyboard: one item per shot slot (cards are
 * generated, never recorded; skipped shots are listed separately), grouped by location,
 * then setup, then featured entity so each level load and setup change happens once.
 * Pure and deterministic: no clock, randomness or locale; the input is not mutated.
 * Locked sections are included: a lock protects storyboard content, not the recording.
 */
export function buildCapturePlan(
  storyboard: Pick<Storyboard, 'id' | 'revision' | 'sections'>,
  knowledge: readonly KnowledgeEntity[],
  options: CapturePlanOptions = {},
): CapturePlan {
  const include = options.include ?? 'all';
  const byId = new Map(knowledge.map((e) => [e.id, e]));
  const entityRef = (id: string): CaptureEntityRef => {
    const e = byId.get(id);
    return e
      ? { id, name: e.name, kind: e.kind, excludedFromLlm: e.excludedFromLlm }
      : { id, name: id, kind: null, excludedFromLlm: true };
  };

  const drafts: Draft[] = [];
  const skippedSlotIds: string[] = [];
  let shotNumber = 0;
  for (const section of storyboard.sections) {
    for (const slot of section.slots) {
      if (slot.kind !== 'shot') continue;
      shotNumber += 1;
      const capture = readCaptureExt(slot);
      if (capture.skipped) {
        skippedSlotIds.push(slot.id);
        continue;
      }
      if (include === 'todo' && !isTodo(slot.status)) continue;
      drafts.push(draft(section, slot, shotNumber, capture, entityRef));
    }
  }

  drafts.sort(
    (a, b) =>
      cmpPart(a.locKey, b.locKey) ||
      cmpPart(a.setupKey, b.setupKey) ||
      cmpPart(a.entitySort, b.entitySort) ||
      cmp(a.entityKey, b.entityKey) ||
      (a.order ?? Infinity) - (b.order ?? Infinity) ||
      a.item.shotNumber - b.item.shotNumber,
  );

  const groups: CaptureGroup[] = [];
  for (const d of drafts) {
    const key = `${d.locKey}|${d.setupKey}|${d.entityKey}`;
    let g = groups.at(-1);
    if (!g || g.key !== key) {
      // Labels come from the group's first shot in storyboard order, not sort order.
      g = { key, location: '', setup: '', entity: null, items: [], total: 0, done: 0 };
      groups.push(g);
    }
    g.items.push(d.item);
  }
  for (const g of groups) {
    const first = g.items.reduce((a, b) => (b.shotNumber < a.shotNumber ? b : a));
    g.location = first.location.trim();
    g.setup = first.setup.trim();
    g.entity = first.entities[0] ?? null;
    g.total = g.items.length;
    g.done = g.items.filter((i) => !i.todo).length;
  }

  return {
    storyboardId: storyboard.id,
    storyboardRevision: storyboard.revision,
    groups,
    skippedSlotIds,
    total: drafts.length,
    done: drafts.filter((d) => !d.item.todo).length,
    todoRecordSeconds: drafts.reduce((s, d) => s + (d.item.todo ? d.item.recordSeconds : 0), 0),
  };
}

function draft(
  section: Section,
  slot: ShotSlot,
  shotNumber: number,
  capture: CaptureSlotExt,
  entityRef: (id: string) => CaptureEntityRef,
): Draft {
  const { handle, recordSeconds } = capturePadding(slot);
  const entities = [...new Set(slot.entityIds)].map(entityRef);
  const item: CaptureItem = {
    slotId: slot.id,
    sectionId: section.id,
    sectionName: section.name,
    shotNumber,
    title: slot.title,
    purpose: slot.purpose,
    priority: slot.priority,
    status: slot.status,
    todo: isTodo(slot.status),
    instruction: slot.captureInstruction,
    framing: slot.framing,
    setup: slot.setup,
    location: slot.location,
    hud: slot.hud,
    duration: { ...slot.duration },
    handle,
    recordSeconds,
    alternates: [...slot.alternates],
    entities,
    notes: capture.notes,
    takes: capture.takes,
  };
  return {
    item,
    order: capture.order,
    locKey: norm(slot.location),
    setupKey: norm(slot.setup),
    entityKey: entities[0]?.id ?? '',
    entitySort: entities[0] ? norm(entities[0].name) || entities[0].id : '',
  };
}
