import {
  builtinFilters,
  flashEvents,
  flashViolations,
  type FilterRegistry,
  type FlashEvent,
} from '@trailerforge/effects';
import {
  FLICKS_PER_SECOND,
  flicksPerFrame,
  itemEnd,
  type DecisionRecord,
  type Timeline,
  type TimelineItem,
} from '@trailerforge/schema';
import { stableHash, type TakeSource } from './rough-cut.js';

/**
 * The Quality Gate's checks on the plan (the version's timeline, before anything is rendered),
 * its blocking policy and the verdict. Pure and browser-safe; the checks on the rendered file
 * live in `@trailerforge/media` (`quality-measure.ts`) and use the same finding shape.
 *
 * Policy (confirmed 2026-10-28): `hard` errors block with no override (photosensitive flash
 * risk, true peak, clipping, placeholders or missing media, the wrong size, rate or length);
 * `override` errors block until the user overrides them with a reason, which goes to the
 * decision log (loudness, black or flash frames, text outside title-safe, A/V sync); the rest
 * are warnings (jump cuts, read time, pacing, screen direction, off-beat cuts, brand contrast).
 */

export const QUALITY_GATE_VERSION = 1;

export type GateTier = 'hard' | 'override' | 'warning';

export interface GateFinding {
  checkId: string;
  severity: 'error' | 'warning' | 'info';
  /** For errors: whether an override can let the export through. */
  tier?: GateTier;
  message: string;
  /** Seconds into the version. */
  at?: { start: number; end?: number };
  /** The timeline item it is about, when there is one. */
  itemId?: string;
  suggestion?: string;
}

export const GATE_POLICY: Readonly<Record<string, GateTier>> = {
  'core/flash-risk': 'hard',
  'core/flash-plan': 'hard',
  'core/true-peak': 'hard',
  'core/clipping': 'hard',
  'core/placeholders': 'hard',
  'core/missing-media': 'hard',
  'core/output-format': 'hard',
  'core/loudness': 'override',
  'core/black-frames': 'override',
  'core/flash-frames': 'override',
  'core/safe-area': 'override',
  'core/av-sync': 'override',
  'core/jump-cut': 'warning',
  'core/read-time': 'warning',
  'core/pacing': 'warning',
  'core/screen-direction': 'warning',
  'core/off-beat': 'warning',
  'core/contrast': 'warning',
};

/** A finding with the policy's tier and severity (unknown checks are warnings). */
export function finding(
  checkId: string,
  message: string,
  extra: Omit<GateFinding, 'checkId' | 'message' | 'severity' | 'tier'> = {},
): GateFinding {
  const tier = GATE_POLICY[checkId] ?? 'warning';
  return {
    checkId,
    severity: tier === 'warning' ? 'warning' : 'error',
    tier,
    message,
    ...extra,
  };
}

export interface PlanCheckInput {
  /** The version's timeline (derived, or the master). */
  timeline: Timeline;
  /** Recording lengths and footage analysis per asset id; a clip whose asset is absent is missing. */
  sources?: ReadonlyMap<string, TakeSource>;
  /** Beat times (flicks) of the resolved music grid, for the off-beat check. */
  beats?: readonly number[];
  leadFrames?: number;
  /** Installed transitions and effects (their declared flashes). */
  filters?: FilterRegistry;
  /** `checkScene` messages per card or caption item (from `@trailerforge/graphics`). */
  graphicsIssues?: readonly { itemId: string; messages: readonly string[] }[];
  /** Brand contrast problems (`checkBrandContrast`), as sentences. */
  contrastIssues?: readonly string[];
}

const sec = (fl: number) => Math.round((fl / FLICKS_PER_SECOND) * 1000) / 1000;
const span = (it: TimelineItem) => ({ start: sec(it.start), end: sec(itemEnd(it)) });
const label = (it: TimelineItem) => it.label ?? it.slotId ?? it.id;

