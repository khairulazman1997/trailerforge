import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCodeProvider, loadPrompt } from '@trailerforge/llm';
import type { ExtractedEntity, LlmProvider } from '@trailerforge/plugin-api';
import { KnowledgeEntityKind } from '@trailerforge/schema';
import { z } from 'zod';
import type { ScanResult } from './scan.js';

export const KNOWLEDGE_PROMPTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'prompts',
);

/** Thrown unless the caller passes `consent: true` after showing the user the warning. */
export class DeepScanConsentError extends Error {
  constructor() {
    super(
      'Deep scan sends the contents of your project files to Anthropic through Claude Code. ' +
        'It is off by default; pass consent: true (CLI: --deep --allow-deep-scan) to run it.',
    );
    this.name = 'DeepScanConsentError';
  }
}

const MAX_ENTITIES = 150;
/** Upper bound on what is copied for Claude Code to read. */
const MAX_COPY_BYTES = 40 * 1024 * 1024;
/** Deep-scan results come from a model reading prose and code, so they start less trusted. */
export const DEEP_SCAN_CONFIDENCE = 0.6;

export const DeepScanOutput = z.strictObject({
  entities: z
    .array(
      z.strictObject({
        kind: KnowledgeEntityKind,
        name: z.string().min(1).max(80),
        description: z.string().default(''),
        paths: z.array(z.string()).default([]),
      }),
    )
    .max(MAX_ENTITIES * 2),
});

export interface DeepScanOptions {
  scan: Pick<ScanResult, 'root' | 'files' | 'manifest'>;
  /** Must be exactly true. Obtain it from an explicit user action, never a default. */
  consent: boolean;
  gameName?: string;
  /** Path of the `claude` CLI; default `claude` on PATH. */
  claudeBin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Test seam: build the provider for the sandbox folder. */
  makeProvider?: (cwd: string) => LlmProvider;
}

export interface DeepScanResult {
  entities: ExtractedEntity[];
  /** Files copied into the sandbox, i.e. everything Claude Code could read. */
  filesShared: number;
  /** True when the copy hit the size cap and some files were left out. */
  truncated: boolean;
}

/**
 * Opt-in "deep" scan: lets Claude Code explore the repo with read-only tools and report
 * entities the static extractors can't see. Claude Code runs inside a throwaway copy that holds
 * only the files the scanner accepted (so .gitignore, size caps and secret exclusion apply by
 * construction; a secret file isn't in the sandbox to be read), with Read/Grep/Glob only.
 */
export async function deepScan(opts: DeepScanOptions): Promise<DeepScanResult> {
  if (opts.consent !== true) throw new DeepScanConsentError();
  const sandbox = await mkdtemp(join(tmpdir(), 'tforge-deepscan-'));
  try {
    let bytes = 0;
    let truncated = false;
    const shared: string[] = [];
    for (const rel of opts.scan.files) {
      opts.signal?.throwIfAborted();
      const size = opts.scan.manifest[rel]?.size ?? 0;
      if (bytes + size > MAX_COPY_BYTES) {
        truncated = true;
        continue;
      }
      await mkdir(dirname(join(sandbox, rel)), { recursive: true });
      await copyFile(join(opts.scan.root, rel), join(sandbox, rel));
      bytes += size;
      shared.push(rel);
    }

    const provider =
      opts.makeProvider?.(sandbox) ??
      createClaudeCodeProvider({
        ...(opts.claudeBin ? { bin: opts.claudeBin } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        tools: ['Read', 'Grep', 'Glob'],
        cwd: sandbox,
      });
    const prompt = await loadPrompt(
      'knowledge.deep-scan',
      { gameName: opts.gameName ?? '', maxEntities: String(MAX_ENTITIES) },
      [KNOWLEDGE_PROMPTS_DIR],
    );
    const result = await provider.generate(
      {
        task: 'knowledge.deep-scan',
        system:
          'You are a careful research assistant. You only read files; you never modify anything.',
        prompt,
        schema: DeepScanOutput,
        effort: 'medium',
      },
      opts.signal ?? new AbortController().signal,
    );

    const allowed = new Set(shared);
    const entities = result.value.entities.slice(0, MAX_ENTITIES).map((e): ExtractedEntity => ({
      kind: e.kind,
      name: e.name.trim(),
      description: e.description.trim().slice(0, 300),
      // Drop paths the model invented or that point outside what it was shown.
      sourcePaths: e.paths.filter((p) => allowed.has(p)),
      confidence: DEEP_SCAN_CONFIDENCE,
    }));
    return { entities, filesShared: shared.length, truncated };
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}
