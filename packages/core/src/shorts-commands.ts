import type { Draft } from 'immer';
import {
  Concept,
  ExportSettings,
  Flicks,
  HookKind,
  Id,
  IsoDateTime,
  MAX_HOOKS,
  PluginRef,
  ProjectAssetRef,
  CueEdit,
  ShortHook,
  ShortId,
  ShortPlatform,
  SubtitleStyle,
  Storyboard,
  Take,
  TakeInput,
  TakeOrigin,
  type TakeMatch,
  collectIds,
  mintId,
  normalizeHashtags,
  hookVersionId,
  shortTimelineId,
  type AssetRole,
  type Project,
  type Short,
  type ShotSlot,
  type VoLine,
} from '@trailerforge/schema';
import { z } from 'zod';
import { CommandError, defineCommand, type CommandDef } from './commands.js';
import { GridPatch, applyGridPatch } from './music-commands.js';
import { dropVersionReview } from './review-commands.js';

/**
 * Short-form videos (TikToks): the concept list, the shorts made from concepts, and filling a
 * short's slots and voiceover lines with files. A short's storyboard content is edited by the
 * storyboard commands; these commands own which file fills what. Filling works in locked
 * sections (a lock guards what the storyboard says, not which file fills it), as with takes.
 */

const Text = (max: number) => z.string().trim().min(1).max(max);

/** A concept as callers send it: id and time optional (minted / the clock). */
const ConceptPayload = z.strictObject({
  ...Concept.shape,
  id: Id.optional(),
  createdAt: IsoDateTime.optional(),
});
type ConceptPayload = z.infer<typeof ConceptPayload>;

function concept(p: ConceptPayload, taken: Set<string>, now: string): z.infer<typeof Concept> {
  const id = p.id ?? mintId('con', p.title, taken);
  if (p.id) {
    if (taken.has(p.id)) throw new CommandError('core/concepts.add', `id "${p.id}" is used`);
    taken.add(p.id);
  }
  return Concept.parse({ ...p, id, createdAt: p.createdAt ?? now });
}

function findShort(d: Draft<Project>, shortId: string, type: string): Draft<Short> {
  const s = d.shorts.find((x) => x.id === shortId);
  if (!s) throw new CommandError(type, `no short "${shortId}"`);
  return s;
}

export const addConcepts = defineCommand({
  type: 'core/concepts.add',
  payload: z.strictObject({ concepts: z.array(ConceptPayload).min(1).max(20) }),
  label: ({ concepts }) =>
    concepts.length === 1
      ? `Add concept "${concepts[0]!.title}"`
      : `Add ${concepts.length} concepts`,
  apply: (d, { concepts }) => {
    const taken = collectIds(d);
    const now = new Date().toISOString();
    for (const c of concepts) d.concepts.push(concept(c, taken, now));
  },
});

export const removeConcepts = defineCommand({
  type: 'core/concepts.remove',
  payload: z.strictObject({ conceptIds: z.array(Id).min(1) }),
  label: ({ conceptIds }) => (conceptIds.length === 1 ? 'Remove concept' : 'Remove concepts'),
  apply: (d, { conceptIds }) => {
    for (const id of conceptIds)
      if (!d.concepts.some((c) => c.id === id))
        throw new CommandError('core/concepts.remove', `no concept "${id}"`);
    d.concepts = d.concepts.filter((c) => !conceptIds.includes(c.id));
  },
});

/**
 * Make a short from a waiting concept (it leaves the list) or from a concept given inline (the
 * user's own). The format target defaults to the project's first 9:16 one, if any.
 */
