import { defineCommand, type CommandDef } from '@trailerforge/core';
import type { ExtractedEntity } from '@trailerforge/plugin-api';
import {
  collectIds,
  Id,
  IsoDateTime,
  KnowledgeEntityKind,
  KnowledgeSource,
  ContentHash,
  type Project,
} from '@trailerforge/schema';
import type { Draft } from 'immer';
import { z } from 'zod';
import { mergeKnowledge } from './merge.js';

/** Knowledge entity ids the storyboard's slots point at; deleting those would break the project. */
export function referencedEntityIds(project: Pick<Project, 'storyboard'>): Set<string> {
  const out = new Set<string>();
  for (const section of project.storyboard?.sections ?? [])
    for (const slot of section.slots) for (const id of slot.entityIds) out.add(id);
  return out;
}

const Extracted = z.strictObject({
  kind: KnowledgeEntityKind,
  name: z.string().min(1),
  description: z.string().optional(),
  sourcePaths: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  /** Set by extractors (for example `debug-command`); merged in, never removed by a re-scan. */
  tags: z.array(z.string()).optional(),
});

const sourceOf = (d: Draft<Project>, id: string) => {
  const s = d.sources.find((x) => x.id === id);
  if (!s) throw new Error(`no knowledge source "${id}"`);
  return s;
};

export const addSource = defineCommand({
  type: 'core/knowledge.add-source',
  payload: KnowledgeSource,
  label: (s) => `Add source ${s.path}`,
  apply: (d, s) => {
    if (d.sources.some((x) => x.id === s.id || x.path === s.path))
      throw new Error(`source "${s.path}" is already added`);
    d.sources.push(s);
  },
});

/** Removes the source; its entities the storyboard uses become the user's, the rest are deleted. */
export const removeSource = defineCommand({
  type: 'core/knowledge.remove-source',
  payload: z.strictObject({ id: Id }),
  label: () => 'Remove source',
  apply: (d, { id }) => {
    sourceOf(d, id);
    const referenced = referencedEntityIds(d as unknown as Project);
    d.knowledge = d.knowledge.flatMap((e) => {
      if (e.sourceId !== id) return [e];
      if (e.origin === 'extracted' && !referenced.has(e.id)) return [];
      const { sourceId: _gone, ...rest } = e;
      return [{ ...rest, origin: 'user' as const }];
    });
    d.sources = d.sources.filter((s) => s.id !== id);
  },
});

/** Result of scanning a source; see `mergeKnowledge` for what survives. */
export const applyScan = defineCommand({
  type: 'core/knowledge.apply-scan',
  payload: z.strictObject({
    sourceId: Id,
    scope: z.enum(['standard', 'deep']).default('standard'),
    entities: z.array(Extracted),
    digestHash: ContentHash,
    scannedAt: IsoDateTime,
  }),
  label: ({ scope }) => (scope === 'deep' ? 'Deep scan game repo' : 'Scan game repo'),
  apply: (d, p) => {
    const source = sourceOf(d, p.sourceId);
    const incoming: ExtractedEntity[] = p.entities.map((e) => ({
      kind: e.kind,
      name: e.name,
      description: e.description ?? '',
      sourcePaths: e.sourcePaths,
      confidence: e.confidence,
      ...(e.tags ? { tags: e.tags } : {}),
    }));
    const r = mergeKnowledge(d.knowledge, p.sourceId, incoming, {
      scope: p.scope,
      taken: collectIds(d),
      referenced: referencedEntityIds(d as unknown as Project),
    });
    d.knowledge = r.knowledge;
    source.lastScannedAt = p.scannedAt;
    if (p.scope === 'standard') source.digestHash = p.digestHash;
  },
});

const EntityFields = {
  kind: KnowledgeEntityKind,
  name: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()),
};

export const addEntity = defineCommand({
  type: 'core/knowledge.add-entity',
  payload: z.strictObject({
    id: Id,
    kind: EntityFields.kind,
    name: EntityFields.name,
    description: EntityFields.description.default(''),
    tags: EntityFields.tags.default([]),
  }),
  label: ({ name }) => `Add ${name}`,
  apply: (d, p) => {
    const taken = collectIds(d);
    if (taken.has(p.id)) throw new Error(`id "${p.id}" is already used`);
    const key = `${p.kind}\0${p.name.trim().toLowerCase()}`;
    if (d.knowledge.some((e) => `${e.kind}\0${e.name.trim().toLowerCase()}` === key))
      throw new Error(`"${p.name}" already exists`);
    d.knowledge.push({
      id: p.id,
      kind: p.kind,
      name: p.name.trim(),
      description: p.description,
      sourcePaths: [],
      confidence: 1,
      origin: 'user',
      excludedFromLlm: false,
      tags: p.tags,
      extensions: {},
    });
  },
});

/** Editing an extracted entity makes it the user's: later scans leave it alone. */
export const updateEntity = defineCommand({
  type: 'core/knowledge.update-entity',
  payload: z.strictObject({
    id: Id,
    patch: z.strictObject({
      kind: EntityFields.kind.optional(),
      name: EntityFields.name.optional(),
      description: EntityFields.description.optional(),
      tags: EntityFields.tags.optional(),
    }),
  }),
  label: () => 'Edit knowledge entry',
  apply: (d, { id, patch }) => {
    const e = d.knowledge.find((x) => x.id === id);
    if (!e) throw new Error(`no knowledge entity "${id}"`);
    if (patch.kind !== undefined) e.kind = patch.kind;
    if (patch.name !== undefined) e.name = patch.name.trim();
    if (patch.description !== undefined) e.description = patch.description;
    if (patch.tags !== undefined) e.tags = patch.tags;
    e.origin = 'user';
  },
});

/** Excluded entities are never sent to an LLM. Does not change ownership. */
export const setEntityExcluded = defineCommand({
  type: 'core/knowledge.set-excluded',
  payload: z.strictObject({ id: Id, excluded: z.boolean() }),
  label: ({ excluded }) => (excluded ? 'Exclude from AI' : 'Allow for AI'),
  apply: (d, { id, excluded }) => {
    const e = d.knowledge.find((x) => x.id === id);
    if (!e) throw new Error(`no knowledge entity "${id}"`);
    e.excludedFromLlm = excluded;
  },
});

export const removeEntity = defineCommand({
  type: 'core/knowledge.remove-entity',
  payload: z.strictObject({ id: Id }),
  label: () => 'Remove knowledge entry',
  apply: (d, { id }) => {
    if (referencedEntityIds(d as unknown as Project).has(id))
      throw new Error(
        `"${id}" is used by the storyboard; exclude it instead, or edit the slot first`,
      );
    if (!d.knowledge.some((e) => e.id === id)) throw new Error(`no knowledge entity "${id}"`);
    d.knowledge = d.knowledge.filter((e) => e.id !== id);
  },
});

/** Registered by the core plugin. Payloads are validated at dispatch, so the list is type-erased. */
export const knowledgeCommands = [
  addSource,
  removeSource,
  applyScan,
  addEntity,
  updateEntity,
  setEntityExcluded,
  removeEntity,
] as unknown as readonly CommandDef<unknown>[];
