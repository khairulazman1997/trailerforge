import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDecisions, type ProjectStore } from '@trailerforge/core';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import type { LlmRequest } from '@trailerforge/plugin-api';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCritiqueFacts } from './critique.js';
import { critiqueFactsOp, critiqueOp } from './critique-ops.js';
import { Engine } from './engine.js';

/** The AI critique with a mock model: what is sent, what comes back, what is kept. */

let reply: unknown;
let onAsk: (() => void) | undefined;
const prompts: string[] = [];
const mock = createMockProvider({
  'critique.run': (req: LlmRequest<unknown>) => {
    prompts.push(`${req.system}\n${req.prompt}`);
    onAsk?.();
    return reply;
  },
});
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

let root: string;
let engine: Engine;
let store: ProjectStore;
const comments = () => store.state.review.comments;
const slot = (id: string) =>
  store.state.storyboard!.sections.flatMap((s) => s.slots).find((s) => s.id === id)!;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-critique-'));
  engine = await Engine.start({ home: join(root, 'home'), autosaveMs: 0, loadUserPlugins: false, llm }); // prettier-ignore
  store = await engine.createProject(join(root, 'C.tforge'), { ...sampleProject(), id: 'proj_crit' } as never); // prettier-ignore
  store.dispatch('core/knowledge.set-excluded', { id: 'ent_warden', excluded: true });
});
afterAll(async () => engine.close());
beforeEach(() => {
  prompts.length = 0;
  onAsk = undefined;
  reply = {
    notes: [
      { about: 'shot-1', kind: 'issue', text: 'The hook runs long for a parry.', fix: { type: 'slot-duration', shot: 'shot-1', seconds: 1.5, summary: 'Cut the hook to 1.5 seconds' } }, // prettier-ignore
      { about: 'overall', kind: 'idea', text: 'The pacing does not speed up.', atSeconds: 3 },
    ],
  };
});

