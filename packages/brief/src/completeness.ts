import type { ResolvedBriefRequirement, ResolvedVideoType } from '@trailerforge/plugin-api';
import type { Assumption, Project } from '@trailerforge/schema';
import { FORMAT_PRESETS } from './formats.js';
import { getAt } from './path.js';

/** Values people type when they don't know yet. Treated as missing, not as answers. */
const PLACEHOLDER =
  /^(tbd|tba|tbc|todo|n\/?a|none|unknown|\?+|-+|x{2,}|placeholder|lorem\b.*|coming soon)$/i;

export type MissingReason = 'missing' | 'too-few' | 'placeholder';

export interface MissingItem {
  requirement: ResolvedBriefRequirement;
  reason: MissingReason;
  /** Entries present, for `too-few`. */
  have?: number;
}

export interface CompletenessReport {
  videoTypeId: string;
  /** Weighted share of requirements satisfied by real values, 0..1. */
  score: number;
  /** Every required item has a real value. */
  complete: boolean;
  /** Every required item has a real value or a logged assumption. */
  canProceed: boolean;
  satisfied: ResolvedBriefRequirement[];
  missing: MissingItem[];
  /** Required or optional items covered only by an assumption. */
  assumed: { requirement: ResolvedBriefRequirement; assumption: Assumption }[];
}

type Fill = { ok: true } | { ok: false; reason: MissingReason; have?: number };

function fill(value: unknown, minItems = 1): Fill {
  if (value === undefined || value === null) return { ok: false, reason: 'missing' };
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return { ok: false, reason: 'missing' };
    return PLACEHOLDER.test(t) ? { ok: false, reason: 'placeholder' } : { ok: true };
  }
  if (Array.isArray(value)) {
    const real = value.filter((v) => fill(v).ok);
    if (real.length === 0) return { ok: false, reason: value.length ? 'placeholder' : 'missing' };
    return real.length >= minItems
      ? { ok: true }
      : { ok: false, reason: 'too-few', have: real.length };
  }
  if (typeof value === 'object')
    return Object.keys(value).length ? { ok: true } : { ok: false, reason: 'missing' };
  return { ok: true }; // numbers, booleans
}

/** Check a project against a video type's requirements. Pure; never guesses. */
export function checkCompleteness(
  project: Project,
  videoType: ResolvedVideoType,
): CompletenessReport {
  const satisfied: ResolvedBriefRequirement[] = [];
  const missing: MissingItem[] = [];
  const assumed: CompletenessReport['assumed'] = [];
  const assumptions = new Map(project.brief.assumptions.map((a) => [a.field, a]));

  for (const req of videoType.requirements) {
    const results = [req.field, ...req.anyOf].map((p) => fill(getAt(project, p), req.minItems));
    if (results.some((r) => r.ok)) {
      satisfied.push(req);
      continue;
    }
    const assumption = assumptions.get(req.field);
    if (assumption) {
      assumed.push({ requirement: req, assumption });
      continue;
    }
    const primary = results[0] as Exclude<Fill, { ok: true }>;
    missing.push({
      requirement: req,
      reason: primary.reason,
      ...(primary.have !== undefined ? { have: primary.have } : {}),
    });
  }

  const total = videoType.requirements.reduce((n, r) => n + r.weight, 0);
  const got = satisfied.reduce((n, r) => n + r.weight, 0);
  const requiredMissing = missing.some((m) => m.requirement.required);
  const requiredAssumed = assumed.some((a) => a.requirement.required);
  return {
    videoTypeId: videoType.id,
    score: total ? got / total : 1,
    complete: !requiredMissing && !requiredAssumed,
    canProceed: !requiredMissing,
    satisfied,
    missing,
    assumed,
  };
}

export interface Question {
  /** The requirement's path; answers are written here. */
  id: string;
  label: string;
  required: boolean;
  input: ResolvedBriefRequirement['input'];
  choices?: string[];
  minItems?: number;
  help?: string;
  /** Why we're asking, e.g. "Add at least 3 (you have 1)". */
  why: string;
  /** "Suggest for me" is always available. */
  canSuggest: true;
  /** Present when the field is currently covered by an assumption the user may replace. */
  assumption?: Assumption;
}

/**
 * Questions for what is missing only: required ones first, then optional ones, in the video
 * type's order. Assumed items are not asked again.
 */
export function buildQuestionnaire(
  report: CompletenessReport,
  opts: { includeAssumed?: boolean } = {},
): Question[] {
  const items: (MissingItem & { assumption?: Assumption })[] = [
    ...report.missing,
    ...(opts.includeAssumed
      ? report.assumed.map((a) => ({
          requirement: a.requirement,
          reason: 'missing' as const,
          assumption: a.assumption,
        }))
      : []),
  ];
  const order = new Map(
    report.satisfied.concat(items.map((i) => i.requirement)).map((r, i) => [r, i]),
  );
  const ordered = items.sort(
    (a, b) =>
      Number(b.requirement.required) - Number(a.requirement.required) ||
      order.get(a.requirement)! - order.get(b.requirement)!,
  );
  return ordered.map(({ requirement: r, reason, have, assumption }) => {
    const choices =
      r.choices ?? (r.field === 'formatTargets' ? FORMAT_PRESETS.map((f) => f.name) : undefined);
    const why =
      reason === 'too-few'
        ? `Add at least ${r.minItems} (you have ${have})`
        : reason === 'placeholder'
          ? 'This still looks like a placeholder'
          : assumption
            ? 'Currently assumed; answer to replace the assumption'
            : r.required
              ? 'Needed for this video type'
              : 'Optional, but it makes the result better';
    return {
      id: r.field,
      label: r.label,
      required: r.required,
      input: r.input,
      ...(choices ? { choices } : {}),
      ...(r.minItems ? { minItems: r.minItems } : {}),
      ...(r.help ? { help: r.help } : {}),
      why,
      canSuggest: true,
      ...(assumption ? { assumption } : {}),
    };
  });
}
