import type { Project, TakeMatch } from '@trailerforge/schema';
import { buildCapturePlan, type CaptureItem } from './capture.js';
import { matchRecordingName, shotCodes } from './shot-codes.js';

/**
 * Suggests which storyboard shot each imported recording belongs to. Pure and deterministic
 * (same project and recordings, in any order, give the same answer) and browser-safe.
 *
 * Only a shot code in the file name attaches a recording on its own. Everything else is a ranked
 * suggestion with a reason per signal, for the user to confirm:
 * - vision: how much the frames resemble the shot's description (opt-in local model; ranked
 *   among the shots for that recording, so the model's absolute scale does not matter);
 * - order: people record roughly in checklist order, so recordings sorted by time are aligned to
 *   the checklist (a monotone alignment that may skip junk files and unrecorded shots);
 * - length: a recording shorter than the cut needs cannot be the shot; one near the suggested
 *   record length fits best;
 * - session: recordings made in one sitting as coded ones are likely from the same capture group.
 */

export interface MatchRecording {
  assetId: string;
  /** Original file name (shot codes and take numbers are read from it). */
  name: string;
  /** When the file was last written (the end of the recording), ISO. */
  recordedAt?: string;
  durationSec?: number;
}

export type MatchSignal = 'code' | 'vision' | 'order' | 'length' | 'session';

export interface MatchReason {
  signal: MatchSignal;
  /** 0–1: how strongly this signal points at the shot. */
  score: number;
  /** 0–1: how much the signal counted (vision counts less when no shot stands out). */
  weight?: number;
  detail: string;
}

export interface MatchCandidate {
  slotId: string;
  /** 0–1, weighted over the signals that were available. */
  score: number;
  reasons: MatchReason[];
}

export interface RecordingMatch {
  assetId: string;
  /** `code`: attach automatically; `ambiguous-code`: the name has codes of several shots. */
  kind: 'code' | 'ambiguous-code' | 'suggested' | 'none';
  confidence: 'certain' | 'high' | 'medium' | 'low';
  /** Best first, at most three. */
  candidates: MatchCandidate[];
  /** Take number read from the file name (`take2`). */
  take: number | null;
  /** Codes in the name that are no shot in this project. */
  unknownCodes: string[];
}

export interface MatchInput {
  project: Project;
  recordings: MatchRecording[];
  /** assetId → slotId → similarity from the vision model (any scale). */
  vision?: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** A pause longer than this starts a new recording session (default 10 minutes). */
  sessionGapSec?: number;
}

const WEIGHTS: Record<Exclude<MatchSignal, 'code'>, number> = {
  vision: 0.35,
  order: 0.3,
  length: 0.2,
  session: 0.15,
};
const NEEDS_FOOTAGE_BONUS = 0.05;
/** A recording shorter than the shot's minimum cut cannot fill it, however well the rest fits. */
const TOO_SHORT_CAP = 0.25;
const TOO_SHORT = 0.05;
/** A recording joins the order alignment only if it fits a shot at least this well. */
const ALIGN_THRESHOLD = 0.3;
/** Cost of a second take on the same shot in the alignment (takes are the exception). */
const REPEAT_COST = 0.25;

