import { Id, MusicGridSettings, ProjectAssetRef } from '@trailerforge/schema';
import { z } from 'zod';
import { CommandError, defineCommand, type CommandDef } from './commands.js';

/**
 * The music track and the user's beat-grid nudges. These change how the cut lands on the music,
 * not what the storyboard says, so they leave the storyboard revision alone.
 */
function music(d: Parameters<CommandDef<unknown>['apply']>[0], type: string) {
  if (!d.storyboard) throw new CommandError(type, 'the project has no storyboard');
  return d.storyboard.music;
}

/** Pick the music track (adding it to the project as music if needed); null removes it. */
export const setMusicTrack = defineCommand({
  type: 'core/music.set-track',
  payload: z.strictObject({ assetId: Id.nullable() }),
  label: ({ assetId }) => (assetId ? 'Choose the music track' : 'Remove the music track'),
  apply: (d, { assetId }) => {
    const m = music(d, 'core/music.set-track');
    if (assetId === (m.trackAssetId ?? null)) return;
    delete m.grid; // nudges belong to the old track
    if (assetId === null) {
      delete m.trackAssetId;
      return;
    }
    if (!d.assets.some((a) => a.assetId === assetId)) {
      d.assets.push(
        ProjectAssetRef.parse({ assetId, role: 'music', addedAt: new Date().toISOString() }),
      );
    }
    m.trackAssetId = assetId;
  },
});

const GridPatch = z.strictObject({
  downbeatShift: z.int().min(-11).max(11).optional(),
  /** null clears the override. */
  tempo: z.number().min(30).max(300).nullable().optional(),
  /** null goes back to what analysis found. */
  beatsPerBar: z.int().min(1).max(12).nullable().optional(),
  barsPerPhrase: z.int().min(1).max(16).optional(),
  offset: z.int().optional(),
});

/** Nudge the beat grid. Repeated nudges within a second and a half undo as one step. */
export const setMusicGrid = defineCommand({
  type: 'core/music.set-grid',
  payload: z.strictObject({ patch: GridPatch }),
  label: () => 'Adjust the beat grid',
  apply: (d, { patch }) => {
    const m = music(d, 'core/music.set-grid');
    if (!m.trackAssetId)
      throw new CommandError('core/music.set-grid', 'choose a music track first');
    const next: Record<string, unknown> = { ...(m.grid ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else if (v !== undefined) next[k] = v;
    }
    const parsed = MusicGridSettings.safeParse(next);
    if (!parsed.success) {
      throw new CommandError(
        'core/music.set-grid',
        parsed.error.issues[0]?.message ?? 'invalid grid',
      );
    }
    m.grid = parsed.data;
  },
  merge: { key: () => 'grid', windowMs: 1500 },
});

/** Forget every nudge: back to the grid analysis found. */
export const resetMusicGrid = defineCommand({
  type: 'core/music.reset-grid',
  payload: z.strictObject({}),
  label: () => 'Reset the beat grid',
  apply: (d) => {
    delete music(d, 'core/music.reset-grid').grid;
  },
});

export const musicCommands = [
  setMusicTrack,
  setMusicGrid,
  resetMusicGrid,
] as unknown as readonly CommandDef<unknown>[];