export function checkPlan(input: PlanCheckInput): GateFinding[] {
  const { timeline } = input;
  const out: GateFinding[] = [];
  const fpf = flicksPerFrame(timeline.frameRate);
  const picture = timeline.tracks.filter((t) => t.kind === 'video' && !t.muted);

  // Placeholders and missing recordings: a finished file must not show a slate.
  for (const tr of timeline.tracks) {
    if (tr.muted || tr.kind === 'audio' || tr.kind === 'caption') continue;
    for (const it of tr.items) {
      if (it.kind === 'placeholder')
        out.push(
          finding('core/placeholders', `"${label(it)}" is still a placeholder`, {
            at: span(it),
            itemId: it.id,
            suggestion: 'Record the shot and attach it, or remove the slot',
          }),
        );
      else if (it.kind === 'clip' && input.sources && !input.sources.has(it.assetId))
        out.push(
          finding('core/missing-media', `the recording for "${label(it)}" cannot be found`, {
            at: span(it),
            itemId: it.id,
            suggestion: 'Relink the file in the library, or swap the take',
          }),
        );
    }
  }
  for (const tr of timeline.tracks)
    if (tr.kind === 'audio' && !tr.muted)
      for (const it of tr.items)
        if (it.kind === 'clip' && input.sources && !input.sources.has(it.assetId))
          out.push(
            finding('core/missing-media', `the sound file for "${label(it)}" cannot be found`, {
              at: span(it),
              itemId: it.id,
            }),
          );

  // Declared flashes of transitions and effects.
  const filters = input.filters ?? builtinFilters();
  const events: FlashEvent[] = [];
  const ctx = (duration: number) => ({
    width: timeline.resolution.width,
    height: timeline.resolution.height,
    rate: timeline.frameRate,
    duration: duration / FLICKS_PER_SECOND,
  });
  for (const tr of timeline.tracks) {
    if (tr.kind === 'audio' || tr.muted) continue;
    for (const t of tr.transitions) {
      const def = filters.get(t.transitionId);
      const to = tr.items.find((i) => i.id === t.toItemId);
      if (def?.kind !== 'transition' || !to) continue;
      try {
        events.push(...flashEvents(def, t.params, ctx(t.duration), sec(to.start - t.duration / 2)));
      } catch {
        // bad params: the compiler reports them
      }
    }
    for (const it of tr.items) {
      if (!('effects' in it)) continue;
      for (const e of it.effects) {
        const def = filters.get(e.effectId);
        if (!e.enabled || def?.kind !== 'effect') continue;
        try {
          events.push(...flashEvents(def, e.params, ctx(it.duration), sec(it.start)));
        } catch {
          // reported at compile
        }
      }
    }
  }
  for (const v of flashViolations(events))
    out.push(
      finding(
        'core/flash-plan',
        `${v.count} flashes in one second (${v.sources.join(', ')}): unsafe for viewers with photosensitive epilepsy`,
        {
          at: { start: v.from, end: v.to },
          suggestion: 'Remove or space out the flashing transitions and effects',
        },
      ),
    );

  // Jump cuts and screen direction between touching clips on a picture track.
  for (const tr of picture) {
    const items = [...tr.items].sort((a, b) => a.start - b.start);
    for (let i = 1; i < items.length; i++) {
      const a = items[i - 1]!;
      const b = items[i]!;
      if (a.kind !== 'clip' || b.kind !== 'clip' || itemEnd(a) !== b.start) continue;
      if (a.assetId === b.assetId) {
        const skip = b.sourceIn - (a.sourceIn + a.duration * a.speed);
        if (Math.abs(skip) > fpf && Math.abs(skip) < 2 * FLICKS_PER_SECOND)
          out.push(
            finding(
              'core/jump-cut',
              `"${label(a)}" cuts to the same recording ${sec(Math.abs(skip))} s ${skip > 0 ? 'later' : 'earlier'}: a jump cut`,
              {
                at: { start: sec(b.start) },
                itemId: b.id,
                suggestion: 'Use a different take or angle, or cover the cut with a transition',
              },
            ),
          );
      }
      const da = direction(a, input.sources);
      const db = direction(b, input.sources);
      if (da !== 0 && db !== 0 && Math.sign(da) !== Math.sign(db))
        out.push(
          finding(
            'core/screen-direction',
            `the action moves ${da > 0 ? 'right' : 'left'} in "${label(a)}" and ${db > 0 ? 'right' : 'left'} in "${label(b)}": the cut may read as a reversal`,
            {
              at: { start: sec(b.start) },
              itemId: b.id,
              suggestion: 'Swap one of the takes, or put a neutral shot or a card between them',
            },
          ),
        );
    }
  }

  // Pacing: trailers speed up; shots in the last third should not be much longer than the first.
  const shots = picture
    .flatMap((t) => t.items)
    .filter((i) => i.kind === 'clip')
    .sort((a, b) => a.start - b.start);
  if (shots.length >= 6) {
    const end = itemEnd(shots.at(-1)!);
    const first = shots.filter((s) => s.start < end / 3);
    const last = shots.filter((s) => s.start >= (2 * end) / 3);
    const mean = (xs: TimelineItem[]) => xs.reduce((n, x) => n + x.duration, 0) / xs.length;
    if (first.length && last.length && mean(last) > 1.25 * mean(first))
      out.push(
        finding(
          'core/pacing',
          `shots in the last third average ${sec(mean(last))} s against ${sec(mean(first))} s in the first: the cut slows down`,
          { suggestion: 'Shorten the late shots or move a long one earlier' },
        ),
      );
  }

  // Cuts off the beat (only on picture cuts; cards and captions follow their own timing).
  if (input.beats?.length) {
    const lead = input.leadFrames ?? 1;
    const beats = [...input.beats].sort((x, y) => x - y);
    const cuts = [
      ...new Set(
        picture
          .flatMap((t) => t.items)
          .map((i) => i.start)
          .filter((s) => s > 0),
      ),
    ].sort((x, y) => x - y);
    for (const c of cuts) {
      const near = beats.some((m) => m - c >= -fpf / 2 && m - c <= (lead + 1) * fpf);
      if (!near)
        out.push(
          finding('core/off-beat', `the cut at ${sec(c)} s is off the beat`, {
            at: { start: sec(c) },
            suggestion: 'Trim to the previous or next beat in the Cut tab',
          }),
        );
    }
  }

  // Cards and captions: safe area and reading time.
  for (const g of input.graphicsIssues ?? []) {
    const it = timeline.tracks.flatMap((t) => t.items).find((i) => i.id === g.itemId);
    for (const m of g.messages) {
      const id = /outside the safe area/.test(m)
        ? 'core/safe-area'
        : /reading it takes/.test(m)
          ? 'core/read-time'
          : undefined;
      if (!id) continue;
      out.push(finding(id, m, { ...(it ? { at: span(it) } : {}), itemId: g.itemId }));
    }
  }
  for (const c of input.contrastIssues ?? []) out.push(finding('core/contrast', c));
  return sortFindings(out);
}

