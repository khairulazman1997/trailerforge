import {
  Id,
  IsoDateTime,
  Series,
  SubtitleStyle,
  ShortPlatform,
  collectIds,
  mintId,
  type Project,
} from '@trailerforge/schema';
import type { Draft } from 'immer';
import { z } from 'zod';
import { CommandError, defineCommand, type CommandDef } from './commands.js';

/**
 * Series: TikToks that belong together (one format, subtitle style and platform). Episodes are
 * normal shorts linked by `seriesId`, so everything a short can do, an episode can. These
 * commands only manage the series and the links.
 */

const SHORT_FORM = /^[a-z0-9-]+\/tiktok-/;
const DEFAULT_FORMAT = 'game-trailer/tiktok-montage';

const Text = (max: number) => z.string().trim().min(1).max(max);

function findSeries(d: Draft<Project>, id: string, type: string) {
  const s = d.series.find((x) => x.id === id);
  if (!s) throw new CommandError(type, `no series "${id}"`);
  return s;
}

/** The number the next episode of a series gets. */
export function nextEpisode(d: Pick<Project, 'shorts'>, seriesId: string): number {
  return d.shorts.reduce((n, s) => (s.seriesId === seriesId ? Math.max(n, s.episode ?? 0) : n), 0) + 1; // prettier-ignore
}

/** Put a short into a series: its number, and the series' subtitle style and platform. */
export function joinSeries(d: Draft<Project>, shortId: string, seriesId: string): void {
  const series = d.series.find((x) => x.id === seriesId);
  const short = d.shorts.find((x) => x.id === shortId);
  if (!series || !short) return;
  short.seriesId = seriesId;
  short.episode = nextEpisode({ shorts: d.shorts.filter((x) => x.id !== shortId) }, seriesId);
  short.platform = series.platform;
  short.subtitles.style = series.subtitleStyle;
}

export const addSeries = defineCommand({
  type: 'core/series.add',
  payload: z.strictObject({
    id: Id.optional(),
    name: Text(120),
    premise: z.string().trim().max(1000).optional(),
    formatId: z.string().regex(SHORT_FORM, 'a short-form format').optional(),
    subtitleStyle: SubtitleStyle.optional(),
    platform: ShortPlatform.optional(),
    cadencePerWeek: z.int().min(1).max(14).optional(),
    createdAt: IsoDateTime.optional(),
  }),
  label: ({ name }) => `Start series "${name}"`,
  apply: (d, p) => {
    const taken = collectIds(d);
    if (p.id && taken.has(p.id)) throw new CommandError('core/series.add', `id "${p.id}" is used`);
    const id = p.id ?? mintId('series', p.name, taken);
    d.series.push(
      Series.parse({
        id,
        name: p.name,
        premise: p.premise ?? '',
        formatId: p.formatId ?? DEFAULT_FORMAT,
        ...(p.subtitleStyle ? { subtitleStyle: p.subtitleStyle } : {}),
        ...(p.platform ? { platform: p.platform } : {}),
        ...(p.cadencePerWeek ? { cadencePerWeek: p.cadencePerWeek } : {}),
        createdAt: p.createdAt ?? new Date().toISOString(),
      }),
    );
  },
});

/** Change a series; `applyToEpisodes` also sets its subtitle style and platform on every episode. */
export const editSeries = defineCommand({
  type: 'core/series.edit',
  payload: z.strictObject({
    seriesId: Id,
    patch: z.strictObject({
      name: Text(120).optional(),
      premise: z.string().trim().max(1000).optional(),
      formatId: z.string().regex(SHORT_FORM, 'a short-form format').optional(),
      subtitleStyle: SubtitleStyle.optional(),
      platform: ShortPlatform.optional(),
      cadencePerWeek: z.int().min(1).max(14).nullable().optional(),
    }),
    applyToEpisodes: z.boolean().optional(),
  }),
  label: () => 'Edit series',
  apply: (d, { seriesId, patch, applyToEpisodes }) => {
    const s = findSeries(d, seriesId, 'core/series.edit');
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete (s as Record<string, unknown>)[k];
      else if (v !== undefined) (s as Record<string, unknown>)[k] = v;
    }
    if (applyToEpisodes)
      for (const sh of d.shorts)
        if (sh.seriesId === seriesId) {
          sh.platform = s.platform;
          sh.subtitles.style = s.subtitleStyle;
        }
  },
  merge: { key: ({ seriesId }) => `series:${seriesId}`, windowMs: 1500 },
});

/** Remove a series: its episodes stay as ordinary TikToks. */
export const removeSeries = defineCommand({
  type: 'core/series.remove',
  payload: z.strictObject({ seriesId: Id }),
  label: () => 'Remove series',
  apply: (d, { seriesId }) => {
    findSeries(d, seriesId, 'core/series.remove');
    d.series = d.series.filter((x) => x.id !== seriesId);
    for (const sh of d.shorts)
      if (sh.seriesId === seriesId) {
        delete sh.seriesId;
        delete sh.episode;
      }
    for (const c of d.concepts) if (c.seriesId === seriesId) delete c.seriesId;
  },
});

/** Make a TikTok an episode of a series (the next number), or take it out (`null`). */
export const setShortSeries = defineCommand({
  type: 'core/shorts.set-series',
  payload: z.strictObject({ shortId: Id, seriesId: Id.nullable() }),
  label: ({ seriesId }) => (seriesId ? 'Add TikTok to series' : 'Take TikTok out of its series'),
  apply: (d, { shortId, seriesId }) => {
    const type = 'core/shorts.set-series';
    const sh = d.shorts.find((x) => x.id === shortId);
    if (!sh) throw new CommandError(type, `no short "${shortId}"`);
    if (seriesId === null) {
      delete sh.seriesId;
      delete sh.episode;
      return;
    }
    findSeries(d, seriesId, type);
    joinSeries(d, shortId, seriesId);
  },
});

export const seriesCommands = [
  addSeries,
  editSeries,
  removeSeries,
  setShortSeries,
] as unknown as readonly CommandDef<unknown>[];