describe('critique', () => {
  it('removes ids, file names and paths from the Quality Gate messages it forwards', () => {
    const facts = buildCritiqueFacts({
      project: store.state,
      timeline: store.state.timelines[0]!,
      beats: null,
      bars: null,
      findings: [
        { checkId: 'core/placeholders', severity: 'error', tier: 'hard', message: 'the recording for "shot_boss" (asset_forest, C:\\Users\\me\\Videos\\boss take 2.mp4 and /home/me/rec/x.mov) is missing', itemId: 'it_boss' }, // prettier-ignore
      ],
    });
    const f = (facts.wire.findings as { message: string; shot: string }[])[0]!;
    expect(f.message).toBe(
      'the recording for "shot-2" (an item, a file and a file) is missing'.replace(
        'shot-2',
        'shot-2',
      ),
    );
    expect(f.shot).toBe('shot-2');
    expect((facts.wire.cut as { music: string }).music).toBe('not analysed yet');
  });

  it('sends text only, with excluded names removed and no ids, paths or file names', async () => {
    const facts = await critiqueFactsOp(engine, store, null);
    expect(facts.excluded).toBe(1);
    expect(facts.summary.at(-1)).toMatch(/Never sent/);
    await critiqueOp(engine, store, null);
    const sent = prompts.join('\n');
    expect(sent).toContain('shot-1');
    expect(sent).toContain('Perfect parry');
    expect(sent).not.toMatch(/ash warden/i); // the boss, and its lower third, are excluded
    expect(sent).toContain('[redacted]');
    for (const id of [
      'shot_parry',
      'shot_boss',
      'card_end',
      'it_parry',
      'asset_',
      'sec_hook',
      'ent_warden',
      'tl_master',
      '.mp4',
      '.wav',
    ])
      expect(sent, id).not.toContain(id);
    expect(JSON.stringify(facts.wire)).not.toMatch(/ash warden/i);
  });

  it('stores the notes as critique comments in one undo step, with decisions', async () => {
    const before = comments().length;
    const out = await critiqueOp(engine, store, null);
    expect(out.notes.map((n) => [n.kind, n.slotId ?? null])).toEqual([['issue', 'shot_parry'], ['idea', null]]); // prettier-ignore
    const mine = comments().filter((c) => c.author === 'critique');
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({ variantId: null, at: 0, itemId: 'it_parry', resolved: false, fix: { type: 'slot-duration', slotId: 'shot_parry', seconds: 1.5 } }); // prettier-ignore
    expect(mine[1]!.at).toBe(3 * 705_600_000);
    expect(mine[1]!.fix).toBeUndefined();
    store.undo();
    expect(comments()).toHaveLength(before);
    store.redo();
    const log = await readDecisions(store.paths.decisions);
    expect(log.filter((d) => d.step === 'core/critique').length).toBeGreaterThanOrEqual(2);
  });

  it('a new run replaces the open critique notes and leaves people’s comments alone', async () => {
    store.dispatch('core/review.comment', { variantId: null, at: 0, text: 'Nice hook' });
    await critiqueOp(engine, store, null);
    expect(comments().filter((c) => c.author === 'critique')).toHaveLength(2);
    expect(comments().some((c) => c.text === 'Nice hook' && !c.author)).toBe(true);
  });

  it('refuses unknown shots, locked or card fixes and excluded names, and keeps the rest', async () => {
    reply = {
      notes: [
        { about: 'shot-9', text: 'Not in the cut.' },
        { about: 'shot-3', text: 'The end card could be shorter.', fix: { type: 'remove-slot', shot: 'shot-3', summary: 'Remove it' } }, // prettier-ignore
        { about: 'shot-2', text: 'Fight the Ash Warden sooner.' },
        { about: 'shot-2', text: 'Two seconds of reveal is plenty.', fix: { type: 'slot-duration', shot: 'shot-7', seconds: 2, summary: 'Shorter' } }, // prettier-ignore
        { about: 'shot-1', text: 'Bad length.', fix: { type: 'slot-duration', shot: 'shot-1', seconds: 0, summary: 'Zero' } }, // prettier-ignore
        { about: 'shot-1', text: '   ' },
      ],
    };
    const out = await critiqueOp(engine, store, null);
    expect(out.skipped.map((s) => [s.about, s.reason])).toEqual([['shot-9', 'unknown-shot'], ['shot-2', 'excluded'], ['shot-1', 'empty']]); // prettier-ignore
    expect(out.notes).toHaveLength(3);
    expect(out.notes.every((n) => !n.fix)).toBe(true);
    expect(out.droppedFixes.map((d) => d.reason)).toEqual([
      'the shot is in a locked section',
      'names a shot that is not in the cut',
      'the new length is missing or out of range',
    ]);
  });

  it('at most ten notes', async () => {
    reply = { notes: Array.from({ length: 14 }, (_, i) => ({ about: 'overall', text: `Note ${i}`, atSeconds: i })) }; // prettier-ignore
    const out = await critiqueOp(engine, store, null);
    expect(out.notes).toHaveLength(10);
    expect(out.skipped.filter((s) => s.reason === 'too-many')).toHaveLength(4);
  });

  it('applying a fix is one undo step: the edit and the resolved note go together', async () => {
    await critiqueOp(engine, store, null);
    const note = comments().find((c) => c.author === 'critique' && c.fix)!;
    const before = slot('shot_parry').duration;
    const rev = store.state.storyboard!.revision;
    store.dispatch('core/critique.apply-fix', { commentId: note.id });
    expect(slot('shot_parry').duration).toEqual({ min: 1.5, ideal: 1.5, max: 3 });
    expect(comments().find((c) => c.id === note.id)!.resolved).toBe(true);
    expect(store.state.storyboard!.revision).toBe(rev + 1);
    store.undo();
    expect(slot('shot_parry').duration).toEqual(before);
    expect(comments().find((c) => c.id === note.id)!.resolved).toBe(false);
    // Twice is refused once resolved; a note with no fix or a missing shot is refused too.
    store.dispatch('core/critique.apply-fix', { commentId: note.id });
    expect(() => store.dispatch('core/critique.apply-fix', { commentId: note.id })).toThrow(/already resolved/); // prettier-ignore
    const plain = comments().find((c) => c.author === 'critique' && !c.fix)!;
    expect(() => store.dispatch('core/critique.apply-fix', { commentId: plain.id })).toThrow(
      /no fix/,
    );
    store.undo();
  });

  it('a fix for a shot that has gone is refused as stale; dismissing is deleting', async () => {
    await critiqueOp(engine, store, null);
    const note = comments().find((c) => c.author === 'critique' && c.fix)!;
    store.dispatch('core/storyboard.remove-slot', { slotId: 'shot_parry' });
    expect(() => store.dispatch('core/critique.apply-fix', { commentId: note.id })).toThrow(
      /stale/,
    );
    store.dispatch('core/review.delete', { commentId: note.id });
    expect(comments().some((c) => c.id === note.id)).toBe(false);
    store.undo();
    store.undo();
  });

  it('a cancelled run stores nothing', async () => {
    const ctl = new AbortController();
    onAsk = () => ctl.abort();
    const before = JSON.stringify(comments());
    const v = store.state.storyboard!.revision;
    await expect(critiqueOp(engine, store, null, { signal: ctl.signal })).rejects.toThrow();
    expect(JSON.stringify(comments())).toBe(before);
    expect(store.state.storyboard!.revision).toBe(v);
  });
});
