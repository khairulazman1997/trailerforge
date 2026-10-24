import {
  secondsToFlicks,
  snapToFrame,
  Timeline,
  type CaptionItem,
  type Storyboard,
} from '@trailerforge/schema';

export const CAPTION_TRACK_ID = 'trk_captions';

/**
 * On-screen text from the storyboard (each shot's overlays with text) placed over that shot on
 * the cut: from the shot's start plus the overlay's offset, for its duration or to the end of
 * the shot. Run after building or merging, so captions follow their shot wherever it ends up,
 * including after hand edits. The caption track is rebuilt each time, unless the user locked it.
 */
export function placeCaptions(
  timeline: Timeline,
  storyboard: Pick<Storyboard, 'sections'>,
  /** Records why a caption is there; returns its decision id. Without it, ids carry over. */
  decide?: (item: CaptionItem) => string,
): { timeline: Timeline; warnings: string[] } {
  const existing = timeline.tracks.find((t) => t.id === CAPTION_TRACK_ID);
  if (existing?.locked) return { timeline, warnings: [] };
  const warnings: string[] = [];
  const snap = (f: number) => snapToFrame(f, timeline.frameRate);

  // Where each shot sits in the picture (video and cards), possibly split across items.
  const spans = new Map<string, { start: number; end: number }>();
  for (const t of timeline.tracks) {
    if (t.kind !== 'video' && t.kind !== 'graphics') continue;
    for (const i of t.items) {
      if (!i.slotId) continue;
      const s = spans.get(i.slotId);
      spans.set(i.slotId, {
        start: Math.min(s?.start ?? i.start, i.start),
        end: Math.max(s?.end ?? 0, i.start + i.duration),
      });
    }
  }

  const items: CaptionItem[] = [];
  for (const slot of storyboard.sections.flatMap((s) => s.slots)) {
    if (slot.kind !== 'shot') continue;
    const span = spans.get(slot.id);
    for (const o of slot.overlays) {
      const text = o.text?.trim();
      if (!text) continue;
      const name = slot.title || slot.id;
      if (!span) {
        warnings.push(`the caption "${text}" was left out: "${name}" is not in the cut`);
        continue;
      }
      const start = snap(span.start + secondsToFlicks(o.offset));
      const wanted = o.duration ? start + secondsToFlicks(o.duration) : span.end;
      const end = Math.min(snap(wanted), span.end);
      if (end <= start) {
        warnings.push(`the caption "${text}" starts after "${name}" ends, so it was left out`);
        continue;
      }
      const id = `cap_${o.id}`.slice(0, 64);
      const before = existing?.items.find((i) => i.id === id)?.decisionId;
      items.push({
        id,
        kind: 'caption',
        start,
        duration: end - start,
        slotId: slot.id,
        label: text.slice(0, 60),
        text,
        // The overlay's template (a lower third, a callout) styles it once graphics render.
        styleId: o.templateId,
        ...(before ? { decisionId: before } : {}),
        extensions: {},
      });
    }
  }

  // One caption at a time: a caption that would overlap the next one ends where it begins.
  items.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  const placed: CaptionItem[] = [];
  for (const c of items) {
    const prev = placed.at(-1);
    if (prev && prev.start + prev.duration > c.start) {
      if (c.start <= prev.start) {
        warnings.push(`the caption "${c.text}" overlaps "${prev.text}" and was left out`);
        continue;
      }
      prev.duration = c.start - prev.start;
      warnings.push(`the caption "${prev.text}" was shortened so "${c.text}" can show`);
    }
    placed.push(c);
  }
  if (decide) for (const c of placed) c.decisionId = decide(c);

  const others = timeline.tracks.filter((t) => t.id !== CAPTION_TRACK_ID);
  const tracks = placed.length
    ? [
        ...others,
        {
          id: CAPTION_TRACK_ID,
          kind: 'caption' as const,
          name: 'Captions',
          muted: existing?.muted ?? false,
          locked: false,
          items: placed,
          transitions: [],
        },
      ]
    : others;
  return { timeline: Timeline.parse({ ...timeline, tracks }), warnings };
}
