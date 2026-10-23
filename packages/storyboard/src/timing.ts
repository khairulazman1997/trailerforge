import type { Storyboard } from '@trailerforge/schema';

export interface StoryboardTiming {
  target: number;
  actual: number;
  /** actual - target, rounded to 0.1 s; positive means the storyboard runs long. */
  delta: number;
  /** Ideal time per section, in order. */
  sections: { id: string; seconds: number }[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Edits never change the target length behind the user's back; this is what a UI shows
 * ("63 s of 60 s") so the user decides whether to trim or move the target.
 */
export function storyboardTiming(sb: Pick<Storyboard, 'meta' | 'sections'>): StoryboardTiming {
  const sections = sb.sections.map((s) => ({
    id: s.id,
    seconds: round1(s.slots.reduce((a, x) => a + x.duration.ideal, 0)),
  }));
  const actual = round1(sections.reduce((a, s) => a + s.seconds, 0));
  return {
    target: sb.meta.targetDuration,
    actual,
    delta: round1(actual - sb.meta.targetDuration),
    sections,
  };
}
