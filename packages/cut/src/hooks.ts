import type { Overlay, ShortHook, ShotSlot, Storyboard, Timeline } from '@trailerforge/schema';
import { CAPTION_TRACK_ID, placeCaptions } from './captions.js';
import type { TakeSource } from './rough-cut.js';

/**
 * Hook versions: the same TikTok with a different opening. A hook swaps the recording of the
 * opening shot and/or the text over it and nothing else: the length stays, so the voice, music,
 * subtitles and every cut after the opening stay exactly where they are (there is nothing to
 * re-snap). The derived timeline is rendered and never stored.
 */

/** The opening shot: the first shot of the section with the `hook` role, else of the first section. */
export function hookSlotOf(storyboard: Pick<Storyboard, 'sections'>): ShotSlot | undefined {
  const section =
    storyboard.sections.find((s) => s.role === 'hook') ??
    storyboard.sections.find((s) => s.slots.some((x) => x.kind === 'shot'));
  return section?.slots.find((x): x is ShotSlot => x.kind === 'shot');
}

export interface HookDerivation {
  timeline: Timeline;
  warnings: string[];
  /** The opening shot's id, or null when the storyboard has none. */
  slotId: string | null;
}

export function deriveHook(input: {
  timeline: Timeline;
  storyboard: Pick<Storyboard, 'sections'>;
  hook: Pick<ShortHook, 'id' | 'name' | 'caption' | 'takeId'>;
  /** Recording lengths, to keep a swapped take's start inside its recording. */
  sources?: ReadonlyMap<string, TakeSource>;
}): HookDerivation {
  const { storyboard, hook } = input;
  const warnings: string[] = [];
  const slot = hookSlotOf(storyboard);
  if (!slot) {
    warnings.push(`hook version "${hook.name}": the template has no opening shot, so it is the same as the original`); // prettier-ignore
    return { timeline: input.timeline, warnings, slotId: null };
  }
  let timeline = input.timeline;

  // The recording of the opening shot.
  if (hook.takeId) {
    const take = slot.takes.find((t) => t.id === hook.takeId);
    if (!take) {
      warnings.push(`hook version "${hook.name}": its take is no longer on the opening shot; the chosen take is used`); // prettier-ignore
    } else {
      timeline = {
        ...timeline,
        tracks: timeline.tracks.map((t) =>
          t.kind !== 'video'
            ? t
            : {
                ...t,
                items: t.items.map((i) => {
                  if (i.kind !== 'clip' || i.slotId !== slot.id) return i;
                  const src = input.sources?.get(take.assetId);
                  let sourceIn = take.sourceIn ?? 0;
                  if (src?.still) sourceIn = 0;
                  else if (src) {
                    const need = i.duration * i.speed;
                    if (sourceIn + need > src.duration) {
                      sourceIn = Math.max(0, src.duration - need);
                      if (src.duration < need)
                        warnings.push(`hook version "${hook.name}": its take is shorter than the opening; the last frame is held`); // prettier-ignore
                    }
                  }
                  return { ...i, assetId: take.assetId, sourceIn };
                }),
              },
        ),
      };
    }
  }

  // The text over it: the hook's caption replaces the opening shot's own, keeping its look.
  const text = hook.caption.trim();
  const base: Overlay | undefined = slot.overlays[0];
  const overlays: Overlay[] = text
    ? [
        {
          id: `hook_${hook.id}`,
          templateId: base?.templateId ?? 'core/caption',
          text,
          params: base?.params ?? {},
          offset: base?.offset ?? 0,
          ...(base?.duration !== undefined ? { duration: base.duration } : {}),
        },
      ]
    : [];
  const sections = storyboard.sections.map((sec) => ({
    ...sec,
    slots: sec.slots.map((x) => (x.id === slot.id && x.kind === 'shot' ? { ...x, overlays } : x)),
  }));
  if (timeline.tracks.find((t) => t.id === CAPTION_TRACK_ID)?.locked)
    warnings.push(`hook version "${hook.name}": the Captions track is locked, so its text was not changed`); // prettier-ignore
  else {
    const placed = placeCaptions(timeline, { sections });
    timeline = placed.timeline;
    warnings.push(...placed.warnings.map((w) => `hook version "${hook.name}": ${w}`));
  }
  return { timeline, warnings, slotId: slot.id };
}
