import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PROMPTS_DIR, loadPrompt, type LlmClient } from '@trailerforge/llm';
import { IsoDateTime, type KnowledgeEntity, type Project } from '@trailerforge/schema';
import { z } from 'zod';
import { buildCaptureHints, type CaptureHint, type GroupHints } from './capture-hints.js';
import { buildCapturePlan, type CaptureGroup, type CapturePlan } from './capture.js';
import { readPackKey } from './pack-ext.js';
import { resolveRecordingSettings } from './recording.js';

/**
 * Optional LLM tips and risk notes per capture group. The model's output is not derivable, so
 * the accepted result is stored (through `game-trailer/capture.*-tips` commands) at
 * `extensions['game-trailer'].captureTips`, keyed by group key, with a hash of the inputs it was
 * written from. A changed group shows as stale; hand edits are never overwritten by default.
 * Nothing about an entity the user excluded from LLM use is ever put in the prompt.
 */

export const CAPTURE_TIPS_PROMPTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'prompts',
);

export const TIPS_TASK = 'capture.tips';
const MAX_TIPS = 4;
const MAX_RISKS = 3;
const MAX_LINE = 300;
const GROUPS_PER_CALL = 8;
const alias = (n: number): string => `group-${n + 1}`;

export const CaptureTipsEntry = z.strictObject({
  tips: z.array(z.string().min(1)).max(8).default([]),
  risks: z.array(z.string().min(1)).max(8).default([]),
  /** Hash of the prompt inputs this was written from; empty for entries typed by hand. */
  inputsHash: z.string().default(''),
  generatedAt: IsoDateTime.optional(),
  /** The user changed it; regenerating leaves it alone unless asked. */
  edited: z.boolean().default(false),
});
export type CaptureTipsEntry = z.infer<typeof CaptureTipsEntry>;

export const CaptureTipsExt = z.record(z.string().min(1), CaptureTipsEntry);
export type CaptureTipsExt = z.infer<typeof CaptureTipsExt>;

/** What the model returns. Lenient on size: the code trims, so a long reply is not a retry. */
export const GeneratedCaptureTips = z.strictObject({
  groups: z.array(
    z.strictObject({
      key: z.string(),
      tips: z.array(z.string()).default([]),
      risks: z.array(z.string()).default([]),
    }),
  ),
});

