import { createHash } from 'node:crypto';
import { BUILTIN_PROMPTS_DIR, loadPrompt, type LlmClient } from '@trailerforge/llm';
import { DecisionRecord, type Project } from '@trailerforge/schema';
import { z } from 'zod';
import { buildCapturePlan, type CaptureItem } from './capture.js';
import { CAPTURE_TIPS_PROMPTS_DIR, excludedTerms, redactor, textLeaves } from './capture-tips.js';

/**
 * Optional, opt-in LLM take ranking (route `cut.rank-takes`). When a shot has several takes, the
 * model is asked which one the cut should use, from TEXT ONLY: the shot's words, the player's
 * notes and numbers that software measured in each recording. Never frames, footage, file names,
 * paths or ids (shots and takes go out as opaque aliases), and nothing about an entity excluded
 * from LLM use. The result is a payload for `core/takes.choose-many` (one undo step) plus
 * decision records with a reason each; nothing changes until it is applied.
 */

export const RANK_TAKES_TASK = 'cut.rank-takes';
const SHOTS_PER_CALL = 10;
const MAX_REASON = 200;
const REDACTED = '[redacted]';

/** Measured facts about one recording, summarised from its footage analysis. */
export interface TakeFacts {
  seconds: number;
  blackSeconds: number;
  frozenSeconds: number;
  flashFrames: number;
  sceneChanges: number;
  /** 0 (still) to 100 (busy). */
  motion: number;
}

export const GeneratedTakeRanking = z.strictObject({
  shots: z.array(
    z.strictObject({ key: z.string(), best: z.string(), reason: z.string().default('') }),
  ),
});

export interface RankTakesDeps {
  llm: LlmClient;
  now?: () => Date;
}

export interface RankTakesOptions {
  /** Facts per library asset id; takes without facts are still ranked on notes and match. */
  facts: ReadonlyMap<string, TakeFacts>;
  /** Also rank shots where the user already chose a take. */
  overwriteChosen?: boolean;
  signal?: AbortSignal;
}

export interface RankedChoice {
  slotId: string;
  takeId: string;
  reason: string;
  /** The model gave nothing usable for the reason; a plain sentence stands in. */
  reasonFallback: boolean;
}

