import { CommandError, defineCommand } from '@trailerforge/core';
import { Flicks, Id, mintId } from '@trailerforge/schema';
import { z } from 'zod';

/**
 * Custom effects the user accepted sit on their own graphics track. Tracks whose id starts with
 * `trk_user_` are not made by the rough cut, so a rebuild keeps them whole (`mergeRoughCut`).
 */
export const USER_EFFECTS_TRACK = 'trk_user_effects';

/**
 * Put an accepted custom effect on the timeline (plan M8 decision 4): one graphic item drawing the
 * stored EffectCraft project (`media/<sha256>.ecproj`, never deleted, so undo and redo work).
 * One undo step; a clash with another effect at that time is refused by the timeline's checks.
 */
export const addEffect = defineCommand({
  type: 'effectcraft/effect.add',
  payload: z.strictObject({
    timelineId: Id,
    start: Flicks,
    duration: Flicks.refine((d) => d > 0, { message: 'duration must be > 0' }),
    project: z.string().regex(/^media\/[0-9a-f]{64}\.ecproj$/, 'a stored EffectCraft project'),
    comp: z.string().min(1).max(64),
    label: z.string().trim().min(1).max(60),
    decisionId: Id.optional(),
    /** The storyboard slot whose effect brief this answers; the brief is marked accepted. */
    slotId: Id.optional(),
  }),
  label: ({ label }) => `Add the effect "${label}"`,
  apply: (d, p) => {
    const type = 'effectcraft/effect.add';
    const tl = d.timelines.find((t) => t.id === p.timelineId);
    if (!tl) throw new CommandError(type, `no timeline "${p.timelineId}"`);
    let track = tl.tracks.find((t) => t.id === USER_EFFECTS_TRACK);
    if (!track) {
      track = {
        id: USER_EFFECTS_TRACK,
        kind: 'graphics',
        name: 'Effects',
        muted: false,
        locked: false,
        items: [],
        transitions: [],
      };
      tl.tracks.push(track);
    }
    if (track.locked) throw new CommandError(type, 'the Effects track is locked');
    const taken = new Set(tl.tracks.flatMap((t) => t.items.map((i) => i.id)));
    track.items.push({
      id: mintId('it', `effect ${p.label}`, taken),
      kind: 'graphic',
      start: p.start,
      duration: p.duration,
      label: p.label,
      templateId: 'effectcraft/project',
      params: { project: p.project, comp: p.comp },
      effects: [],
      ...(p.decisionId ? { decisionId: p.decisionId } : {}),
      extensions: {
        core: { userEdited: true },
        ...(p.slotId ? { effectcraft: { slotId: p.slotId } } : {}),
      },
    });
    if (p.slotId) {
      const slot = d.storyboard?.sections.flatMap((s) => s.slots).find((x) => x.id === p.slotId);
      if (!slot) throw new CommandError(type, `no slot "${p.slotId}"`);
      const x = (slot.extensions.effectcraft ?? {}) as { brief?: Record<string, unknown> };
      if (x.brief) slot.extensions.effectcraft = { ...x, brief: { ...x.brief, accepted: true } };
    }
  },
});

export const effectcraftCommands = [addEffect];