export const addShort = defineCommand({
  type: 'core/shorts.add',
  payload: z
    .strictObject({
      id: ShortId.optional(),
      name: Text(120).optional(),
      conceptId: Id.optional(),
      concept: ConceptPayload.optional(),
      formatTargetId: Id.optional(),
      createdAt: IsoDateTime.optional(),
    })
    .refine((p) => (p.conceptId === undefined) !== (p.concept === undefined), {
      message: 'give exactly one of conceptId and concept',
    }),
  label: ({ name }) => (name ? `Make TikTok "${name}"` : 'Make TikTok from concept'),
  apply: (d, p) => {
    const type = 'core/shorts.add';
    const taken = collectIds(d);
    const now = p.createdAt ?? new Date().toISOString();
    let picked: z.infer<typeof Concept>;
    if (p.conceptId !== undefined) {
      const c = d.concepts.find((x) => x.id === p.conceptId);
      if (!c) throw new CommandError(type, `no concept "${p.conceptId}"`);
      picked = Concept.parse(JSON.parse(JSON.stringify(c)));
      d.concepts = d.concepts.filter((x) => x.id !== p.conceptId);
    } else {
      picked = concept(p.concept!, taken, now);
    }
    if (p.formatTargetId && !d.formatTargets.some((f) => f.id === p.formatTargetId))
      throw new CommandError(type, `no format target "${p.formatTargetId}"`);
    const formatTargetId = p.formatTargetId ?? d.formatTargets.find((f) => f.aspect === '9:16')?.id;
    if (p.id) {
      if (taken.has(p.id)) throw new CommandError(type, `id "${p.id}" is used`);
      if (taken.has(shortTimelineId(p.id)))
        throw new CommandError(type, `id "${shortTimelineId(p.id)}" is used`);
    }
    const id = p.id ?? mintId('short', p.name ?? picked.title, taken);
    d.shorts.push({
      id,
      name: p.name ?? picked.title,
      createdAt: now,
      concept: picked,
      ...(formatTargetId ? { formatTargetId } : {}),
      storyboard: null,
      platform: 'tiktok',
      subtitles: { enabled: false, style: 'lines', edits: [] },
      voiceClean: true,
      hooks: [],
      post: { caption: '', hashtags: [], pinnedComment: '' },
      cover: { title: '' },
      extensions: {},
    });
  },
});

/** Remove a short with its timeline. */
export const removeShort = defineCommand({
  type: 'core/shorts.remove',
  payload: z.strictObject({ shortId: Id }),
  label: () => 'Remove TikTok',
  apply: (d, { shortId }) => {
    const short = findShort(d, shortId, 'core/shorts.remove');
    d.shorts = d.shorts.filter((s) => s.id !== shortId);
    d.timelines = d.timelines.filter((t) => t.id !== shortTimelineId(shortId));
    dropVersionReview(d, shortId);
    for (const h of short.hooks) dropVersionReview(d, hookVersionId(shortId, h.id));
  },
});

export const renameShort = defineCommand({
  type: 'core/shorts.rename',
  payload: z.strictObject({ shortId: Id, name: Text(120) }),
  label: ({ name }) => `Rename TikTok to "${name}"`,
  apply: (d, { shortId, name }) => {
    findShort(d, shortId, 'core/shorts.rename').name = name;
  },
  merge: { key: ({ shortId }) => shortId, windowMs: 1000 },
});

/** Changes to a short's concept; only the fields given change (no defaults filled in). */
const ConceptPatch = z.strictObject({
  title: Concept.shape.title.optional(),
  hook: Concept.shape.hook.optional(),
  formatId: PluginRef.optional(),
  pitch: z.string().trim().max(1000).optional(),
  shotList: z.array(Text(300)).max(12).optional(),
  voiceover: z.array(Text(500)).max(20).optional(),
  targetSeconds: Concept.shape.targetSeconds.optional(),
  entityIds: z.array(Id).max(20).optional(),
});

export const setShortConcept = defineCommand({
  type: 'core/shorts.set-concept',
  payload: z.strictObject({ shortId: Id, concept: ConceptPatch }),
  label: () => 'Edit TikTok concept',
  apply: (d, { shortId, concept: patch }) => {
    const s = findShort(d, shortId, 'core/shorts.set-concept');
    for (const [k, v] of Object.entries(patch))
      if (v !== undefined) (s.concept as never)[k] = v as never;
  },
  merge: { key: ({ shortId }) => shortId, windowMs: 1500 },
});

/** Replace a short's storyboard (a template built from its concept), or clear it with null. */
export const setShortStoryboard = defineCommand({
  type: 'core/shorts.set-storyboard',
  payload: z.strictObject({ shortId: Id, storyboard: Storyboard.nullable() }),
  label: ({ storyboard }) => (storyboard ? 'Build TikTok template' : 'Clear TikTok template'),
  apply: (d, { shortId, storyboard }) => {
    const s = findShort(d, shortId, 'core/shorts.set-storyboard');
    if (storyboard && storyboard.variants.length > 0)
      throw new CommandError('core/shorts.set-storyboard', 'a short has no versions');
    s.storyboard = storyboard;
  },
});

