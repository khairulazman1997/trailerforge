import type { Storyboard, Timeline, TimelineItem } from '@trailerforge/schema';

/**
 * Cards and captions on a cut take their look from the storyboard as it is now: a card's
 * template, params and text, a caption's text and overlay style. The rough cut copies them when
 * it is built, so without this an edit in the Graphics tab would only show after a rebuild.
 * Timing stays as cut. Items whose slot or overlay is gone are left as they are.
 */
export function refreshGraphics(
  timeline: Timeline,
  storyboard: Pick<Storyboard, 'sections'> | null | undefined,
): Timeline {
  if (!storyboard) return timeline;
  const slots = new Map(storyboard.sections.flatMap((s) => s.slots).map((s) => [s.id, s]));
  let changed = false;
  const tracks = timeline.tracks.map((track) => {
    let trackChanged = false;
    const items = track.items.map((item): TimelineItem => {
      const next = refreshed(item, slots);
      if (next !== item) trackChanged = true;
      return next;
    });
    if (!trackChanged) return track;
    changed = true;
    return { ...track, items } as typeof track;
  });
  return changed ? { ...timeline, tracks } : timeline;
}

type SlotOf = Storyboard['sections'][number]['slots'][number];

function refreshed(item: TimelineItem, slots: Map<string, SlotOf>): TimelineItem {
  if (!item.slotId) return item;
  const slot = slots.get(item.slotId);
  if (!slot) return item;
  if (item.kind === 'graphic' && slot.kind === 'card') {
    const params = { ...slot.params, text: slot.text };
    const label = slot.title || slot.cardKind;
    if (
      item.templateId === slot.templateId &&
      item.label === label &&
      JSON.stringify(item.params) === JSON.stringify(params)
    )
      return item;
    return { ...item, templateId: slot.templateId, params, label };
  }
  if (item.kind === 'caption' && slot.kind === 'shot') {
    const overlay = slot.overlays.find((o) => `cap_${o.id}`.slice(0, 64) === item.id);
    const text = overlay?.text?.trim();
    if (!overlay || !text) return item;
    const label = text.slice(0, 60);
    if (item.text === text && item.styleId === overlay.templateId && item.label === label)
      return item;
    return { ...item, text, label, styleId: overlay.templateId };
  }
  return item;
}
