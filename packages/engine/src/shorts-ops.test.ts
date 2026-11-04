import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { sampleShortProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from './engine.js';
import { OpError } from './ops.js';
import { buildShortOp } from './shorts-ops.js';

const wordingReply: unknown = { slots: [{ key: 'slot-1', captionText: 'One tell. One chance.' }] };
let wordingFails = false;
const mock = createMockProvider({
  'tiktok.wording': () => {
    if (wordingFails) throw new Error('model unavailable');
    return wordingReply;
  },
});
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});
let engine: Engine;
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-shorts-'));
  engine = await Engine.start({ home: join(root, 'home'), autosaveMs: 0, loadUserPlugins: false, llm }); // prettier-ignore
});
afterAll(async () => {
  await engine.close();
});
let n = 0;
const open = async () => {
  const p = sampleShortProject();
  p.shorts![0]!.storyboard = null;
  p.shorts![0]!.concept = { ...p.shorts![0]!.concept, formatId: 'game-trailer/tiktok-voiceover' } as never; // prettier-ignore
  return engine.createProject(join(root, `p${n++}`), { ...p, name: 'Shorts' });
};
const SHORT = 'short_parry';
const slots = (store: Awaited<ReturnType<typeof open>>) =>
  store.state.shorts[0]!.storyboard!.sections.flatMap((s) => s.slots);

describe('buildShortOp', () => {
  it('builds the template from the format and concept, then improves the wording, as one undo step', async () => {
    const store = await open();
    wordingFails = false;
    const r = await buildShortOp(engine, store, SHORT);
    expect(r).toMatchObject({ shortId: SHORT, kept: 0, wording: { status: 'done', changed: 1 } });
    expect(r.rebuilt).toBe(slots(store).length);
    const sb = store.state.shorts[0]!.storyboard!;
    expect(sb.meta).toMatchObject({ templateId: 'game-trailer/tiktok-voiceover' });
    const hook = slots(store)[0]!;
    expect(hook.kind === 'shot' && hook.overlays[0]!.text).toBe('One tell. One chance.');
    expect(sb.voLines.map((v) => v.text)).toEqual(['This boss has one tell.', 'Miss it and you are done.']); // prettier-ignore
    const log = await readFile(store.paths.decisions, 'utf8');
    expect(log).toContain('game-trailer/tiktok-template');
    store.undo();
    expect(store.state.shorts[0]!.storyboard).toBeNull();
    await store.close();
  });

  it('still builds when the AI is off, fails or is declined', async () => {
    const store = await open();
    expect((await buildShortOp(engine, store, SHORT, { wording: false })).wording).toEqual({ status: 'off' }); // prettier-ignore
    store.undo();
    wordingFails = true;
    const r = await buildShortOp(engine, store, SHORT);
    expect(r.wording).toMatchObject({ status: 'skipped', reason: expect.stringContaining('model unavailable') }); // prettier-ignore
    expect(slots(store).length).toBeGreaterThan(3);
    wordingFails = false;
    await store.close();
  });

  it('building again keeps what has files or hand edits and only writes the rest', async () => {
    const store = await open();
    await buildShortOp(engine, store, SHORT, { wording: false });
    store.dispatch('core/shorts.fill-slot', { shortId: SHORT, target: { slotId: `${SHORT}_b1` }, assetId: 'asset_x', input: 'image' }); // prettier-ignore
    store.dispatch('core/shorts.storyboard.update-slot', { shortId: SHORT, edit: { slotId: `${SHORT}_b2`, patch: { title: 'Mine' } } }); // prettier-ignore
    store.dispatch('core/shorts.set-concept', { shortId: SHORT, concept: { shotList: ['A', 'B', 'C'] } }); // prettier-ignore
    const r = await buildShortOp(engine, store, SHORT, { wording: false });
    expect(r.kept).toBe(2);
    expect(slots(store).find((x) => x.id === `${SHORT}_b2`)!.title).toBe('Mine');
    expect(slots(store).find((x) => x.id === `${SHORT}_b1`)!.kind === 'shot').toBe(true);
    expect(slots(store).find((x) => x.id === `${SHORT}_b3`)!.title).toBe('C');
    await store.close();
  });

  it('can rebuild one section only', async () => {
    const store = await open();
    await buildShortOp(engine, store, SHORT, { wording: false });
    store.dispatch('core/shorts.set-concept', { shortId: SHORT, concept: { shotList: ['A', 'B', 'C'] } }); // prettier-ignore
    const end = store.state.shorts[0]!.storyboard!.sections.at(-1)!;
    const r = await buildShortOp(engine, store, SHORT, { sectionIds: [end.id], wording: false });
    expect(r.rebuilt).toBe(end.slots.length);
    expect(slots(store).find((x) => x.id === `${SHORT}_b1`)!.title).not.toBe('A');
    await expect(buildShortOp(engine, store, SHORT, { sectionIds: ['sec_nope'] })).rejects.toBeInstanceOf(OpError); // prettier-ignore
    await store.close();
  });

  it('stops when cancelled and stores nothing', async () => {
    const store = await open();
    const ctl = new AbortController();
    ctl.abort();
    await expect(buildShortOp(engine, store, SHORT, { signal: ctl.signal })).rejects.toThrow();
    expect(store.state.shorts[0]!.storyboard).toBeNull();
    await expect(buildShortOp(engine, store, 'short_nope')).rejects.toBeInstanceOf(OpError);
    await store.close();
  });
});
