import { answerSchema } from '@trailerforge/brief';
import { DeepScanOutput } from '@trailerforge/knowledge';
import { jsonSchemaFor } from '@trailerforge/llm';
import {
  GeneratedCaptureTips,
  GeneratedTakeRanking,
  videoTypes,
} from '@trailerforge/pack-game-trailer';
import { GeneratedSection, GeneratedStoryboard } from '@trailerforge/storyboard';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// Every schema TrailerForge asks an LLM to fill, as the Claude Code CLI receives it. The CLI
// rejected Zod's draft 2020-12 output ("no schema with key or ref ...2020-12/schema"); a strict
// draft-07 validator without format plugins is the conservative stand-in.
const briefAnswers = videoTypes
  .flatMap((vt) => vt.requirements ?? [])
  .map(
    (r) =>
      [
        `brief.suggest ${r.field}`,
        z.strictObject({
          value: answerSchema({
            id: r.field,
            input: r.input ?? 'text',
            minItems: r.minItems,
          } as never),
          reason: z.string(),
        }),
      ] as const,
  );

const schemas: (readonly [string, z.ZodType])[] = [
  ['storyboard.generate', GeneratedStoryboard],
  ['storyboard.regenerate-section', GeneratedSection],
  ['capture.tips', GeneratedCaptureTips],
  ['cut.rank-takes', GeneratedTakeRanking],
  ['knowledge.deep-scan', DeepScanOutput],
  ...briefAnswers,
];

describe('schemas sent to the Claude Code CLI', () => {
  it.each(schemas)('%s compiles under a strict draft-07 validator', (_name, schema) => {
    const json = JSON.parse(jsonSchemaFor(schema, { target: 'draft-7' })) as object;
    expect(json).not.toHaveProperty('$schema');
    expect(() => new Ajv({ strict: true }).compile(json)).not.toThrow();
  });

  it('covers the brief questions, including a date', () => {
    expect(briefAnswers.length).toBeGreaterThan(3);
    expect(briefAnswers.some(([n]) => n.includes('Release'))).toBe(true);
  });
});
