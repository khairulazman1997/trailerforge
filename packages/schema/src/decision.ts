import { z } from 'zod';
import { ContentHash, Id, IsoDateTime, PluginRef } from './common.js';

/**
 * One line of `logs/decisions.jsonl`: why an automated step chose what it chose. Rendered in
 * the UI as "chosen because..." and used to reproduce/debug analysis results.
 */
export const DecisionRecord = z.strictObject({
  id: Id,
  at: IsoDateTime,
  /** Step that decided, e.g. `core/select-segment`, `core/beat-snap`. */
  step: PluginRef,
  subject: z.strictObject({
    kind: z.enum(['section', 'slot', 'item', 'transition', 'timeline', 'storyboard', 'asset']),
    id: Id,
  }),
  choice: z.json(),
  /** Machine-readable reasons, e.g. `{ motion: 0.91, hud: false, beat: 3 }`. */
  reasons: z.record(z.string(), z.json()),
  /** Human-readable summary shown to the user. */
  summary: z.string().min(1),
  alternatives: z.array(z.strictObject({ choice: z.json(), score: z.number() })).default([]),
  /** Hash of the inputs, so a re-run can tell whether the decision is still valid. */
  inputsHash: ContentHash.optional(),
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;
