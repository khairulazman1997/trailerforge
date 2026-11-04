import { defineCommand, type CommandDef } from '@trailerforge/core';
import { Id } from '@trailerforge/schema';
import { z } from 'zod';
import { storyboardCommands } from './commands.js';

/**
 * A short (TikTok) has its own storyboard, edited with the same commands as the trailer's:
 * `core/storyboard.update-slot` becomes `core/shorts.storyboard.update-slot` with the payload
 * `{ shortId, edit: <the original payload> }`. Each runs the original command with the short's
 * storyboard standing in for the project's, so locks, hand-edit marks (which make a rebuild keep
 * the slot), cleanup of removed slots and comments behave the same. `core/storyboard.set` has no
 * twin: a short's storyboard is replaced with `core/shorts.set-storyboard`.
 */
const PREFIX = 'core/storyboard.';
const SHORT_PREFIX = 'core/shorts.storyboard.';

function twin(base: CommandDef<unknown>): CommandDef<unknown> {
  const Payload = z.strictObject({ shortId: Id, edit: base.payload });
  type P = z.infer<typeof Payload>;
  const def: CommandDef<P> = {
    type: SHORT_PREFIX + base.type.slice(PREFIX.length),
    payload: Payload,
    label: ({ edit }) => base.label(edit),
    apply: (d, { shortId, edit }) => {
      const short = d.shorts.find((s) => s.id === shortId);
      if (!short) throw new Error(`no short "${shortId}"`);
      if (!short.storyboard) throw new Error(`TikTok "${shortId}" has no template yet`);
      const main = d.storyboard;
      d.storyboard = short.storyboard;
      try {
        base.apply(d, edit);
        short.storyboard = d.storyboard;
      } finally {
        d.storyboard = main;
      }
    },
    ...(base.merge
      ? {
          merge: {
            key: (p: P) => `${p.shortId}:${base.merge!.key(p.edit)}`,
            windowMs: base.merge.windowMs,
          },
        }
      : {}),
  };
  return defineCommand(def) as unknown as CommandDef<unknown>;
}

export const shortStoryboardCommands: readonly CommandDef<unknown>[] = storyboardCommands
  .filter((c) => c.type.startsWith(PREFIX) && c.type !== 'core/storyboard.set')
  .map(twin);