/**
 * Mean horizontal speed of the action over the used part of a clip, in frame widths per second;
 * 0 when unknown or too slow to read as a direction (under 5% of the width a second).
 */
function direction(
  clip: Extract<TimelineItem, { kind: 'clip' }>,
  sources?: ReadonlyMap<string, TakeSource>,
): number {
  const f = sources?.get(clip.assetId)?.footage;
  if (!f?.focus?.length) return 0;
  const fps = f.rate.num / f.rate.den;
  const from = Math.max(0, Math.floor((clip.sourceIn / FLICKS_PER_SECOND) * fps));
  const to = Math.min(
    f.focus.length,
    Math.ceil(((clip.sourceIn + clip.duration * clip.speed) / FLICKS_PER_SECOND) * fps),
  );
  const xs: { i: number; x: number }[] = [];
  for (let i = from; i < to; i++) {
    const p = f.focus[i];
    if (p) xs.push({ i, x: p[0]! / 1000 });
  }
  if (xs.length < Math.max(3, (to - from) / 3)) return 0;
  // Least-squares slope of x against time.
  const n = xs.length;
  const mt = xs.reduce((s, p) => s + p.i, 0) / n;
  const mx = xs.reduce((s, p) => s + p.x, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of xs) {
    num += (p.i - mt) * (p.x - mx);
    den += (p.i - mt) ** 2;
  }
  const v = den ? (num / den) * fps : 0;
  return Math.abs(v) >= 0.05 ? v : 0;
}

