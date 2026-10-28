/**
 * Photosensitivity guard. WCAG 2.3.1 (and the Harding test used for broadcast) allows at most
 * three general flashes in any one-second period. Effects report when they flash; this checks a
 * whole cut and says where it goes over.
 */

export const MAX_FLASHES_PER_SECOND = 3;

export interface FlashEvent {
  /** Seconds on the cut. */
  at: number;
  /** What flashed, for the message. */
  source: string;
}

export interface FlashViolation {
  /** First and last flash of the stretch that goes over, seconds. */
  from: number;
  to: number;
  /** Most flashes in any one second of it. */
  count: number;
  sources: string[];
}

/** Windows of one second holding more than the safe number of flashes (merged, earliest first). */
export function flashViolations(
  events: readonly FlashEvent[],
  maxPerSecond = MAX_FLASHES_PER_SECOND,
): FlashViolation[] {
  const sorted = [...events].sort((a, b) => a.at - b.at || (a.source < b.source ? -1 : 1));
  const out: FlashViolation[] = [];
  let j = 0;
  for (let i = 0; i < sorted.length; i++) {
    while (sorted[i]!.at - sorted[j]!.at >= 1) j++;
    const count = i - j + 1;
    if (count > maxPerSecond) {
      const from = sorted[j]!.at;
      const to = sorted[i]!.at;
      const sources = [...new Set(sorted.slice(j, i + 1).map((e) => e.source))];
      const last = out.at(-1);
      // Windows that share a flash belong to one risky stretch.
      if (last && from <= last.to) {
        last.to = to;
        last.count = Math.max(last.count, count);
        last.sources = [...new Set([...last.sources, ...sources])];
      } else out.push({ from, to, count, sources });
    }
  }
  return out;
}

export class FlashRiskError extends Error {
  constructor(readonly violations: FlashViolation[]) {
    super(
      violations
        .map(
          (v) =>
            `${v.count} flashes within one second from ${Math.round(v.from * 100) / 100} s (${v.sources.join(', ')}); at most ${MAX_FLASHES_PER_SECOND} are safe for viewers with photosensitive epilepsy`,
        )
        .join('; '),
    );
    this.name = 'FlashRiskError';
  }
}

/** Throws when the cut flashes more than three times in any second. */
export function assertFlashSafe(events: readonly FlashEvent[]): void {
  const v = flashViolations(events);
  if (v.length) throw new FlashRiskError(v);
}
