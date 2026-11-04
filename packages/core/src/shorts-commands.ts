import type { Draft } from 'immer';
import {
  Concept,
  ExportSettings,
  Flicks,
  Id,
  IsoDateTime,
  PluginRef,
  ProjectAssetRef,
  ShortId,
  Storyboard,
  Take,
  TakeInput,
  TakeOrigin,
  type TakeMatch,
  collectIds,
  mintId,
  shortTimelineId,
  type AssetRole,
  type Project,
  type Short,
  type ShotSlot,
  type VoLine,
} from '@trailerforge/schema';
import { z } from 'zod';
import { CommandError, defineCommand, type CommandDef } from './commands.js';

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
    findShort(d, shortId, 'core/shorts.remove');
    d.shorts = d.shorts.filter((s) => s.id !== shortId);
    d.timelines = d.timelines.filter((t) => t.id !== shortTimelineId(shortId));
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
] as unknown as readonly CommandDef<unknown>[];