export const setShortExport = defineCommand({
  type: 'core/shorts.set-export',
  payload: z.strictObject({ shortId: Id, export: ExportSettings.nullable() }),
  label: () => 'Set TikTok export',
  apply: (d, p) => {
    const s = findShort(d, p.shortId, 'core/shorts.set-export');
    if (p.export) s.export = p.export;
    else delete s.export;
  },
});

/** A shot slot or a voiceover line in a short's storyboard. */
const Target = z.union([z.strictObject({ slotId: Id }), z.strictObject({ voLineId: Id })]);
type Target = z.infer<typeof Target>;

type Fillable = { kind: 'slot'; at: Draft<ShotSlot> } | { kind: 'vo'; at: Draft<VoLine> };

function findTarget(s: Draft<Short>, target: Target, type: string): Fillable {
  const sb = s.storyboard;
  if (!sb) throw new CommandError(type, `TikTok "${s.id}" has no template yet`);
  if ('voLineId' in target) {
    const vo = sb.voLines.find((v) => v.id === target.voLineId);
    if (!vo) throw new CommandError(type, `no voiceover line "${target.voLineId}"`);
    return { kind: 'vo', at: vo };
  }
  for (const sec of sb.sections)
    for (const slot of sec.slots)
      if (slot.id === target.slotId) {
        if (slot.kind !== 'shot')
          throw new CommandError(type, `"${target.slotId}" is a card; it has no file to fill`);
        return { kind: 'slot', at: slot };
      }
  throw new CommandError(type, `no slot "${target.slotId}"`);
}

const ROLE_FOR: Record<TakeInput, AssetRole> = {
  gameplay: 'footage',
  video: 'footage',
  image: 'graphic',
  voiceover: 'voiceover',
};

/**
 * Fill a slot or voiceover line with a file: the file becomes a take and is chosen. A file that
 * is already a take there is chosen again (with the new in/out, if given). Picture slots take
 * what their `accepts` lists (gameplay when unset); voiceover goes to voiceover lines only.
 */
const FillPayload = z
  .strictObject({
    shortId: Id,
    target: Target,
    assetId: Id,
    input: TakeInput,
    takeId: Id.optional(),
    sourceIn: Flicks.optional(),
    sourceOut: Flicks.optional(),
    origin: TakeOrigin.optional(),
    attachedAt: IsoDateTime.optional(),
  })
  .refine(
    (p) => p.sourceIn === undefined || p.sourceOut === undefined || p.sourceIn < p.sourceOut,
    { message: 'sourceIn must be before sourceOut' },
  );
type FillPayload = z.infer<typeof FillPayload>;

function fill(d: Draft<Project>, p: FillPayload, type: string, matchedBy: TakeMatch): void {
  const t = findTarget(findShort(d, p.shortId, type), p.target, type);
  if (t.kind === 'vo' && p.input !== 'voiceover')
    throw new CommandError(type, 'a voiceover line takes a voiceover recording');
  if (t.kind === 'slot') {
    const accepts = t.at.accepts ?? ['gameplay'];
    if (p.input === 'voiceover' || !accepts.includes(p.input))
      throw new CommandError(type, `this slot takes ${accepts.join(' or ')}, not ${p.input}`);
  }
  const now = p.attachedAt ?? new Date().toISOString();
  if (!d.assets.some((a) => a.assetId === p.assetId))
    d.assets.push(ProjectAssetRef.parse({ assetId: p.assetId, role: ROLE_FOR[p.input], addedAt: now })); // prettier-ignore
  const hint = {
    ...(p.sourceIn !== undefined ? { sourceIn: p.sourceIn } : {}),
    ...(p.sourceOut !== undefined ? { sourceOut: p.sourceOut } : {}),
  };
  const takes = t.at.takes;
  const existing = takes.find((x) => x.assetId === p.assetId && !p.takeId);
  if (existing) {
    if (p.sourceIn !== undefined || p.sourceOut !== undefined) {
      delete existing.sourceIn;
      delete existing.sourceOut;
      Object.assign(existing, hint);
    }
    existing.rejected = false;
    t.at.chosenTakeId = existing.id;
  } else {
    const taken = collectIds(d);
    if (p.takeId && taken.has(p.takeId)) throw new CommandError(type, `id "${p.takeId}" is used`);
    const id = p.takeId ?? mintId('take', p.assetId.replace(/^asset_/, ''), taken);
    takes.push(
      Take.parse({
        id,
        assetId: p.assetId,
        matchedBy,
        ...hint,
        ...(p.origin ? { origin: p.origin } : {}),
        input: p.input,
        attachedAt: now,
      }),
    );
    t.at.chosenTakeId = id;
  }
  if (t.at.status === 'empty') t.at.status = 'recorded';
}