const SEVERITY = { error: 0, warning: 1, info: 2 } as const;

/** Stable order: errors first, then by time, then by check and message. */
export function sortFindings<T extends GateFinding>(fs: readonly T[]): T[] {
  return [...fs].sort(
    (a, b) =>
      SEVERITY[a.severity] - SEVERITY[b.severity] ||
      (a.at?.start ?? -1) - (b.at?.start ?? -1) ||
      (a.checkId < b.checkId ? -1 : a.checkId > b.checkId ? 1 : 0) ||
      (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
  );
}

export interface GateOverride {
  checkId: string;
  reason: string;
}

export interface GateVerdict {
  /** True when the export may go ahead. */
  allowed: boolean;
  /** Errors nothing can let through. */
  blocking: GateFinding[];
  /** Errors that need an override (with a reason) first. */
  needsOverride: GateFinding[];
  /** Errors let through by an override. */
  overridden: (GateFinding & { reason: string })[];
  warnings: GateFinding[];
}

/** What the findings mean for an export, given the user's overrides (one per check id). */
export function gateVerdict(
  findings: readonly GateFinding[],
  overrides: readonly GateOverride[] = [],
): GateVerdict {
  const by = new Map(overrides.filter((o) => o.reason.trim()).map((o) => [o.checkId, o.reason]));
  const v: GateVerdict = {
    allowed: true,
    blocking: [],
    needsOverride: [],
    overridden: [],
    warnings: [],
  };
  for (const f of sortFindings(findings)) {
    if (f.severity !== 'error') {
      v.warnings.push(f);
      continue;
    }
    const tier = f.tier ?? GATE_POLICY[f.checkId] ?? 'hard';
    if (tier === 'hard') v.blocking.push(f);
    else if (by.has(f.checkId)) v.overridden.push({ ...f, reason: by.get(f.checkId)! });
    else v.needsOverride.push(f);
  }
  v.allowed = v.blocking.length === 0 && v.needsOverride.length === 0;
  return v;
}

/** The decision record that logs an override (for `appendDecisions`). */
export function overrideDecision(input: {
  override: GateOverride;
  variantId: string;
  planHash: string;
  findings: readonly GateFinding[];
  now: Date;
}): DecisionRecord {
  const { override, variantId, planHash } = input;
  const tier = GATE_POLICY[override.checkId] ?? 'hard';
  if (tier !== 'override')
    throw new Error(
      `${override.checkId} cannot be overridden (${tier === 'hard' ? 'it always blocks' : 'it is only a warning'})`,
    );
  if (!override.reason.trim()) throw new Error('an override needs a reason');
  const about = input.findings.filter((f) => f.checkId === override.checkId).map((f) => f.message);
  return {
    id: `qc_${stableHash(`${variantId}|${planHash}|${override.checkId}`)}`,
    at: input.now.toISOString(),
    step: 'core/quality-gate',
    subject: { kind: 'timeline', id: `tl_${variantId}`.slice(0, 64) },
    choice: { override: override.checkId, planHash },
    reasons: { findings: about },
    summary: `Exported despite "${override.checkId.replace(/^core\//, '')}": ${override.reason.trim()}`,
    alternatives: [],
  };
}