export function readCaptureTips(project: Pick<Project, 'extensions'>): CaptureTipsExt {
  const parsed = CaptureTipsExt.safeParse(readPackKey(project.extensions, 'captureTips') ?? {});
  return parsed.success ? parsed.data : {};
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const REDACTED = '[redacted]';
const MIN_NAME = 3;

/** Everything the user excluded from LLM use that could leak by name, id or path. */
function excludedTerms(knowledge: readonly KnowledgeEntity[]): string[] {
  const terms = knowledge
    .filter((e) => e.excludedFromLlm)
    .flatMap((e) => [e.name, e.id, ...e.sourcePaths])
    .map((t) => t.trim())
    .filter((t) => t.length >= MIN_NAME);
  return [...new Set(terms)].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function redactor(terms: string[]): (text: string) => string {
  if (terms.length === 0) return (t) => t;
  const re = new RegExp(terms.map(escapeRe).join('|'), 'gi');
  return (t) => t.replace(re, REDACTED);
}

export interface TipsGroupInput {
  location: string;
  setup: string;
  featured: string | null;
  shots: {
    title: string;
    instruction: string;
    framing: string;
    hud: string;
    targetSeconds: number;
    recordSeconds: number;
    alternates: string[];
  }[];
  hints: {
    levels: { name: string; detail: string }[];
    featured: { name: string; detail: string }[];
    debugCommands: { name: string; detail: string }[];
    saveFiles: { name: string; detail: string }[];
  };
}

/** The data for one group exactly as it will be sent: redacted, with no ids or paths. */
function groupInput(
  g: CaptureGroup,
  hints: GroupHints,
  redact: (t: string) => string,
): TipsGroupInput {
  const hint = (h: CaptureHint) => ({ name: redact(h.name), detail: redact(h.detail) });
  return {
    location: redact(g.location),
    setup: redact(g.setup),
    featured: g.entity && !g.entity.excludedFromLlm ? redact(g.entity.name) : null,
    shots: g.items.map((i) => ({
      title: redact(i.title),
      instruction: redact(i.instruction),
      framing: redact(i.framing),
      hud: i.hud,
      targetSeconds: i.duration.ideal,
      recordSeconds: i.recordSeconds,
      alternates: i.alternates.map(redact),
    })),
    hints: {
      levels: hints.levels.map(hint),
      featured: hints.featured.map(hint),
      debugCommands: hints.debugCommands.map(hint),
      saveFiles: hints.saveFiles.map(hint),
    },
  };
}

export interface TipsInputs {
  plan: CapturePlan;
  /** Per group, in plan order, with its input hash. */
  groups: { group: CaptureGroup; input: TipsGroupInput; hash: string }[];
  terms: string[];
}

export function tipsInputs(project: Project): TipsInputs {
  const plan = buildCapturePlan(project.storyboard ?? emptyStoryboard(), project.knowledge, {
    include: 'todo',
  });
  const hints = buildCaptureHints(plan, project.knowledge, { forLlm: true });
  const terms = excludedTerms(project.knowledge);
  const redact = redactor(terms);
  return {
    plan,
    terms,
    groups: plan.groups.map((group, i) => {
      const input = groupInput(group, hints[i]!, redact);
      return { group, input, hash: sha256(JSON.stringify(input)) };
    }),
  };
}

const emptyStoryboard = () => ({ id: 'none', revision: 0, sections: [] });

export type TipsStatus = 'none' | 'fresh' | 'stale' | 'edited';

export interface CaptureTipsView {
  groupKey: string;
  entry: CaptureTipsEntry | null;
  status: TipsStatus;
}

/** Stored tips against the current plan: which groups have tips, which went stale or were edited. */
export function resolveCaptureTips(project: Project): {
  groups: CaptureTipsView[];
  /** Stored keys that no group has any more (kept so a returning group finds its tips). */
  orphanKeys: string[];
} {
  const stored = readCaptureTips(project);
  const { groups } = tipsInputs(project);
  const live = new Set(groups.map((g) => g.group.key));
  return {
    groups: groups.map(({ group, hash }) => {
      const entry = stored[group.key] ?? null;
      const status: TipsStatus = !entry
        ? 'none'
        : entry.edited
          ? 'edited'
          : entry.inputsHash === hash
            ? 'fresh'
            : 'stale';
      return { groupKey: group.key, entry, status };
    }),
    orphanKeys: Object.keys(stored)
      .filter((k) => !live.has(k))
      .sort(),
  };
}

export interface GenerateTipsDeps {
  llm: LlmClient;
  now?: () => Date;
}

export interface GenerateTipsOptions {
  /** Only these groups. Default: every group that needs tips. */
  groupKeys?: readonly string[];
  /** Also regenerate groups whose stored tips are fresh. */
  force?: boolean;
  /** Also regenerate groups the user edited. */
  overwriteEdited?: boolean;
  signal?: AbortSignal;
}

export interface GeneratedTipsResult {
  /** Payload for `game-trailer/capture.apply-tips`. Nothing is stored until it is applied. */
  apply: {
    generatedAt: string;
    overwriteEdited: boolean;
    groups: { key: string; inputsHash: string; tips: string[]; risks: string[] }[];
  };
  /** Groups left out, with why. */
  skipped: { key: string; reason: 'fresh' | 'edited' | 'unknown' | 'no-reply' }[];
}

const clean = (lines: string[], max: number): string[] =>
  [
    ...new Set(
      lines
        .map((l) => l.trim().replace(/\s+/g, ' ').slice(0, MAX_LINE))
        .filter((l) => l.length > 0 && !l.includes(REDACTED)),
    ),
  ].slice(0, max);

/**
 * Ask the model for tips and risks for the capture groups that need them. Pure with respect to
 * the project: it returns a payload to apply, so a cancelled or failed run changes nothing. The
 * client's disclosure gate runs before anything leaves the machine. Works with any provider,
 * including Mock and Chat Handoff.
 */
export async function generateCaptureTips(
  deps: GenerateTipsDeps,
  project: Project,
  opts: GenerateTipsOptions = {},
): Promise<GeneratedTipsResult> {
  const { signal } = opts;
  const stored = readCaptureTips(project);
  const inputs = tipsInputs(project);
  const wanted = opts.groupKeys ? new Set(opts.groupKeys) : null;
  const known = new Set(inputs.groups.map((g) => g.group.key));
  const skipped: GeneratedTipsResult['skipped'] = [...(opts.groupKeys ?? [])]
    .filter((k) => !known.has(k))
    .map((key) => ({ key, reason: 'unknown' as const }));

  const todo = inputs.groups.filter(({ group, hash }) => {
    if (wanted && !wanted.has(group.key)) return false;
    const entry = stored[group.key];
    if (entry?.edited && !opts.overwriteEdited) {
      skipped.push({ key: group.key, reason: 'edited' });
      return false;
    }
    if (entry && !entry.edited && entry.inputsHash === hash && !opts.force) {
      skipped.push({ key: group.key, reason: 'fresh' });
      return false;
    }
    return true;
  });

  const at = (deps.now ?? (() => new Date()))();
  const out: GeneratedTipsResult['apply']['groups'] = [];
  const recording = resolveRecordingSettings(project).settings;
  const recordingLine = `${recording.resolution.width}×${recording.resolution.height} at ${recording.fps} fps, ${recording.codec} in ${recording.container}, HUD ${recording.hud}`;
  const system = await loadPrompt('system.trailer-craft', { projectName: project.name }, [
    BUILTIN_PROMPTS_DIR,
  ]);

  for (let i = 0; i < todo.length; i += GROUPS_PER_CALL) {
    signal?.throwIfAborted();
    const batch = todo.slice(i, i + GROUPS_PER_CALL);
    const prompt = await loadPrompt(
      'capture.tips',
      {
        videoType: project.storyboard?.meta.videoTypeId ?? 'game trailer',
        recording: recordingLine,
        // Group keys embed entity ids and raw location text, so the model sees opaque aliases.
        groups: JSON.stringify(
          batch.map((b, n) => ({ key: alias(n), ...b.input })),
          null,
          2,
        ),
      },
      [CAPTURE_TIPS_PROMPTS_DIR],
    );
    const leaked = inputs.terms.find((t) => prompt.toLowerCase().includes(t.toLowerCase()));
    if (leaked !== undefined) {
      throw new Error(
        'refusing to send: the prompt still contains knowledge excluded from LLM use',
      );
    }
    const r = await deps.llm.generate(
      TIPS_TASK,
      { system, prompt, schema: GeneratedCaptureTips },
      signal,
    );
    signal?.throwIfAborted();
    const byKey = new Map(r.value.groups.map((g) => [g.key, g]));
    for (const [n, { group, hash }] of batch.entries()) {
      const reply = byKey.get(alias(n));
      const tips = clean(reply?.tips ?? [], MAX_TIPS);
      const risks = clean(reply?.risks ?? [], MAX_RISKS);
      if (tips.length === 0 && risks.length === 0) {
        skipped.push({ key: group.key, reason: 'no-reply' });
      } else {
        out.push({ key: group.key, inputsHash: hash, tips, risks });
      }
    }
  }

  return {
    apply: {
      generatedAt: at.toISOString(),
      overwriteEdited: opts.overwriteEdited ?? false,
      groups: out,
    },
    skipped,
  };
}
