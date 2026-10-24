import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreCommands, ProjectStore } from '@trailerforge/core';
import {
  createChatHandoffProvider,
  createMockProvider,
  LlmClient,
  LlmConsentError,
  RoutesConfig,
} from '@trailerforge/llm';
import type { LlmProvider } from '@trailerforge/plugin-api';
import { Project, type ShotSlot } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { rankTakes, type TakeFacts } from './index.js';

const NOW = () => new Date('2026-10-24T12:00:00.000Z');
const T = '2026-10-24T10:00:00.000Z';

function clientFor(provider: LlmProvider, approveSend?: () => boolean) {
  return new LlmClient({
    providers: (id) => (id === provider.id ? provider : undefined),
    routes: RoutesConfig.parse({ default: { provider: provider.id }, fallbacks: [] }),
    ...(approveSend ? { approveSend } : {}),
  });
}

const facts = (o: Partial<TakeFacts> = {}): TakeFacts => ({
  seconds: 9,
  blackSeconds: 0,
  frozenSeconds: 0,
  flashFrames: 0,
  sceneChanges: 1,
  motion: 40,
  ...o,
});

/** shot_parry gets three takes (one rejected), shot_boss two, shot_forest one. */
function project() {
  const p = Project.parse(sampleProject());
  const shots = p
    .storyboard!.sections.flatMap((s) => s.slots)
    .filter((s): s is ShotSlot => s.kind === 'shot');
  const take = (id: string, assetId: string, extra: Partial<ShotSlot['takes'][number]> = {}) => ({
    id,
    assetId,
    matchedBy: 'code' as const,
    rejected: false,
    note: '',
    attachedAt: T,
    ...extra,
  });
  const byId = new Map(shots.map((s) => [s.id, s]));
  byId.get('shot_parry')!.takes = [
    take('take_p1', 'asset_p1'),
    take('take_p2', 'asset_p2', { note: 'clean parry' }),
    take('take_p3', 'asset_p3', { rejected: true }),
  ];
  byId.get('shot_boss')!.takes = [take('take_b1', 'asset_b1'), take('take_b2', 'asset_b2')];
  for (const id of ['asset_p1', 'asset_p2', 'asset_p3', 'asset_b1', 'asset_b2'])
    if (!p.assets.some((a) => a.assetId === id))
      p.assets.push({ assetId: id, role: 'footage', addedAt: T });
  const f = new Map<string, TakeFacts>([
    ['asset_p1', facts({ frozenSeconds: 3 })],
    ['asset_p2', facts()],
    ['asset_b1', facts({ flashFrames: 2 })],
    ['asset_b2', facts()],
  ]);
  return { p, facts: f };
}

/** Always picks the last take of every shot it is shown, with a reason. */
const pickLast = (req: { prompt: string }) => {
  const block = req.prompt.split('Shots (JSON)')[1]!.split('What the facts mean')[0]!;
  const shots = JSON.parse(block.slice(block.indexOf('['), block.lastIndexOf(']') + 1)) as {
    key: string;
    takes: { key: string }[];
  }[];
  return {
    shots: shots.map((s) => ({
      key: s.key,
      best: s.takes.at(-1)!.key,
      reason: `${s.takes.at(-1)!.key} is cleaner`,
    })),
  };
};

