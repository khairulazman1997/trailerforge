/**
 * Pure helpers for the Planner page: calendar dates as `YYYY-MM-DD` text (no time zones, no
 * `Date` arithmetic on local time), the month grid, and what a planned video shows.
 */

const DAY_MS = 86_400_000;

export interface Ymd {
  y: number;
  m: number;
  d: number;
}

export const isIsoDate = (text: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const { y, m: mo, d } = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
};

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export const toIso = ({ y, m, d }: Ymd) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

export function parseIso(iso: string): Ymd {
  const [y, m, d] = iso.split('-').map(Number);
  return { y: y!, m: m!, d: d! };
}

const utc = (iso: string) => {
  const { y, m, d } = parseIso(iso);
  return Date.UTC(y, m - 1, d);
};

function fromUtc(ms: number): string {
  const t = new Date(ms);
  return toIso({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
}

export const addDays = (iso: string, days: number): string => fromUtc(utc(iso) + days * DAY_MS);

/** Today's date on this computer's calendar. */
export const todayIso = (now: Date = new Date()): string =>
  toIso({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });

/** `YYYY-MM` of a date. */
export const monthOf = (iso: string): string => iso.slice(0, 7);

export function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const index = y! * 12 + (m! - 1) + delta;
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export const monthLabel = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m! - 1]} ${y}`;
};

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Full weekday and date, for labels read aloud ("Tuesday 1 December 2026"). */
export function longDate(iso: string): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const { y, m, d } = parseIso(iso);
  return `${days[new Date(utc(iso)).getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
}

export interface Cell {
  date: string;
  inMonth: boolean;
}

/** The weeks (Monday first) that cover a month, each with seven days. */
export function monthGrid(ym: string): Cell[][] {
  const first = `${ym}-01`;
  const lead = (new Date(utc(first)).getUTCDay() + 6) % 7; // Monday = 0
  const start = addDays(first, -lead);
  const weeks: Cell[][] = [];
  for (let w = 0; w < 6; w++) {
    const week = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(start, w * 7 + i);
      return { date, inMonth: monthOf(date) === ym };
    });
    if (w >= 4 && !week.some((c) => c.inMonth)) break;
    weeks.push(week);
  }
  return weeks;
}

/** Days a key press moves a planned video: arrows by day and week, null for any other key. */
export function moveKeyDelta(key: string): number | null {
  switch (key) {
    case 'ArrowLeft':
      return -1;
    case 'ArrowRight':
      return 1;
    case 'ArrowUp':
      return -7;
    case 'ArrowDown':
      return 7;
    default:
      return null;
  }
}

export interface SlotLike {
  id: string;
  date: string;
  title: string;
  campaignId: string | null;
  platformTargets: readonly string[];
  project: {
    scheduledDate: string | null;
    status: string | null;
    state: string;
    suggestion: { status: string; reason: string } | null;
  } | null;
}

/**
 * The date a planned video shows on. Once a project is made from it the project's own date
 * counts, so a date changed in the project (or by Claude) moves it on the calendar.
 */
export const effectiveDate = (slot: Pick<SlotLike, 'date' | 'project'>): string =>
  slot.project?.scheduledDate ?? slot.date;

export type CampaignFilter = 'all' | 'none' | (string & {});

export function filterSlots<T extends Pick<SlotLike, 'campaignId'>>(
  slots: readonly T[],
  filter: CampaignFilter,
): T[] {
  if (filter === 'all') return [...slots];
  if (filter === 'none') return slots.filter((s) => s.campaignId === null);
  return slots.filter((s) => s.campaignId === filter);
}

/** Planned videos by the date they show on, each day in title order. */
export function groupByDate<T extends SlotLike>(slots: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const s of [...slots].sort((a, b) => a.title.localeCompare(b.title))) {
    const date = effectiveDate(s);
    out.set(date, [...(out.get(date) ?? []), s]);
  }
  return out;
}

export const STATUS_LABEL: Record<string, string> = {
  idea: 'Idea',
  scripted: 'Scripted',
  capturing: 'Capturing',
  editing: 'Editing',
  'in-review': 'In review',
  scheduled: 'Scheduled',
  published: 'Published',
};

export const statusLabel = (status: string): string => STATUS_LABEL[status] ?? status;

export interface StatusChip {
  label: string;
  tone: 'plain' | 'ok' | 'warn';
  /** What the project's state points to, when it is further along than the status. */
  suggestion: { status: string; label: string; reason: string } | null;
}

/** The chip next to a planned video: its project's status, or why there is none. */
export function statusChip(slot: Pick<SlotLike, 'project'>): StatusChip {
  const p = slot.project;
  if (!p) return { label: 'No project yet', tone: 'plain', suggestion: null };
  if (p.state !== 'ok' && p.status === null)
    return {
      label: p.state === 'unknown' ? 'Project not found' : `Folder ${p.state}`,
      tone: 'warn',
      suggestion: null,
    };
  return {
    label: p.status ? statusLabel(p.status) : 'Unknown',
    tone: p.status === 'published' || p.status === 'scheduled' ? 'ok' : 'plain',
    suggestion: p.suggestion
      ? {
          status: p.suggestion.status,
          label: statusLabel(p.suggestion.status),
          reason: p.suggestion.reason,
        }
      : null,
  };
}

const SWATCHES = ['#3a7bd5', '#c2410c', '#15803d', '#a21caf', '#b45309', '#0e7490'];

/** A campaign's colour: its own, or a steady one from its position in the list. */
export const campaignColor = (campaign: { color?: string | undefined }, index: number): string =>
  campaign.color ?? SWATCHES[index % SWATCHES.length]!;

/** The platform ids in a slot, as readable names (unknown ids shown as given). */
export function platformNames(
  ids: readonly string[],
  platforms: readonly { id: string; name: string }[],
): string {
  return ids.map((id) => platforms.find((p) => p.id === id)?.name ?? id).join(', ');
}
