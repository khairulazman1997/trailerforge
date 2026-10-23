import { z } from 'zod';

export class LlmOutputError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
    /** Raw model output of the last attempt, for the decision log. */
    readonly raw: string,
  ) {
    super(message);
    this.name = 'LlmOutputError';
  }
}

/**
 * Pull a JSON value out of model text: a ```json fenced block if present, otherwise the
 * outermost {...} or [...] span. Returns undefined when nothing parses.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text)?.[1];
  const candidates = [fenced, text.trim()];
  const start = text.search(/[{[]/);
  if (start !== -1) {
    const close = text[start] === '{' ? '}' : ']';
    candidates.push(text.slice(start, text.lastIndexOf(close) + 1));
  }
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

export function jsonSchemaFor(schema: z.ZodType): string {
  return JSON.stringify(z.toJSONSchema(schema, { io: 'input', reused: 'ref' }));
}

/** Instructions appended to every structured request, for providers without native schemas. */
export function formatInstructions(schema: z.ZodType): string {
  return [
    'Respond with exactly one JSON value inside a ```json fenced code block and nothing else.',
    'It must validate against this JSON Schema:',
    jsonSchemaFor(schema),
  ].join('\n');
}

export function repairPrompt(issues: string[]): string {
  return [
    'Your previous reply did not validate. Fix these problems and reply again with the full corrected JSON',
    'in a single ```json fenced code block:',
    ...issues.map((i) => `- ${i}`),
  ].join('\n');
}

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; issues: string[] };

export function parseStructured<T>(schema: z.ZodType<T>, raw: unknown): ParseOutcome<T> {
  const value = typeof raw === 'string' ? extractJson(raw) : raw;
  if (value === undefined) return { ok: false, issues: ['no JSON found in the reply'] };
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}

/**
 * Validate-and-repair loop for text-returning backends: send, validate, and on failure send
 * a repair prompt listing the issues, up to `maxRepairs` times.
 */
export async function withRepairs<T>(
  schema: z.ZodType<T>,
  send: (prompt: string, attempt: number) => Promise<unknown>,
  firstPrompt: string,
  maxRepairs = 2,
): Promise<{ value: T; attempts: number }> {
  let prompt = firstPrompt;
  let raw: unknown;
  let issues: string[] = [];
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    raw = await send(prompt, attempt);
    const outcome = parseStructured(schema, raw);
    if (outcome.ok) return { value: outcome.value, attempts: attempt + 1 };
    issues = outcome.issues;
    prompt = repairPrompt(issues);
  }
  throw new LlmOutputError(
    `model output failed validation after ${maxRepairs + 1} attempts`,
    issues,
    typeof raw === 'string' ? raw : JSON.stringify(raw),
  );
}