/**
 * Fill a slot or voiceover line with a file: the file becomes a take and is chosen. A file that
 * is already a take there is chosen again (with the new in/out, if given). Picture slots take
 * what their `accepts` lists (gameplay when unset); voiceover goes to voiceover lines only.
 */
export const fillShortSlot = defineCommand({
  type: 'core/shorts.fill-slot',
  payload: FillPayload,
  label: (p) => ('voLineId' in p.target ? 'Add voiceover recording' : `Add ${p.input} to slot`),
  apply: (d, p) => fill(d, p, 'core/shorts.fill-slot', 'manual'),
});

/**
 * Place voiceover lines found in recordings (one long take split into lines, or a file per
 * line), each with its in and out, as one step. Marked as suggested: the app lined them up.
 */
export const fillShortVoice = defineCommand({
  type: 'core/shorts.fill-voice',
  payload: z.strictObject({
    shortId: Id,
    lines: z
      .array(
        z
          .strictObject({ voLineId: Id, assetId: Id, sourceIn: Flicks, sourceOut: Flicks })
          .refine((l) => l.sourceIn < l.sourceOut, {
            message: 'sourceIn must be before sourceOut',
          }),
      )
      .min(1)
      .max(40),
    attachedAt: IsoDateTime.optional(),
  }),
  label: ({ lines }) =>
    lines.length === 1 ? 'Place voiceover line' : `Place ${lines.length} voiceover lines`,
  apply: (d, { shortId, lines, attachedAt }) => {
    for (const l of lines)
      fill(
        d,
        {
          shortId,
          target: { voLineId: l.voLineId },
          assetId: l.assetId,
          input: 'voiceover',
          sourceIn: l.sourceIn,
          sourceOut: l.sourceOut,
          ...(attachedAt ? { attachedAt } : {}),
        },
        'core/shorts.fill-voice',
        'suggestion',
      );
  },
});

/** Take a file (or, without `takeId`, every file) out of a slot or voiceover line. */
export const clearShortSlot = defineCommand({
  type: 'core/shorts.clear-slot',
  payload: z.strictObject({ shortId: Id, target: Target, takeId: Id.optional() }),
  label: () => 'Clear slot',
  apply: (d, p) => {
    const type = 'core/shorts.clear-slot';
    const t = findTarget(findShort(d, p.shortId, type), p.target, type);
    if (p.takeId && !t.at.takes.some((x) => x.id === p.takeId))
      throw new CommandError(type, `no take "${p.takeId}"`);
    t.at.takes = p.takeId ? t.at.takes.filter((x) => x.id !== p.takeId) : [];
    if (t.at.chosenTakeId !== undefined && !t.at.takes.some((x) => x.id === t.at.chosenTakeId))
      delete t.at.chosenTakeId;
    if (t.at.takes.length === 0 && t.at.status === 'recorded') t.at.status = 'empty';
  },
});

/** Subtitles on or off, their style, and the app the short is made for. */
export const setShortSubtitles = defineCommand({
  type: 'core/shorts.set-subtitles',
  payload: z
    .strictObject({
      shortId: Id,
      enabled: z.boolean().optional(),
      style: SubtitleStyle.optional(),
      platform: ShortPlatform.optional(),
    })
    .refine((p) => p.enabled !== undefined || p.style !== undefined || p.platform !== undefined, {
      message: 'change at least one of enabled, style and platform',
    }),
  label: (p) =>
    p.enabled === false
      ? 'Turn subtitles off'
      : p.enabled
        ? 'Turn subtitles on'
        : 'Subtitle settings',
  apply: (d, p) => {
    const s = findShort(d, p.shortId, 'core/shorts.set-subtitles');
    if (p.enabled !== undefined) s.subtitles.enabled = p.enabled;
    if (p.style !== undefined) s.subtitles.style = p.style;
    if (p.platform !== undefined) s.platform = p.platform;
  },
});

