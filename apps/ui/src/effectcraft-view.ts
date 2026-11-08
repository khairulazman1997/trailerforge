import type { EffectProposalView } from '@trailerforge/service/client';

/** The words for each EffectCraft state, as the Graphics tab shows them. */
export const EC_STATE_LABEL = {
  ready: 'EffectCraft is ready',
  'not-bundled': 'EffectCraft is not part of this build',
  missing: 'EffectCraft is missing',
  'wrong-version': 'EffectCraft is the wrong version',
  broken: 'EffectCraft does not start',
} as const;

/** Seconds typed by the user: "2", "2.5", "0:02.5"; null when it is not a time. */
export function parseSeconds(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  const v = Number(m[1] ?? 0) * 60 + Number(m[2]);
  return Number.isFinite(v) ? v : null;
}

/** Why the "write it" button is off, or null when the request is ready. */
export function requestProblem(o: {
  words: string;
  seconds: string;
  landAt: string;
  hasSource: boolean;
}): string | null {
  // prettier-ignore
  if (!o.words.trim() && !o.hasSource) return 'Say what the effect should look like.';
  const s = parseSeconds(o.seconds);
  if (s === null || s < 0.5 || s > 20) return 'The length must be between 0.5 and 20 seconds.';
  if (o.landAt.trim()) {
    const l = parseSeconds(o.landAt);
    if (l === null || l < 0 || l > s) return 'The hit must land inside the effect.';
  }
  return null;
}

/** Frame to show for a proposal at `fraction` (0..1) of its length. */
export function proposalFrame(
  p: Pick<EffectProposalView, 'frames' | 'still'>,
  fraction?: number,
): number {
  // prettier-ignore
  const n = Math.max(1, p.frames ?? 1);
  if (fraction === undefined) return Math.min(n - 1, Math.max(0, p.still ?? Math.floor(n / 2)));
  return Math.min(n - 1, Math.max(0, Math.round(fraction * (n - 1))));
}

/** One line per fact that goes to the AI, for the disclosure (the exact data is shown too). */
export function requestLines(wire: Record<string, unknown>): string[] {
  const lines = [`Your words: “${String(wire.words ?? '')}”`];
  lines.push(`Length ${String(wire.seconds)} s${wire.landAt !== undefined ? `, the hit at ${String(wire.landAt)} s` : ''}.`); // prettier-ignore
  const size = wire.size as { width: number; height: number } | undefined;
  if (size) lines.push(`Picture ${size.width}×${size.height} at ${String(wire.frameRate)} fps.`);
  const brand = wire.brand as { colors: Record<string, string>; fonts: string[] } | undefined;
  if (brand)
    lines.push(`Brand colours ${Object.values(brand.colors).join(', ')}${brand.fonts.length ? ` and fonts ${brand.fonts.join(', ')}` : ''}.`); // prettier-ignore
  return lines;
}
