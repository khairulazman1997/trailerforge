import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DecisionRecord } from '@trailerforge/schema';
import { appendDurable } from './fs-atomic.js';

/** Validate and append records to `logs/decisions.jsonl` as one durable write. */
export async function appendDecisions(
  path: string,
  records: readonly DecisionRecord[],
): Promise<void> {
  if (records.length === 0) return;
  const lines = records.map((r) => JSON.stringify(DecisionRecord.parse(r))).join('\n');
  await mkdir(dirname(path), { recursive: true });
  await appendDurable(path, `${lines}\n`);
}

/** Read the decision log; skips lines that don't parse (a torn tail after a crash). */
export async function readDecisions(path: string): Promise<DecisionRecord[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: DecisionRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = DecisionRecord.safeParse(JSON.parse(line));
      if (r.success) out.push(r.data);
    } catch {
      // torn line
    }
  }
  return out;
}