/**
 * Change one subtitle cue by hand: its text, or a nudge of its start or end. `null` clears that
 * change; a cue with no changes left is forgotten. Quick repeats merge into one undo step.
 */
export const editCue = defineCommand({
  type: 'core/shorts.edit-cue',
  payload: z.strictObject({
    shortId: Id,
    key: CueEdit.shape.key,
    words: CueEdit.shape.words,
    text: CueEdit.shape.text.unwrap().nullable().optional(),
    nudgeIn: CueEdit.shape.nudgeIn.unwrap().nullable().optional(),
    nudgeOut: CueEdit.shape.nudgeOut.unwrap().nullable().optional(),
  }),
  label: () => 'Edit subtitle',
  apply: (d, p) => {
    const s = findShort(d, p.shortId, 'core/shorts.edit-cue');
    const prior = s.subtitles.edits.find((e) => e.key === p.key);
    const next: Record<string, unknown> = { ...(prior && prior.words === p.words ? prior : {}), key: p.key, words: p.words }; // prettier-ignore
    for (const f of ['text', 'nudgeIn', 'nudgeOut'] as const) {
      if (p[f] === null) delete next[f];
      else if (p[f] !== undefined) next[f] = p[f];
    }
    s.subtitles.edits = s.subtitles.edits.filter((e) => e.key !== p.key);
    if ('text' in next || 'nudgeIn' in next || 'nudgeOut' in next)
      s.subtitles.edits.push(CueEdit.parse(next));
  },
  merge: { key: (p) => `${p.shortId}:${p.key}`, windowMs: 1500 },
});

/** Forget hand changes to some cues (by key), or to all of them. */
export const resetCues = defineCommand({
  type: 'core/shorts.reset-cues',
  payload: z.strictObject({ shortId: Id, keys: z.array(CueEdit.shape.key).optional() }),
  label: () => 'Reset subtitles',
  apply: (d, p) => {
    const s = findShort(d, p.shortId, 'core/shorts.reset-cues');
    s.subtitles.edits = p.keys ? s.subtitles.edits.filter((e) => !p.keys!.includes(e.key)) : [];
  },
});

/**
 * The music a TikTok's cut follows. With `timingOnly` the file gives the beat grid and nothing
 * else: it is never put on the timeline and never exported (a reference song, for example).
 */
export const setShortMusic = defineCommand({
  type: 'core/shorts.set-music',
  payload: z.strictObject({
    shortId: Id,
    assetId: Id.nullable(),
    timingOnly: z.boolean().optional(),
  }),
  label: ({ assetId }) => (assetId ? 'Choose the TikTok music' : 'Remove the TikTok music'),
  apply: (d, { shortId, assetId, timingOnly }) => {
    const type = 'core/shorts.set-music';
    const sb = findShort(d, shortId, type).storyboard;
    if (!sb) throw new CommandError(type, `TikTok "${shortId}" has no template yet`);
    const m = sb.music;
    if (assetId !== null && !d.assets.some((a) => a.assetId === assetId)) {
      d.assets.push(
        ProjectAssetRef.parse({ assetId, role: 'music', addedAt: new Date().toISOString() }),
      );
    }
    if (assetId !== (m.trackAssetId ?? null)) delete m.grid; // nudges belong to the old track
    if (assetId === null) delete m.trackAssetId;
    else m.trackAssetId = assetId;
    if (assetId !== null && timingOnly) m.timingOnly = true;
    else delete m.timingOnly;
  },
});

/** Beat grid settings for a TikTok: a tempo (from tapping it in) needs no music file at all. */
export const setShortGrid = defineCommand({
  type: 'core/shorts.set-grid',
  payload: z.strictObject({ shortId: Id, patch: GridPatch }),
  label: () => 'Adjust the TikTok beat grid',
  apply: (d, { shortId, patch }) => {
    const type = 'core/shorts.set-grid';
    const sb = findShort(d, shortId, type).storyboard;
    if (!sb) throw new CommandError(type, `TikTok "${shortId}" has no template yet`);
    applyGridPatch(sb.music, patch, type);
  },
  merge: { key: ({ shortId }) => `${shortId}:grid`, windowMs: 1500 },
});

