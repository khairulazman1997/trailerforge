import { FLICKS_PER_SECOND, type ApprovalState, type ReviewComment } from '@trailerforge/schema';

/** Pure helpers for the Review tab: labels, grouping, time. */

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

export const APPROVAL_LABEL: Record<ApprovalState, { text: string; tone: Tone; hint: string }> = {
  none: { text: 'Not approved', tone: 'muted', hint: 'Nobody has signed this version off yet.' },
  approved: {
    text: 'Approved',
    tone: 'ok',
    hint: 'Approved as it is now. Comments do not change that.',
  },
  stale: {
    text: 'Approval out of date',
    tone: 'warn',
    hint: 'The picture, graphics or sound changed after it was approved. Approve again after a look.',
  },
};

export const versionKey = (variantId: string | null) => variantId ?? 'master';

export const seconds = (flicks: number) => flicks / FLICKS_PER_SECOND;
export const toFlicks = (s: number) => Math.round(s * FLICKS_PER_SECOND);

/** 83.4 → "1:23.4"; under a minute "5.2". */
export function formatTime(s: number): string {
  const t = Math.max(0, s);
  const m = Math.floor(t / 60);
  const rest = t - m * 60;
  const r = (Math.round(rest * 10) / 10).toFixed(1);
  return m ? `${m}:${r.padStart(4, '0')}` : r;
}

/** "1:23.4", "83.4" or "83" → seconds; null when it is not a time. */
export function parseTime(text: string): number | null {
  const t = text.trim();
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  const v = Number(m[1] ?? 0) * 60 + Number(m[2]);
  return Number.isFinite(v) ? v : null;
}

/** Position on a ruler as a percentage, kept inside it. */
export function percentAt(at: number, duration: number): number {
  if (!(duration > 0)) return 0;
  return Math.round(Math.min(1, Math.max(0, at / duration)) * 10_000) / 100;
}

export function commentsFor(
  comments: readonly ReviewComment[],
  variantId: string | null,
): ReviewComment[] {
  return comments
    .filter((c) => c.variantId === variantId)
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

export interface GateFindingView {
  checkId: string;
  severity: 'error' | 'warning' | 'info';
  tier?: 'hard' | 'override' | 'warning' | undefined;
  message: string;
  at?: { start: number; end?: number | undefined } | undefined;
  suggestion?: string | undefined;
}

export interface GateGroups {
  blocking: GateFindingView[];
  needsOverride: GateFindingView[];
  overridden: (GateFindingView & { reason: string })[];
  warnings: GateFindingView[];
}

export const CHECK_NAME: Record<string, string> = {
  'core/placeholders': 'Placeholder in the cut',
  'core/missing-media': 'Missing recording or sound',
  'core/flash-plan': 'Flashing (planned)',
  'core/flash-risk': 'Flashing (measured)',
  'core/true-peak': 'True peak',
  'core/clipping': 'Clipping',
  'core/output-format': 'Size, rate or length',
  'core/loudness': 'Loudness',
  'core/black-frames': 'Black picture',
  'core/flash-frames': 'Stray flash frame',
  'core/safe-area': 'Text outside the safe area',
  'core/av-sync': 'Sound and picture sync',
  'core/jump-cut': 'Jump cut',
  'core/read-time': 'Text on screen too briefly',
  'core/pacing': 'Pacing',
  'core/screen-direction': 'Screen direction',
  'core/off-beat': 'Cut off the beat',
  'core/contrast': 'Brand colour contrast',
};

export const checkName = (id: string) => CHECK_NAME[id] ?? id.replace(/^core\//, '');

/** Checks that can only be overridden once per check id (the override covers every finding of it). */
export const overridableChecks = (g: GateGroups): string[] => [
  ...new Set([...g.needsOverride, ...g.overridden].map((f) => f.checkId)),
];

/** One line saying what the report means for an export. */
export function verdictLine(g: GateGroups, allowed: boolean): { text: string; tone: Tone } {
  if (allowed) {
    const n = g.warnings.length;
    return {
      text: n
        ? `May be exported. ${n} warning${n === 1 ? '' : 's'} to look at.`
        : 'May be exported. Nothing to report.',
      tone: g.overridden.length || n ? 'warn' : 'ok',
    };
  }
  const parts = [
    g.blocking.length
      ? `${g.blocking.length} always block${g.blocking.length === 1 ? 's' : ''}`
      : '',
    g.needsOverride.length
      ? `${g.needsOverride.length} need${g.needsOverride.length === 1 ? 's' : ''} an override with a reason`
      : '',
  ].filter(Boolean);
  return { text: `Blocked: ${parts.join(', ')}.`, tone: 'bad' };
}

export interface Progress {
  phase: string;
  fraction: number;
  message?: string | undefined;
}

const PHASE_LABEL: Record<string, string> = {
  graphics: 'Drawing cards and captions',
  segments: 'Rendering the picture',
  audio: 'Mixing the sound',
  mux: 'Putting it together',
  checking: 'Checking the file',
  done: 'Done',
};

export const progressLabel = (p: Progress) =>
  `${p.message ?? PHASE_LABEL[p.phase] ?? p.phase} ${Math.round(p.fraction * 100)}%`;
