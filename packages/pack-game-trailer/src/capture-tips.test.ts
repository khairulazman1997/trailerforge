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
import { parseProject, Project } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import {
  captureCommands,
  captureTipsCommands,
  generateCaptureTips,
  PACK_ID,
  readCaptureTips,
  resolveCaptureTips,
  tipsInputs,
} from './index.js';

const NOW = () => new Date('2026-10-24T12:00:00.000Z');

function clientFor(provider: LlmProvider, approveSend?: () => boolean) {
  return new LlmClient({
    providers: (id) => (id === provider.id ? provider : undefined),
    routes: RoutesConfig.parse({ default: { provider: provider.id }, fallbacks: [] }),
    ...(approveSend ? { approveSend } : {}),
  });
}

/** A reply that gives every group in the request one tip and one risk, keyed by what it was sent. */
const replyAll = (req: { prompt: string }) => {
  const keys = [...req.prompt.matchAll(/"key": "([^"]*)"/g)].map((m) => m[1]!);
  return {
    groups: keys.map((key) => ({ key, tips: [`tip for ${key}`], risks: [`risk for ${key}`] })),
  };
};

const project = () => Project.parse(sampleProject());
const keysOf = (p: Project) => tipsInputs(p).groups.map((g) => g.group.key);

async function withStore(
  fn: (store: ProjectStore) => void | Promise<void>,
  tweak: (p: Project) => void = () => undefined,
) {
  const dir = join(await mkdtemp(join(tmpdir(), 'tforge-tips-')), 'P.tforge');
  const registry = coreCommands();
  for (const c of [...captureCommands, ...captureTipsCommands]) registry.register(c);
  const p = project();
  tweak(p);
  const store = await ProjectStore.create(dir, p, { commands: registry, autosaveMs: 0 });
  try {
    await fn(store);
    expect(parseProject(store.state).ok).toBe(true);
  } finally {
    await store.close();
  }
}