/** Voice clean-up on or off for a TikTok (applied when it renders; the recordings stay as they are). */
export const setShortVoiceClean = defineCommand({
  type: 'core/shorts.set-voice-clean',
  payload: z.strictObject({ shortId: Id, enabled: z.boolean() }),
  label: ({ enabled }) => (enabled ? 'Turn voice clean-up on' : 'Turn voice clean-up off'),
  apply: (d, { shortId, enabled }) => {
    findShort(d, shortId, 'core/shorts.set-voice-clean').voiceClean = enabled;
  },
});

// ---- post text and cover --------------------------------------------------------------------

/** The caption, hashtags and pinned comment that go with the post (fields left out stay as they are). */
export const setShortPostCopy = defineCommand({
  type: 'core/shorts.set-post-copy',
  payload: z.strictObject({
    shortId: Id,
    caption: z.string().trim().max(2200).optional(),
    hashtags: z.array(z.string().max(80)).max(40).optional(),
    pinnedComment: z.string().trim().max(150).optional(),
    /** The cover's title (what the AI writes along with the post text). */
    coverTitle: z.string().trim().max(60).optional(),
  }),
  label: () => 'Edit post text',
  apply: (d, p) => {
    const s = findShort(d, p.shortId, 'core/shorts.set-post-copy');
    if (p.caption !== undefined) s.post.caption = p.caption;
    if (p.hashtags !== undefined) s.post.hashtags = normalizeHashtags(p.hashtags).slice(0, 30);
    if (p.pinnedComment !== undefined) s.post.pinnedComment = p.pinnedComment;
    if (p.coverTitle !== undefined) s.cover.title = p.coverTitle;
  },
  merge: { key: ({ shortId }) => `${shortId}:post`, windowMs: 1500 },
});

/** The cover frame (seconds into the video; `null` goes back to the poster frame) and its title. */
export const setShortCover = defineCommand({
  type: 'core/shorts.set-cover',
  payload: z
    .strictObject({
      shortId: Id,
      seconds: z.number().min(0).max(600).nullable().optional(),
      title: z.string().trim().max(60).optional(),
    })
    .refine((p) => p.seconds !== undefined || p.title !== undefined, {
      message: 'give a time or a title',
    }),
  label: () => 'Set the cover',
  apply: (d, p) => {
    const s = findShort(d, p.shortId, 'core/shorts.set-cover');
    if (p.seconds === null) delete s.cover.seconds;
    else if (p.seconds !== undefined) s.cover.seconds = p.seconds;
    if (p.title !== undefined) s.cover.title = p.title;
  },
  merge: { key: ({ shortId }) => `${shortId}:cover`, windowMs: 1500 },
});

// ---- hook versions ---------------------------------------------------------------------------

const HookText = {
  name: Text(60),
  kind: HookKind,
  caption: z.string().trim().max(120),
  why: z.string().trim().max(300),
};

/** The take must belong to a picture slot of the short's template. */
function checkHookTake(s: Draft<Short>, takeId: string, type: string) {
  const ok = (s.storyboard?.sections ?? []).some((sec) =>
    sec.slots.some((sl) => sl.kind === 'shot' && sl.takes.some((t) => t.id === takeId)),
  );
  if (!ok) throw new CommandError(type, `no take "${takeId}" in "${s.name}"`);
}

const HOOK_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Add one alternative opening (a hook version). At most three per TikTok. */
export const addShortHook = defineCommand({
  type: 'core/shorts.add-hook',
  payload: z.strictObject({
    shortId: Id,
    hook: z.strictObject({
      name: HookText.name,
      kind: HookText.kind.optional(),
      caption: HookText.caption.optional(),
      takeId: Id.optional(),
      why: HookText.why.optional(),
    }),
  }),
  label: () => 'Add hook version',
  apply: (d, { shortId, hook }) => {
    const type = 'core/shorts.add-hook';
    const s = findShort(d, shortId, type);
    if (s.hooks.length >= MAX_HOOKS)
      throw new CommandError(type, `a TikTok has at most ${MAX_HOOKS} hook versions`);
    if (hook.takeId) checkHookTake(s, hook.takeId, type);
    const id = [...HOOK_LETTERS].find((c) => !s.hooks.some((h) => h.id === c))!;
    s.hooks.push(ShortHook.parse({ ...hook, id }));
  },
});

