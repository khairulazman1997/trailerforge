import type { RecordingMatch } from '@trailerforge/pack-game-trailer/browser';

/** One path per line (or separated by `;`), quotes and blanks removed: what people paste. */
export function parsePaths(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n;]+/)
        .map((p) => p.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean),
    ),
  ];
}

const CONFIDENCE: Record<RecordingMatch['confidence'], string> = {
  certain: 'Certain: the file name has the shot code',
  high: 'Confident',
  medium: 'Maybe',
  low: 'Unsure',
};
export const confidenceLabel = (c: RecordingMatch['confidence']) => CONFIDENCE[c];

/** Short chip text. */
export const confidenceChip = (c: RecordingMatch['confidence']) =>
  c === 'certain' ? 'Shot code' : c === 'high' ? 'Confident' : c === 'medium' ? 'Maybe' : 'Unsure';

/** How many suggestions "attach all confident" would attach (codes and high confidence). */
export const confidentCount = (matches: readonly RecordingMatch[]) =>
  matches.filter(
    (m) =>
      m.kind !== 'ambiguous-code' &&
      m.candidates.length > 0 &&
      (m.confidence === 'certain' || m.confidence === 'high'),
  ).length;

export const lengthText = (sec: number | null) =>
  sec === null
    ? 'length unknown'
    : sec < 90
      ? `${Math.round(sec * 10) / 10} s`
      : `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`;

/** A file name shown without its folder, whichever slash it uses. */
export const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Download size for people: whole megabytes, or one decimal under 10. */
export const megabytes = (bytes: number) => {
  const mb = bytes / 1_000_000;
  return mb < 10 ? `${Math.round(mb * 10) / 10} MB` : `${Math.round(mb)} MB`;
};