describe('generateCaptureTips', () => {
  it('generates, stores through a command, undoes, and skips fresh groups next time', async () => {
    const mock = createMockProvider({ 'capture.tips': replyAll });
    const deps = { llm: clientFor(mock), now: NOW };
    await withStore(async (store) => {
      const r = await generateCaptureTips(deps, store.state);
      expect(r.apply.groups.map((g) => g.key)).toEqual(keysOf(store.state));
      expect(r.apply.generatedAt).toBe('2026-10-24T12:00:00.000Z');
      expect(readCaptureTips(store.state)).toEqual({}); // nothing stored yet

      store.dispatch('game-trailer/capture.apply-tips', r.apply);
      expect(resolveCaptureTips(store.state).groups.map((g) => g.status)).toEqual([
        'fresh',
        'fresh',
      ]);

      const again = await generateCaptureTips(deps, store.state);
      expect(again.apply.groups).toEqual([]);
      expect(again.skipped.map((s) => s.reason)).toEqual(['fresh', 'fresh']);
      expect(mock.calls).toHaveLength(1);

      const forced = await generateCaptureTips(deps, store.state, { force: true });
      expect(forced.apply.groups).toHaveLength(2);

      store.undo();
      expect(store.state.extensions[PACK_ID]).toBeUndefined();
    });
  });

  it('marks tips stale when the group changes', async () => {
    const deps = { llm: clientFor(createMockProvider({ 'capture.tips': replyAll })), now: NOW };
    await withStore(async (store) => {
      store.dispatch(
        'game-trailer/capture.apply-tips',
        (await generateCaptureTips(deps, store.state)).apply,
      );
      const slot = store.state.storyboard!.sections[0]!.slots[0]!;
      if (slot.kind !== 'shot') throw new Error('expected a shot');
      // Same group key (location/setup/entity unchanged) but different instruction text.
      const changed = structuredClone(store.state);
      const s = changed.storyboard!.sections[0]!.slots[0]!;
      if (s.kind === 'shot') s.captureInstruction = 'Do something else entirely';
      const statuses = resolveCaptureTips(changed).groups.map((g) => g.status);
      expect(statuses).toEqual(['fresh', 'stale']); // groups with no entity sort last
      const regen = await generateCaptureTips(deps, changed);
      expect(regen.apply.groups).toHaveLength(1);
    });
  });

  it('keeps hand edits unless told to overwrite', async () => {
    const deps = { llm: clientFor(createMockProvider({ 'capture.tips': replyAll })), now: NOW };
    await withStore(async (store) => {
      const [first] = keysOf(store.state);
      store.dispatch('game-trailer/capture.edit-tips', { key: first!, tips: ['mine'], risks: [] });
      expect(resolveCaptureTips(store.state).groups[0]!.status).toBe('edited');

      const r = await generateCaptureTips(deps, store.state);
      expect(r.skipped).toEqual([{ key: first, reason: 'edited' }]);
      store.dispatch('game-trailer/capture.apply-tips', r.apply);
      expect(readCaptureTips(store.state)[first!]!.tips).toEqual(['mine']);

      // Even a stale payload that names the edited group cannot overwrite it.
      store.dispatch('game-trailer/capture.apply-tips', {
        ...r.apply,
        groups: [{ key: first!, inputsHash: 'x', tips: ['sneaky'], risks: [] }],
      });
      expect(readCaptureTips(store.state)[first!]!.tips).toEqual(['mine']);

      const over = await generateCaptureTips(deps, store.state, {
        groupKeys: [first!],
        overwriteEdited: true,
      });
      store.dispatch('game-trailer/capture.apply-tips', over.apply);
      expect(readCaptureTips(store.state)[first!]).toMatchObject({ edited: false });
      expect(readCaptureTips(store.state)[first!]!.tips[0]).toContain('tip for');

      store.dispatch('game-trailer/capture.clear-tips', { key: first! });
      expect(readCaptureTips(store.state)[first!]).toBeUndefined();
      store.dispatch('game-trailer/capture.clear-tips', {});
      expect(store.state.extensions[PACK_ID]).toBeUndefined();
    });
  });

  it('never sends knowledge the user excluded, by name, id or path', async () => {
    const p = project();
    for (const e of p.knowledge) e.excludedFromLlm = true;
    const shot = p.storyboard!.sections[0]!.slots[0]!;
    if (shot.kind !== 'shot') throw new Error('expected a shot');
    shot.captureInstruction = 'Fight THE ASH WARDEN in the cinder forest, then check ent_warden';
    shot.alternates = ['Assets/Data/Bosses/AshWarden.asset'];
    p.knowledge.push({
      ...p.knowledge[0]!,
      id: 'ent_visible',
      name: 'Visible Boss',
      excludedFromLlm: false,
      sourcePaths: [],
    });
    const mock = createMockProvider({ 'capture.tips': replyAll });
    await generateCaptureTips({ llm: clientFor(mock), now: NOW }, p);
    const sent = mock.calls
      .map((c) => c.prompt)
      .join('\n')
      .toLowerCase();
    for (const secret of [
      'ash warden',
      'cinder forest',
      'ent_warden',
      'ent_forest',
      'ashwarden.asset',
    ]) {
      expect(sent, secret).not.toContain(secret);
    }
    expect(sent).toContain('[redacted]');
  });

  it('works through Chat Handoff', async () => {
    const seen: string[] = [];
    const handoff = createChatHandoffProvider({
      request: async (req) => {
        seen.push(req.prompt);
        return JSON.stringify(replyAll(req));
      },
    });
    const r = await generateCaptureTips({ llm: clientFor(handoff), now: NOW }, project());
    expect(r.apply.groups).toHaveLength(2);
    expect(seen[0]).toContain('capture.tips');
  });

  it('cleans model replies: unknown keys, duplicates, length, caps and redaction leftovers', async () => {
    const p = project();
    const [a, b] = ['group-1', 'group-2'];
    const [realA, realB] = keysOf(p);
    const mock = createMockProvider({
      'capture.tips': {
        groups: [
          { key: 'made-up', tips: ['x'], risks: [] },
          {
            key: a,
            tips: ['  same ', 'same', 'y'.repeat(500), 't3', 't4', 't5', 'mentions [redacted]'],
            risks: ['r1', 'r2', 'r3', 'r4'],
          },
          { key: b, tips: [], risks: [] },
        ],
      },
    });
    const r = await generateCaptureTips({ llm: clientFor(mock), now: NOW }, p);
    expect(r.apply.groups).toHaveLength(1);
    const g = r.apply.groups[0]!;
    expect(g.tips).toHaveLength(4);
    expect(g.tips[0]).toBe('same');
    expect(g.tips[1]).toHaveLength(300);
    expect(g.risks).toEqual(['r1', 'r2', 'r3']);
    expect(r.apply.groups[0]!.key).toBe(realA);
    expect(r.skipped).toEqual([{ key: realB, reason: 'no-reply' }]);
  });

  it('splits many groups over several calls', async () => {
    const p = project();
    const slots = p.storyboard!.sections[0]!.slots;
    const base = slots[0]!;
    if (base.kind !== 'shot') throw new Error('expected a shot');
    for (let i = 0; i < 11; i++)
      slots.push({ ...structuredClone(base), id: `shot_x${i}`, location: `Place ${i}` });
    const mock = createMockProvider({ 'capture.tips': replyAll });
    const r = await generateCaptureTips({ llm: clientFor(mock), now: NOW }, p);
    expect(mock.calls).toHaveLength(2);
    expect(r.apply.groups).toHaveLength(keysOf(p).length);
  });
});

describe('cancel, consent and failure', () => {
  it('discards everything when cancelled mid-call or before it starts', async () => {
    const ctl = new AbortController();
    const mock = createMockProvider({
      'capture.tips': (req: { prompt: string }) => {
        ctl.abort();
        return replyAll(req);
      },
    });
    await withStore(async (store) => {
      const before = structuredClone(store.state);
      await expect(
        generateCaptureTips({ llm: clientFor(mock), now: NOW }, store.state, {
          signal: ctl.signal,
        }),
      ).rejects.toThrow();
      expect(store.state).toEqual(before);

      const calls = mock.calls.length;
      await expect(
        generateCaptureTips({ llm: clientFor(mock), now: NOW }, store.state, {
          signal: ctl.signal,
        }),
      ).rejects.toThrow();
      expect(mock.calls).toHaveLength(calls);
    });
  });

  it('stops at the disclosure gate when the user declines', async () => {
    const remote = {
      ...createMockProvider({ 'capture.tips': replyAll }),
      sendsDataOffDevice: true,
    };
    await expect(
      generateCaptureTips({ llm: clientFor(remote, () => false), now: NOW }, project()),
    ).rejects.toBeInstanceOf(LlmConsentError);
  });

  it('does not call the model when nothing needs tips', async () => {
    const p = project();
    for (const sec of p.storyboard!.sections)
      for (const s of sec.slots) if (s.kind === 'shot') s.status = 'approved';
    const mock = createMockProvider({ 'capture.tips': replyAll });
    const r = await generateCaptureTips({ llm: clientFor(mock), now: NOW }, p);
    expect(r.apply.groups).toEqual([]);
    expect(mock.calls).toHaveLength(0);
  });
});