/** Change a hook version (`null` clears the take back to the chosen one). */
export const editShortHook = defineCommand({
  type: 'core/shorts.edit-hook',
  payload: z.strictObject({
    shortId: Id,
    hookId: z.string().min(1).max(8),
    patch: z.strictObject({
      name: HookText.name.optional(),
      kind: HookText.kind.optional(),
      caption: HookText.caption.optional(),
      takeId: Id.nullable().optional(),
      why: HookText.why.optional(),
    }),
  }),
  label: () => 'Edit hook version',
  apply: (d, { shortId, hookId, patch }) => {
    const type = 'core/shorts.edit-hook';
    const s = findShort(d, shortId, type);
    const h = s.hooks.find((x) => x.id === hookId);
    if (!h) throw new CommandError(type, `no hook version "${hookId}"`);
    if (patch.takeId) checkHookTake(s, patch.takeId, type);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete (h as Record<string, unknown>)[k];
      else if (v !== undefined) (h as Record<string, unknown>)[k] = v;
    }
  },
  merge: { key: ({ shortId, hookId }) => `${shortId}:hook:${hookId}`, windowMs: 1500 },
});

export const removeShortHook = defineCommand({
  type: 'core/shorts.remove-hook',
  payload: z.strictObject({ shortId: Id, hookId: z.string().min(1).max(8) }),
  label: () => 'Remove hook version',
  apply: (d, { shortId, hookId }) => {
    const type = 'core/shorts.remove-hook';
    const s = findShort(d, shortId, type);
    if (!s.hooks.some((h) => h.id === hookId)) throw new CommandError(type, `no hook version "${hookId}"`); // prettier-ignore
    s.hooks = s.hooks.filter((h) => h.id !== hookId);
    dropVersionReview(d, hookVersionId(shortId, hookId));
  },
});

/**
 * Replace the whole list of hook versions as one undo step: what the AI proposes added to the
 * ones the user keeps. A hook with an `id` keeps it (and its review); new ones get the next free
 * letter; reviews of ones left out go.
 */
export const setShortHooks = defineCommand({
  type: 'core/shorts.set-hooks',
  payload: z.strictObject({
    shortId: Id,
    hooks: z
      .array(
        z.strictObject({
          id: z
            .string()
            .regex(/^[a-z0-9]{1,8}$/)
            .optional(),
          name: HookText.name,
          kind: HookText.kind.optional(),
          caption: HookText.caption.optional(),
          takeId: Id.optional(),
          why: HookText.why.optional(),
        }),
      )
      .max(MAX_HOOKS),
  }),
  label: () => 'Set hook versions',
  apply: (d, { shortId, hooks }) => {
    const type = 'core/shorts.set-hooks';
    const s = findShort(d, shortId, type);
    const keep = new Set(hooks.flatMap((h) => (h.id ? [h.id] : [])));
    if (keep.size !== hooks.filter((h) => h.id).length)
      throw new CommandError(type, 'two hook versions share an id');
    for (const h of hooks) {
      if (h.id && !s.hooks.some((x) => x.id === h.id)) throw new CommandError(type, `no hook version "${h.id}"`); // prettier-ignore
      if (h.takeId) checkHookTake(s, h.takeId, type);
    }
    for (const h of s.hooks)
      if (!keep.has(h.id)) dropVersionReview(d, hookVersionId(shortId, h.id));
    const used = new Set(keep);
    s.hooks = hooks.map((h) => {
      const id = h.id ?? [...HOOK_LETTERS].find((c) => !used.has(c))!;
      used.add(id);
      return ShortHook.parse({ ...h, id });
    });
  },
});

export const shortsCommands = [
  addConcepts,
  removeConcepts,
  addShort,
  removeShort,
  renameShort,
  setShortConcept,
  setShortStoryboard,
  setShortExport,
  fillShortSlot,
  fillShortVoice,
  clearShortSlot,
  setShortMusic,
  setShortGrid,
  setShortPostCopy,
  setShortCover,
  addShortHook,
  editShortHook,
  removeShortHook,
  setShortHooks,
  setShortSubtitles,
  setShortVoiceClean,
  editCue,
  resetCues,
] as unknown as readonly CommandDef<unknown>[];
