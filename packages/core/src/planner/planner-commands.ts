import {
  CalendarSlot,
  Campaign,
  HexColor,
  Id,
  IsoDate,
  PluginRef,
  type PlannerFile,
} from '@trailerforge/schema';
import type { Draft } from 'immer';
import { z } from 'zod';
import { CommandError } from '../commands.js';

/** What a planner command may read besides its payload: the clock and new ids. */
export interface PlannerCommandContext {
  now: string;
  newId: (prefix: 'cmp' | 'cal') => string;
}

/** Like project commands, but over the app-level planner file. */
export interface PlannerCommandDef<P> {
  type: string;
  payload: z.ZodType<P>;
  label: (payload: P) => string;
  apply: (draft: Draft<PlannerFile>, payload: P, ctx: PlannerCommandContext) => void;
  merge?: { key: (payload: P) => string; windowMs: number };
}

const define = <P>(def: PlannerCommandDef<P>): PlannerCommandDef<P> => def;

const Title = z.string().trim().min(1).max(120);
const Notes = z.string().max(4000);

function campaignOf(d: Draft<PlannerFile>, id: string, type: string) {
  const c = d.campaigns.find((x) => x.id === id);
  if (!c) throw new CommandError(type, `no campaign "${id}"`);
  return c;
}

function slotOf(d: Draft<PlannerFile>, id: string, type: string) {
  const s = d.slots.find((x) => x.id === id);
  if (!s) throw new CommandError(type, `no calendar slot "${id}"`);
  return s;
}

function checkCampaign(d: Draft<PlannerFile>, id: string | null | undefined, type: string) {
  if (id) campaignOf(d, id, type);
}

/** Set or clear (`null`) optional fields. */
function patch(target: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [k, v] of Object.entries(fields)) {
    if (v === null) delete target[k];
    else if (v !== undefined) target[k] = v;
  }
}

export const addCampaign = define({
  type: 'planner/campaign.add',
  payload: z.strictObject({
    id: Id.optional(),
    name: Title,
    color: HexColor.optional(),
    startDate: IsoDate.optional(),
    endDate: IsoDate.optional(),
    notes: Notes.optional(),
  }),
  label: ({ name }) => `Add campaign "${name}"`,
  apply: (d, p, ctx) => {
    const type = 'planner/campaign.add';
    const id = p.id ?? ctx.newId('cmp');
    if (d.campaigns.some((c) => c.id === id))
      throw new CommandError(type, `campaign "${id}" exists`);
    d.campaigns.push(Campaign.parse({ ...p, id, createdAt: ctx.now }));
  },
});

export const setCampaign = define({
  type: 'planner/campaign.set',
  payload: z.strictObject({
    campaignId: Id,
    name: Title.optional(),
    color: HexColor.nullable().optional(),
    startDate: IsoDate.nullable().optional(),
    endDate: IsoDate.nullable().optional(),
    notes: Notes.optional(),
  }),
  label: () => 'Change campaign',
  apply: (d, { campaignId, ...fields }) => {
    const c = campaignOf(d, campaignId, 'planner/campaign.set');
    patch(c as Record<string, unknown>, fields);
    const checked = Campaign.safeParse(JSON.parse(JSON.stringify(c)));
    if (!checked.success)
      throw new CommandError('planner/campaign.set', checked.error.issues[0]!.message);
  },
  merge: { key: ({ campaignId }) => campaignId, windowMs: 1500 },
});

/** Remove a campaign; its slots stay on the calendar without one, or go with it. */
export const removeCampaign = define({
  type: 'planner/campaign.remove',
  payload: z.strictObject({ campaignId: Id, slots: z.enum(['keep', 'remove']).default('keep') }),
  label: () => 'Remove campaign',
  apply: (d, { campaignId, slots }) => {
    campaignOf(d, campaignId, 'planner/campaign.remove');
    d.campaigns = d.campaigns.filter((c) => c.id !== campaignId);
    if (slots === 'remove') d.slots = d.slots.filter((s) => s.campaignId !== campaignId);
    else for (const s of d.slots) if (s.campaignId === campaignId) s.campaignId = null;
  },
});

export const addSlot = define({
  type: 'planner/slot.add',
  payload: z.strictObject({
    id: Id.optional(),
    date: IsoDate,
    title: Title,
    campaignId: Id.nullable().optional(),
    platformTargets: z.array(PluginRef).max(12).optional(),
    videoTypeId: PluginRef.optional(),
    notes: Notes.optional(),
  }),
  label: ({ title }) => `Plan "${title}"`,
  apply: (d, p, ctx) => {
    const type = 'planner/slot.add';
    checkCampaign(d, p.campaignId, type);
    const id = p.id ?? ctx.newId('cal');
    if (d.slots.some((s) => s.id === id)) throw new CommandError(type, `slot "${id}" exists`);
    d.slots.push(CalendarSlot.parse({ ...p, id, createdAt: ctx.now }));
  },
});

export const setSlot = define({
  type: 'planner/slot.set',
  payload: z.strictObject({
    slotId: Id,
    title: Title.optional(),
    campaignId: Id.nullable().optional(),
    platformTargets: z.array(PluginRef).max(12).optional(),
    videoTypeId: PluginRef.nullable().optional(),
    notes: Notes.optional(),
  }),
  label: () => 'Change planned video',
  apply: (d, { slotId, campaignId, ...fields }) => {
    const type = 'planner/slot.set';
    const s = slotOf(d, slotId, type);
    if (campaignId !== undefined) {
      checkCampaign(d, campaignId, type);
      s.campaignId = campaignId;
    }
    patch(s as Record<string, unknown>, fields);
  },
  merge: { key: ({ slotId }) => slotId, windowMs: 1500 },
});

export const moveSlot = define({
  type: 'planner/slot.move',
  payload: z.strictObject({ slotId: Id, date: IsoDate }),
  label: ({ date }) => `Move to ${date}`,
  apply: (d, { slotId, date }) => {
    slotOf(d, slotId, 'planner/slot.move').date = date;
  },
  merge: { key: ({ slotId }) => slotId, windowMs: 1000 },
});

export const removeSlot = define({
  type: 'planner/slot.remove',
  payload: z.strictObject({ slotId: Id }),
  label: () => 'Remove planned video',
  apply: (d, { slotId }) => {
    slotOf(d, slotId, 'planner/slot.remove');
    d.slots = d.slots.filter((s) => s.id !== slotId);
  },
});

/** Link a slot to an existing project (a project sits on at most one slot). */
export const linkSlot = define({
  type: 'planner/slot.link',
  payload: z.strictObject({ slotId: Id, projectId: Id }),
  label: () => 'Link project',
  apply: (d, { slotId, projectId }) => {
    const type = 'planner/slot.link';
    const s = slotOf(d, slotId, type);
    const other = d.slots.find((x) => x.projectId === projectId && x.id !== slotId);
    if (other) throw new CommandError(type, `the project is already on "${other.title}"`);
    s.projectId = projectId;
  },
});

export const unlinkSlot = define({
  type: 'planner/slot.unlink',
  payload: z.strictObject({ slotId: Id }),
  label: () => 'Unlink project',
  apply: (d, { slotId }) => {
    slotOf(d, slotId, 'planner/slot.unlink').projectId = null;
  },
});

export const plannerCommands = [
  addCampaign,
  setCampaign,
  removeCampaign,
  addSlot,
  setSlot,
  moveSlot,
  removeSlot,
  linkSlot,
  unlinkSlot,
] as unknown as readonly PlannerCommandDef<unknown>[];