describe('rankTakes', () => {
  it('ranks multi-take shots from text only and returns an applicable payload with reasons', async () => {
    const { p, facts: f } = project();
    const mock = createMockProvider({ 'cut.rank-takes': pickLast });
    const r = await rankTakes({ llm: clientFor(mock), now: NOW }, p, { facts: f });
    expect(r.apply.choices).toEqual([
      { slotId: 'shot_parry', takeId: 'take_p2' },
      { slotId: 'shot_boss', takeId: 'take_b2' },
    ]);
    expect(r.choices[0]).toMatchObject({ reason: 'take-2 is cleaner', reasonFallback: false });
    expect(r.decisions).toHaveLength(2);
    expect(r.decisions[0]).toMatchObject({
      step: 'game-trailer/rank-takes',
      subject: { kind: 'slot', id: 'shot_parry' },
      choice: { takeId: 'take_p2', assetId: 'asset_p2' },
    });
    expect(r.skipped).toEqual(
      expect.arrayContaining([{ slotId: 'shot_forest', reason: 'single-take' }].slice(0, 0)),
    );
    expect(mock.calls).toHaveLength(1);
  });

  it('sends no ids, paths, file names or frames: shots and takes are opaque aliases', async () => {
    const { p, facts: f } = project();
    const mock = createMockProvider({ 'cut.rank-takes': pickLast });
    await rankTakes({ llm: clientFor(mock), now: NOW }, p, { facts: f });
    const sent = mock.calls.map((c) => c.prompt).join('\n');
    for (const secret of ['shot_parry', 'take_p1', 'asset_p1', 'asset_', 'take_b', '.mp4']) {
      expect(sent, secret).not.toContain(secret);
    }
    expect(sent).toContain('"key": "shot-1"');
    expect(sent).toContain('"key": "take-2"');
    expect(sent).toContain('clean parry'); // the player's note goes
    expect(sent).not.toContain('take-3'); // a rejected take is not offered
  });

  it('never sends knowledge the user excluded, by name, id or path, in titles, notes or framing', async () => {
    const { p, facts: f } = project();
    for (const e of p.knowledge) e.excludedFromLlm = true;
    const parry = p
      .storyboard!.sections.flatMap((s) => s.slots)
      .find((s) => s.id === 'shot_parry') as ShotSlot;
    parry.captureInstruction = 'Fight THE ASH WARDEN in the cinder forest';
    parry.takes[1]!.note =
      'Ash Warden stagger looked great, file Assets/Data/Bosses/AshWarden.asset';
    const mock = createMockProvider({ 'cut.rank-takes': pickLast });
    await rankTakes({ llm: clientFor(mock), now: NOW }, p, { facts: f });
    const sent = mock.calls
      .map((c) => c.prompt)
      .join('\n')
      .toLowerCase();
    for (const secret of ['ash warden', 'cinder forest', 'ent_warden', 'ashwarden.asset']) {
      expect(sent, secret).not.toContain(secret);
    }
    expect(sent).toContain('[redacted]');
  });

  it('skips shots the user already chose unless asked, and shots without facts or notes', async () => {
    const { p, facts: f } = project();
    const boss = p
      .storyboard!.sections.flatMap((s) => s.slots)
      .find((s) => s.id === 'shot_boss') as ShotSlot;
    boss.chosenTakeId = 'take_b1';
    const mock = createMockProvider({ 'cut.rank-takes': pickLast });
    const r = await rankTakes({ llm: clientFor(mock), now: NOW }, p, { facts: f });
    expect(r.apply.choices.map((c) => c.slotId)).toEqual(['shot_parry']);
    expect(r.skipped).toContainEqual({ slotId: 'shot_boss', reason: 'chosen' });
    const all = await rankTakes(
      { llm: clientFor(createMockProvider({ 'cut.rank-takes': pickLast })), now: NOW },
      p,
      { facts: f, overwriteChosen: true },
    );
    expect(all.apply.choices.map((c) => c.slotId)).toEqual(['shot_parry', 'shot_boss']);
    const none = await rankTakes(
      { llm: clientFor(createMockProvider({ 'cut.rank-takes': pickLast })), now: NOW },
      p,
      { facts: new Map(), overwriteChosen: true },
    );
    expect(none.skipped).toContainEqual({ slotId: 'shot_boss', reason: 'no-facts' });
    expect(none.apply.choices.map((c) => c.slotId)).toEqual(['shot_parry']); // its note is enough
  });

  it('copes with a model that leaves shots out, names a take that does not exist, or gives no usable reason', async () => {
    const { p, facts: f } = project();
    const mock = createMockProvider({
      'cut.rank-takes': () => ({
        shots: [
          { key: 'shot-1', best: 'take-9', reason: 'made up' },
          { key: 'shot-2', best: 'take-1', reason: 'the [redacted] one' },
        ],
      }),
    });
    const r = await rankTakes({ llm: clientFor(mock), now: NOW }, p, { facts: f });
    expect(r.skipped).toContainEqual({ slotId: 'shot_parry', reason: 'bad-reply' });
    expect(r.choices).toEqual([
      {
        slotId: 'shot_boss',
        takeId: 'take_b1',
        reason: expect.stringMatching(/AI ranking/),
        reasonFallback: true,
      },
    ]);
    const silent = await rankTakes(
      { llm: clientFor(createMockProvider({ 'cut.rank-takes': { shots: [] } })), now: NOW },
      p,
      { facts: f },
    );
    expect(silent.apply.choices).toEqual([]);
    expect(silent.skipped.filter((s) => s.reason === 'no-reply')).toHaveLength(2);
  });

  it('stores nothing when cancelled, and honours the disclosure gate', async () => {
    const { p, facts: f } = project();
    const before = JSON.stringify(p);
    const ac = new AbortController();
    ac.abort();
    await expect(
      rankTakes({ llm: clientFor(createMockProvider({ 'cut.rank-takes': pickLast })) }, p, {
        facts: f,
        signal: ac.signal,
      }),
    ).rejects.toThrow();
    expect(JSON.stringify(p)).toBe(before);
    const remote = {
      ...createMockProvider({ 'cut.rank-takes': pickLast }),
      sendsDataOffDevice: true,
    };
    await expect(
      rankTakes({ llm: clientFor(remote, () => false) }, p, { facts: f }),
    ).rejects.toBeInstanceOf(LlmConsentError);
  });

  it('works through Chat Handoff, and applies as one undo step', async () => {
    const { p, facts: f } = project();
    const handoff = createChatHandoffProvider({
      request: async (req) => JSON.stringify(pickLast(req)),
    });
    const r = await rankTakes({ llm: clientFor(handoff), now: NOW }, p, { facts: f });
    expect(r.apply.choices).toHaveLength(2);

    const dir = join(await mkdtemp(join(tmpdir(), 'tforge-rank-')), 'R.tforge');
    const store = await ProjectStore.create(dir, p, { commands: coreCommands(), autosaveMs: 0 });
    try {
      store.dispatch('core/takes.choose-many', r.apply);
      const chosen = () =>
        store.state
          .storyboard!.sections.flatMap((s) => s.slots)
          .map((s) => (s.kind === 'shot' ? s.chosenTakeId : undefined))
          .filter(Boolean);
      expect(chosen()).toEqual(['take_p2', 'take_b2']);
      store.undo();
      expect(chosen()).toEqual([]);
      expect(() =>
        store.dispatch('core/takes.choose-many', {
          choices: [{ slotId: 'shot_parry', takeId: 'take_p3' }],
        }),
      ).toThrow(/rejected/);
    } finally {
      await store.close();
    }
  });
});