export interface RankTakesResult {
  /** Payload for `core/takes.choose-many`; apply only when `choices` is not empty. */
  apply: { choices: { slotId: string; takeId: string }[] };
  choices: RankedChoice[];
  decisions: DecisionRecord[];
  skipped: {
    slotId: string;
    reason: 'single-take' | 'chosen' | 'no-facts' | 'no-reply' | 'bad-reply';
  }[];
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const round1 = (n: number) => Math.round(n * 10) / 10;

interface ShotInput {
  title: string;
  instruction: string;
  framing: string;
  needSeconds: number;
  recordSeconds: number;
  notes: string;
  takes: {
    seconds?: number;
    blackSeconds?: number;
    frozenSeconds?: number;
    flashFrames?: number;
    sceneChanges?: number;
    motion?: number;
    matchedBy: string;
    notes: string;
  }[];
}

function decisionRecord(at: Date, rec: Omit<DecisionRecord, 'id' | 'at' | 'alternatives'>) {
  const iso = at.toISOString();
  const id = `dec_${sha256(`${rec.step}|${iso}|${rec.subject.id}|${rec.inputsHash ?? ''}`).slice(0, 24)}`;
  return DecisionRecord.parse({ ...rec, id, at: iso });
}

/**
 * Ask the model which take of each multi-take shot to use. Pure with respect to the project and
 * the library: nothing is stored, so a cancelled or failed run changes nothing. The client's
 * disclosure gate runs before anything leaves the machine. Works with any provider, including
 * Mock and Chat Handoff.
 */
export async function rankTakes(
  deps: RankTakesDeps,
  project: Project,
  opts: RankTakesOptions,
): Promise<RankTakesResult> {
  const { signal } = opts;
  const sb = project.storyboard;
  const result: RankTakesResult = {
    apply: { choices: [] },
    choices: [],
    decisions: [],
    skipped: [],
  };
  if (!sb) return result;

  const terms = excludedTerms(project.knowledge);
  const redact = redactor(terms);
  const plan = buildCapturePlan(sb, project.knowledge);
  const items = new Map<string, CaptureItem>(
    plan.groups.flatMap((g) => g.items).map((i) => [i.slotId, i]),
  );

  interface Candidate {
    slotId: string;
    input: ShotInput;
    takeIds: string[];
    assetIds: string[];
    hash: string;
  }
  const todo: Candidate[] = [];
  for (const slot of sb.sections.flatMap((s) => s.slots)) {
    if (slot.kind !== 'shot') continue;
    const item = items.get(slot.id);
    if (!item) continue; // skipped shots are not part of the cut
    const takes = slot.takes.filter((t) => !t.rejected);
    if (takes.length < 2) {
      if (slot.takes.length > 0) result.skipped.push({ slotId: slot.id, reason: 'single-take' });
      continue;
    }
    if (slot.chosenTakeId && !opts.overwriteChosen) {
      result.skipped.push({ slotId: slot.id, reason: 'chosen' });
      continue;
    }
    const withFacts = takes.filter((t) => opts.facts.has(t.assetId));
    if (withFacts.length === 0 && takes.every((t) => !t.note.trim()) && !item.notes.trim()) {
      result.skipped.push({ slotId: slot.id, reason: 'no-facts' });
      continue;
    }
    const input: ShotInput = {
      title: redact(item.title),
      instruction: redact(item.instruction),
      framing: redact(item.framing),
      needSeconds: item.duration.min,
      recordSeconds: item.recordSeconds,
      notes: redact(item.notes),
      takes: takes.map((t) => {
        const f = opts.facts.get(t.assetId);
        return {
          ...(f
            ? {
                seconds: round1(f.seconds),
                blackSeconds: round1(f.blackSeconds),
                frozenSeconds: round1(f.frozenSeconds),
                flashFrames: f.flashFrames,
                sceneChanges: f.sceneChanges,
                motion: Math.round(f.motion),
              }
            : {}),
          matchedBy: t.matchedBy,
          notes: redact(t.note),
        };
      }),
    };
    todo.push({
      slotId: slot.id,
      input,
      takeIds: takes.map((t) => t.id),
      assetIds: takes.map((t) => t.assetId),
      hash: sha256(JSON.stringify(input)),
    });
  }
  if (todo.length === 0) return result;

  const at = (deps.now ?? (() => new Date()))();
  const system = await loadPrompt('system.trailer-craft', { projectName: project.name }, [
    BUILTIN_PROMPTS_DIR,
  ]);

  for (let i = 0; i < todo.length; i += SHOTS_PER_CALL) {
    signal?.throwIfAborted();
    const batch = todo.slice(i, i + SHOTS_PER_CALL);
    const wire = batch.map((b, n) => ({
      key: `shot-${n + 1}`,
      ...b.input,
      takes: b.input.takes.map((t, k) => ({ key: `take-${k + 1}`, ...t })),
    }));
    // Check the project text that goes in (not the fixed template); enums are not user text.
    const sent = wire
      .flatMap((w) => textLeaves(w, ['key', 'matchedBy']))
      .join('\n')
      .toLowerCase();
    const leaked = terms.find((t) => sent.includes(t.toLowerCase()));
    if (leaked !== undefined) {
      throw new Error(
        'refusing to send: the prompt still contains knowledge excluded from LLM use',
      );
    }
    const prompt = await loadPrompt(
      'cut.rank-takes',
      {
        videoType: sb.meta.videoTypeId ?? 'game trailer',
        shots: JSON.stringify(wire, null, 2),
      },
      [CAPTURE_TIPS_PROMPTS_DIR],
    );
    const r = await deps.llm.generate(
      RANK_TAKES_TASK,
      { system, prompt, schema: GeneratedTakeRanking },
      signal,
    );
    signal?.throwIfAborted();
    const byKey = new Map(r.value.shots.map((s) => [s.key, s]));
    for (const [n, c] of batch.entries()) {
      const reply = byKey.get(`shot-${n + 1}`);
      if (!reply) {
        result.skipped.push({ slotId: c.slotId, reason: 'no-reply' });
        continue;
      }
      const k = /^take-(\d+)$/.exec(reply.best.trim())?.[1];
      const idx = k ? Number(k) - 1 : -1;
      const takeId = c.takeIds[idx];
      if (takeId === undefined) {
        result.skipped.push({ slotId: c.slotId, reason: 'bad-reply' });
        continue;
      }
      const text = reply.reason.trim().replace(/\s+/g, ' ').slice(0, MAX_REASON);
      const usable = text.length > 0 && !text.includes(REDACTED);
      const reason = usable ? text : 'Chosen by the AI ranking from the measured facts and notes.';
      result.choices.push({ slotId: c.slotId, takeId, reason, reasonFallback: !usable });
      result.apply.choices.push({ slotId: c.slotId, takeId });
      result.decisions.push(
        decisionRecord(at, {
          step: 'game-trailer/rank-takes',
          subject: { kind: 'slot', id: c.slotId },
          choice: { takeId, assetId: c.assetIds[idx] ?? null },
          reasons: {
            provider: r.provider,
            model: r.model,
            fellBack: r.fellBack,
            takes: c.takeIds.length,
            reason,
          },
          summary: `Take ranking chose ${takeId}: ${reason}`,
          inputsHash: c.hash,
        }),
      );
    }
  }
  return result;
}
