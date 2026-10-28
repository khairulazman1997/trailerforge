import { cropSize, placeCrop, type CropRect } from '@trailerforge/cut';
import {
  FLICKS_PER_SECOND,
  type AspectRatio,
  type Rate,
  type ShotSlot,
  type SlotOverride,
  type Take,
} from '@trailerforge/schema';

/** What the user sees for one shot of one version, from the engine's report. */
export type Fate = 'kept' | 'shortened' | 'lengthened' | 'dropped';
export type Tone = 'ok' | 'warn' | 'info' | 'muted';

export const FATE_LABEL: Record<Fate, string> = {
  kept: 'Kept',
  shortened: 'Shortened',
  lengthened: 'Lengthened',
  dropped: 'Dropped',
};

export const fateTone = (fate: Fate): Tone =>
  fate === 'dropped' ? 'warn' : fate === 'kept' ? 'ok' : 'info';

/** Your choice for a shot in a version: automatic, kept through cutdowns, or dropped. */
export type Choice = 'auto' | 'keep' | 'drop';

export const choiceOf = (o: SlotOverride | undefined): Choice =>
  o?.excluded === true ? 'drop' : o?.excluded === false ? 'keep' : 'auto';

export const CHOICE_LABEL: Record<Choice, string> = {
  auto: 'Automatic',
  keep: 'Always keep',
  drop: 'Drop',
};

export const seconds = (flicks: number): string =>
  `${Math.round((flicks / FLICKS_PER_SECOND) * 10) / 10} s`;

export const aspectLabel = (a: AspectRatio): string =>
  typeof a === 'string' ? a : `${a.w}:${a.h}`;

export function formatLine(f: {
  aspect: AspectRatio;
  resolution: { width: number; height: number };
  frameRate: Rate;
}): string {
  const fps = Math.round((f.frameRate.num / f.frameRate.den) * 100) / 100;
  return `${aspectLabel(f.aspect)}, ${f.resolution.width}×${f.resolution.height}, ${fps} fps`;
}

/** Quick lengths offered when adding a version. */
export const LENGTH_CHIPS = [60, 30, 15] as const;

/** A length typed in seconds: a positive number, "" for the master's length, else null (invalid). */
export function parseLength(text: string): number | '' | null {
  const t = text.trim();
  if (t === '') return '';
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n <= 600 ? Math.round(n * 10) / 10 : null;
}

/** Takes of a shot that can be picked for a version. */
export const pickableTakes = (shot: ShotSlot): Take[] => shot.takes.filter((t) => !t.rejected);

/** A click or key on a frame as a focus point: 0..1 of its width and height, two decimals. */
export function focusFromPoint(
  x: number,
  y: number,
  box: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  const clamp = (v: number) => Math.min(1, Math.max(0, Math.round(v * 100) / 100));
  return { x: clamp((x - box.left) / box.width), y: clamp((y - box.top) / box.height) };
}

/** The part of the master frame a version shows, around a focus point (0..1 of the frame). */
export function cropAround(
  source: { width: number; height: number },
  target: { width: number; height: number },
  focus: { x: number; y: number },
): CropRect {
  return placeCrop(focus, cropSize(source, target));
}

/** Percent strings for the crop outline, so the overlay needs no pixel maths. */
export function cropStyle(r: CropRect) {
  const pct = (v: number) => `${Math.round(v * 10000) / 100}%`;
  return { left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) };
}
