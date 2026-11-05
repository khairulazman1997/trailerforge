import { z } from 'zod';
import { HexColor } from './brand.js';
import { Extensions, Id, IsoDate, IsoDateTime, PluginRef } from './common.js';

/**
 * The Content Calendar Planner's app-level data (`<home>/planner/planner.json`): campaigns and the
 * calendar slots of planned videos. A slot linked to a project shows that project's own
 * campaign, date, platforms and status, which stay in its `project.json`; the slot's copies are
 * what it was planned with.
 */

export const PLANNER_SCHEMA_VERSION = 1;

const Notes = z.string().max(4000).default('');

export const Campaign = z
  .strictObject({
    id: Id,
    name: z.string().trim().min(1).max(120),
    color: HexColor.optional(),
    startDate: IsoDate.optional(),
    endDate: IsoDate.optional(),
    notes: Notes,
    createdAt: IsoDateTime,
    extensions: Extensions.default({}),
  })
  .refine((c) => !c.startDate || !c.endDate || c.endDate >= c.startDate, {
    message: 'a campaign cannot end before it starts',
    path: ['endDate'],
  });
export type Campaign = z.infer<typeof Campaign>;

export const CalendarSlot = z.strictObject({
  id: Id,
  date: IsoDate,
  campaignId: Id.nullable().default(null),
  title: z.string().trim().min(1).max(120),
  platformTargets: z.array(PluginRef).max(12).default([]),
  videoTypeId: PluginRef.optional(),
  notes: Notes,
  /** Set once a project is made from (or linked to) this slot. */
  projectId: Id.nullable().default(null),
  createdAt: IsoDateTime,
  extensions: Extensions.default({}),
});
export type CalendarSlot = z.infer<typeof CalendarSlot>;

export const PlannerFile = z
  .strictObject({
    schemaVersion: z.literal(PLANNER_SCHEMA_VERSION),
    campaigns: z.array(Campaign).default([]),
    slots: z.array(CalendarSlot).default([]),
  })
  .superRefine((file, ctx) => {
    const campaigns = new Set<string>();
    file.campaigns.forEach((c, i) => {
      if (campaigns.has(c.id))
        ctx.addIssue({
          code: 'custom',
          path: ['campaigns', i, 'id'],
          message: `duplicate campaign id "${c.id}"`,
        });
      campaigns.add(c.id);
    });
    const slots = new Set<string>();
    const linked = new Map<string, string>();
    file.slots.forEach((s, i) => {
      if (slots.has(s.id))
        ctx.addIssue({
          code: 'custom',
          path: ['slots', i, 'id'],
          message: `duplicate slot id "${s.id}"`,
        });
      slots.add(s.id);
      if (s.campaignId !== null && !campaigns.has(s.campaignId))
        ctx.addIssue({
          code: 'custom',
          path: ['slots', i, 'campaignId'],
          message: `no campaign "${s.campaignId}"`,
        });
      if (s.projectId !== null) {
        const other = linked.get(s.projectId);
        if (other)
          ctx.addIssue({
            code: 'custom',
            path: ['slots', i, 'projectId'],
            message: `project "${s.projectId}" is already linked to slot "${other}"`,
          });
        linked.set(s.projectId, s.id);
      }
    });
  });
export type PlannerFile = z.infer<typeof PlannerFile>;

export const PROJECT_REGISTRY_SCHEMA_VERSION = 1;

/** A project the app knows about. Whether its folder still exists is checked at runtime. */
export const RegisteredProject = z.strictObject({
  id: Id,
  /** Absolute path of the project folder. */
  dir: z.string().min(1),
  name: z.string().min(1),
  registeredAt: IsoDateTime,
  lastOpenedAt: IsoDateTime,
});
export type RegisteredProject = z.infer<typeof RegisteredProject>;

/**
 * `<home>/projects.json`. Folders are unique; ids may repeat (a copied project folder keeps its
 * id), in which case lookups by id take the most recently opened.
 */
export const ProjectRegistryFile = z
  .strictObject({
    schemaVersion: z.literal(PROJECT_REGISTRY_SCHEMA_VERSION),
    projects: z.array(RegisteredProject).default([]),
  })
  .superRefine((file, ctx) => {
    const dirs = new Set<string>();
    file.projects.forEach((p, i) => {
      if (dirs.has(p.dir))
        ctx.addIssue({
          code: 'custom',
          path: ['projects', i, 'dir'],
          message: `folder registered twice: ${p.dir}`,
        });
      dirs.add(p.dir);
    });
  });
export type ProjectRegistryFile = z.infer<typeof ProjectRegistryFile>;