interface Shot {
  slotId: string;
  pos: number;
  groupKey: string;
  groupLabel: string;
  title: string;
  item: CaptureItem;
  needsFootage: boolean;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const round = (x: number) => Math.round(x * 1000) / 1000;

export function suggestMatches(input: MatchInput): { matches: RecordingMatch[] } {
  const { project } = input;
  const sb = project.storyboard;
  if (!sb) return { matches: [] };

  // Shots in checklist order (skipped shots are not in the plan).
  const plan = buildCapturePlan(sb, project.knowledge);
  const slotById = new Map(sb.sections.flatMap((s) => s.slots).map((s) => [s.id, s]));
  const shots: Shot[] = [];
  for (const g of plan.groups) {
    for (const item of g.items) {
      const slot = slotById.get(item.slotId);
      const takes = slot?.kind === 'shot' ? slot.takes.filter((t) => !t.rejected).length : 0;
      shots.push({
        slotId: item.slotId,
        pos: shots.length,
        groupKey: g.key,
        groupLabel: [g.location, g.setup].filter(Boolean).join(' · ') || 'Anywhere',
        title: item.title || item.slotId,
        item,
        needsFootage: takes === 0 && item.status !== 'approved',
      });
    }
  }
  const shotIndex = new Map(shots.map((s, j) => [s.slotId, j]));

  // Recordings already attached anywhere are not offered again.
  const attached = new Set(
    sb.sections.flatMap((s) =>
      s.slots.flatMap((x) => (x.kind === 'shot' ? x.takes.map((t) => t.assetId) : [])),
    ),
  );
  const recs = [...new Map(input.recordings.map((r) => [r.assetId, r])).values()]
    .filter((r) => !attached.has(r.assetId))
    .sort(
      (a, b) =>
        cmp(a.recordedAt ?? '', b.recordedAt ?? '') ||
        cmp(a.name, b.name) ||
        cmp(a.assetId, b.assetId),
    );
  if (shots.length === 0) {
    return {
      matches: recs.map((r) => ({
        assetId: r.assetId,
        kind: 'none',
        confidence: 'low',
        candidates: [],
        take: null,
        unknownCodes: [],
      })),
    };
  }

  const codes = shotCodes(project);
  const parsed = recs.map((r) => matchRecordingName(r.name, codes));
  const anchor = parsed.map((p) => {
    const inPlan = p.slotIds.filter((id) => shotIndex.has(id));
    return inPlan.length === 1 ? shotIndex.get(inPlan[0]!)! : -1;
  });

  // Sessions from recording times: start = end - duration.
  const gap = input.sessionGapSec ?? 600;
  const session: number[] = [];
  let lastEnd = Number.NEGATIVE_INFINITY;
  recs.forEach((r, i) => {
    const end = r.recordedAt ? Date.parse(r.recordedAt) / 1000 : Number.NaN;
    if (!Number.isFinite(end)) {
      session.push(-1 - i); // unknown time: a session of its own, with no session signal
      return;
    }
    const start = end - (r.durationSec ?? 0);
    session.push(i > 0 && session[i - 1]! >= 0 && start - lastEnd <= gap ? session[i - 1]! : i);
    lastEnd = end;
  });
  const anchorsBySession = new Map<number, Shot[]>();
  recs.forEach((_, i) => {
    if (anchor[i]! >= 0 && session[i]! >= 0) {
      anchorsBySession.set(session[i]!, [
        ...(anchorsBySession.get(session[i]!) ?? []),
        shots[anchor[i]!]!,
      ]);
    }
  });

  const length = (r: MatchRecording, s: Shot): MatchReason | null => {
    const d = r.durationSec;
    if (d === undefined) return null;
    const min = s.item.duration.min;
    const rec = s.item.recordSeconds;
    let score: number;
    if (d < min * 0.9) score = TOO_SHORT;
    else if (d <= rec) score = 0.5 + (0.5 * (d - min)) / Math.max(0.001, rec - min);
    else score = Math.max(0.3, 1 - 0.25 * Math.log2(d / rec));
    return {
      signal: 'length',
      score: round(Math.min(1, score)),
      detail: `${round(d)} s recording; the shot needs ${min} s, record about ${rec} s`,
    };
  };

  const visionRow = recs.map((r) => {
    const row = input.vision?.get(r.assetId);
    if (!row) return null;
    const vals = shots.map((s) => row.get(s.slotId));
    const known = vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (known.length < 2) return null;
    const lo = Math.min(...known);
    const hi = Math.max(...known);
    if (hi - lo < 1e-6) return null;
    const ranks = [...known].sort((a, b) => b - a);
    return vals.map((v) =>
      v === undefined
        ? null
        : { score: (v - lo) / (hi - lo), rank: ranks.indexOf(v) + 1, of: known.length },
    );
  });
  const vision = (i: number, j: number): MatchReason | null => {
    const v = visionRow[i]?.[j];
    return v
      ? {
          signal: 'vision',
          score: round(v.score),
          detail: `AI vision: frames resemble this shot (rank ${v.rank} of ${v.of})`,
        }
      : null;
  };

  const sessionReason = (i: number, s: Shot): MatchReason | null => {
    const anchors = anchorsBySession.get(session[i]!);
    if (!anchors?.length || anchor[i]! >= 0) return null;
    const same = anchors.filter((a) => a.groupKey === s.groupKey).length;
    return {
      signal: 'session',
      score: round(same / anchors.length),
      detail: same
        ? `Recorded in the same sitting as ${same} coded take${same === 1 ? '' : 's'} from "${s.groupLabel}"`
        : 'Recorded in a sitting spent on other groups',
    };
  };

  const blend = (rs: (MatchReason | null)[]) => {
    let sum = 0;
    let w = 0;
    for (const r of rs) {
      if (!r || r.signal === 'code') continue;
      const weight = WEIGHTS[r.signal] * (r.weight ?? 1);
      sum += weight * r.score;
      w += weight;
    }
    const score = w > 0 ? sum / w : 0;
    const tooShort = rs.some((r) => r?.signal === 'length' && r.score <= TOO_SHORT);
    return tooShort ? Math.min(score, TOO_SHORT_CAP) : score;
  };

  // Base fit without order, used to align recordings to the checklist.
  const base = recs.map((r, i) =>
    shots.map((s, j) => blend([vision(i, j), length(r, s), sessionReason(i, s)])),
  );
  const aligned = align(recs.length, shots.length, (i, j) => {
    if (anchor[i]! >= 0) return anchor[i] === j ? 10 : Number.NEGATIVE_INFINITY;
    return base[i]![j]! - ALIGN_THRESHOLD;
  });

  const matches: RecordingMatch[] = recs.map((r, i) => {
    const p = parsed[i]!;
    const allowed = p.slotIds.filter((id) => shotIndex.has(id));
    const take = p.take;
    const unknownCodes = p.unknownCodes;
    if (anchor[i]! >= 0) {
      const s = shots[anchor[i]!]!;
      const code = codes.get(s.slotId)!;
      return {
        assetId: r.assetId,
        kind: 'code',
        confidence: 'certain',
        candidates: [
          {
            slotId: s.slotId,
            score: 1,
            reasons: [{ signal: 'code', score: 1, detail: `The file name has shot code ${code}` }],
          },
        ],
        take,
        unknownCodes,
      };
    }
    const pool =
      allowed.length > 1 ? allowed.map((id) => shotIndex.get(id)!) : shots.map((_, j) => j);
    const candidates = pool
      .map((j) => {
        const s = shots[j]!;
        const a = aligned[i]!;
        const order: MatchReason | null =
          a < 0
            ? null
            : {
                signal: 'order',
                score: a === j ? 1 : Math.abs(a - j) === 1 ? 0.6 : 0,
                detail:
                  a === j
                    ? 'Fits where it falls in the recording order of the checklist'
                    : Math.abs(a - j) === 1
                      ? 'Next to where it falls in the recording order'
                      : 'Out of the checklist order',
              };
        const reasons = [vision(i, j), order, length(r, s), sessionReason(i, s)].filter(
          (x): x is MatchReason => x !== null,
        );
        if (allowed.length > 1)
          reasons.unshift({
            signal: 'code',
            score: 0.5,
            detail: `The file name has the codes of several shots, including ${codes.get(s.slotId)}`,
          });
        const fit = blend(reasons);
        const score = Math.min(
          1,
          fit + (s.needsFootage && fit > TOO_SHORT_CAP ? NEEDS_FOOTAGE_BONUS : 0),
        );
        return { slotId: s.slotId, score: round(score), reasons, pos: j };
      })
      .sort((a, b) => b.score - a.score || a.pos - b.pos)
      .slice(0, 3)
      .map(({ pos: _pos, ...c }) => c);
    const [top, second] = candidates;
    const margin = (top?.score ?? 0) - (second?.score ?? 0);
    // High confidence also needs the length not to argue against it (a much longer file may hold
    // the shot, but the user should confirm that).
    // Without a confident vision signal, neighbouring shots are easy to confuse: ask for a wider gap.
    const visionCounts = (top?.reasons.find((x) => x.signal === 'vision')?.weight ?? 0) >= 0.5;
    const lengthOk = (top?.reasons.find((x) => x.signal === 'length')?.score ?? 1) >= 0.5;
    const confidence = !top
      ? 'low'
      : top.score >= 0.7 && margin >= (visionCounts ? 0.15 : 0.25) && lengthOk
        ? 'high'
        : top.score >= 0.5
          ? 'medium'
          : 'low';
    return {
      assetId: r.assetId,
      kind: allowed.length > 1 ? 'ambiguous-code' : top ? 'suggested' : 'none',
      confidence,
      candidates,
      take,
      unknownCodes,
    };
  });
  return { matches };
}

/**
 * Monotone alignment of recordings (in time order) to shots (in checklist order): each recording
 * is skipped, stays on the previous recording's shot (another take, at a small cost), or moves on
 * to a later shot. Maximises the total `gain`; returns the shot index per recording or -1.
 */
function align(n: number, m: number, gain: (i: number, j: number) => number): number[] {
  const NEG = Number.NEGATIVE_INFINITY;
  // last[j]: best total so far with the latest assigned recording on shot j.
  let last = new Array<number>(m).fill(NEG);
  // move[i][j]: how recording i got to shot j (-2 skip/carry, -1 repeat, k >= 0 advanced from
  // shot k, or m for "first assignment").
  const move: Int32Array[] = [];
  for (let i = 0; i < n; i++) {
    const next = last.slice();
    const mv = new Int32Array(m).fill(-2);
    let bestBefore = 0; // the empty start
    let argBefore = m;
    for (let j = 0; j < m; j++) {
      const g = gain(i, j);
      if (g !== NEG) {
        const advance = bestBefore + g;
        const repeat = last[j]! === NEG ? NEG : last[j]! + g - REPEAT_COST;
        if (advance > next[j]! && advance >= repeat) {
          next[j] = advance;
          mv[j] = argBefore;
        } else if (repeat > next[j]!) {
          next[j] = repeat;
          mv[j] = -1;
        }
      }
      if (last[j]! > bestBefore) {
        bestBefore = last[j]!;
        argBefore = j;
      }
    }
    move.push(mv);
    last = next;
  }
  const out = new Array<number>(n).fill(-1);
  let j = -1;
  let best = 0;
  last.forEach((v, k) => {
    if (v > best) {
      best = v;
      j = k;
    }
  });
  for (let i = n - 1; i >= 0 && j >= 0 && j < m; i--) {
    const mv = move[i]![j]!;
    if (mv === -2) continue; // recording i not assigned; state carried from before
    out[i] = j;
    if (mv >= 0) j = mv; // advanced from shot mv (or m: the start)
  }
  return out;
}

/**
 * Commands payload (`core/takes.attach-many`) that accepts every code match and every suggestion
 * at or above `minConfidence`, each recording to its best shot. One undo step.
 */
export function acceptMatchesPayload(
  matches: RecordingMatch[],
  opts: { minConfidence?: 'certain' | 'high' | 'medium'; attachedAt?: string } = {},
): { items: { slotId: string; assetId: string; matchedBy: TakeMatch; attachedAt?: string }[] } {
  const order = ['low', 'medium', 'high', 'certain'];
  const min = order.indexOf(opts.minConfidence ?? 'high');
  const items = matches
    .filter(
      (m) =>
        m.candidates.length > 0 &&
        m.kind !== 'ambiguous-code' &&
        order.indexOf(m.confidence) >= min,
    )
    .map((m) => {
      const best = m.candidates[0]!;
      const byVision = best.reasons.some((r) => r.signal === 'vision' && r.score >= 0.9);
      const matchedBy: TakeMatch = m.kind === 'code' ? 'code' : byVision ? 'vision' : 'suggestion';
      return {
        slotId: best.slotId,
        assetId: m.assetId,
        matchedBy,
        ...(opts.attachedAt ? { attachedAt: opts.attachedAt } : {}),
      };
    });
  return { items };
}
