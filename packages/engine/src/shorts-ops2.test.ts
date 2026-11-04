import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claudeCodeConceptsOp,
  claudeCodeConceptsPreviewOp,
  CLAUDE_CODE_CONCEPTS_WARNING,
} from './concepts-ops.js';
import { Engine } from './engine.js';
import { OpError } from './ops.js';
import { createShortOp, fillSlotOp, shortsViewOp } from './shorts-ops.js';

const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const concept = {
  source: 'user' as const,
  title: 'Parry the Ash Warden',
  hook: 'A boss swing stops dead on a perfect parry.',
  formatId: 'game-trailer/tiktok-montage',
  pitch: 'The parry sets the game apart.',
  shotList: ['A perfect parry', 'The key art'],
  voiceover: [],
  targetSeconds: 20,
  entityIds: [],
};

const mock = createMockProvider({ 'tiktok.wording': { slots: [] } });
let root: string;
let engine: Engine;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-shorts-ops2-'));
  const llm = new LlmClient({
    providers: (id) => (id === 'core/mock' ? mock : undefined),
    routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
  });
  engine = await Engine.start({ home: join(root, 'home'), autosaveMs: 0, loadUserPlugins: false, llm }); // prettier-ignore
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(root, 'clip.mp4')]); // prettier-ignore
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=800x450:r=1:d=1', '-frames:v', '1', join(root, 'art.png')]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=220:d=2', join(root, 'voice.wav')]);
});
afterAll(async () => engine.close());
let n = 0;
const open = () => engine.createProject(join(root, `p${n++}.tforge`), { ...sampleProject(), name: 'Shorts' } as never); // prettier-ignore

describe('creating and filling a TikTok', { timeout: 120_000 }, () => {
  it('makes one from your own concept, builds the template, and shows it in the view', async () => {
    const store = await open();
    const r = await createShortOp(engine, store, { concept, name: 'Parry', wording: false });
    expect(r.shortId).toBe('short_parry');
    expect(r.build).toMatchObject({ kept: 0, wording: { status: 'off' } });
    const v = (await shortsViewOp(engine, store)).shorts[0]!;
    expect(v).toMatchObject({
      id: 'short_parry',
      name: 'Parry',
      hasTemplate: true,
      platform: 'tiktok',
    });
    expect(v.concept).toMatchObject({ formatName: 'Hook + gameplay montage', source: 'user', targetSeconds: 20 }); // prettier-ignore
    expect(v.progress).toMatchObject({ slotsFilled: 0, lines: 0 });
    expect(v.slots.find((s) => s.kind === 'card')!.accepts).toEqual([]);
    expect(v.slots[0]!.accepts).toEqual(['gameplay', 'video']);
    expect(v.cut).toEqual({ built: false, mode: null, seconds: null });
    await store.close();
  });

  it('picks a waiting concept (it leaves the list); needs exactly one source of the concept', async () => {
    const store = await open();
    store.dispatch('core/concepts.add', { concepts: [{ ...concept, source: 'app' }] });
    const view = await shortsViewOp(engine, store);
    expect(view.concepts.map((c) => c.id)).toEqual(['con_parry_the_ash_warden']);
    const r = await createShortOp(engine, store, { conceptId: 'con_parry_the_ash_warden', wording: false, build: false }); // prettier-ignore
    expect(r.build).toBeNull();
    expect((await shortsViewOp(engine, store)).concepts).toEqual([]);
    await expect(createShortOp(engine, store, {})).rejects.toBeInstanceOf(OpError);
    await expect(createShortOp(engine, store, { conceptId: 'con_nope' })).rejects.toThrow(
      /no concept/,
    );
    await store.close();
  });

  it('fills a slot with a file by path (imported first) or by library id, with the right kind', async () => {
    const store = await open();
    await createShortOp(engine, store, { concept: { ...concept, formatId: 'game-trailer/tiktok-voiceover', voiceover: ['This boss has one tell.'] }, name: 'Parry', wording: false }); // prettier-ignore
    const id = (k: string) => `short_parry_${k}`;
    const a = await fillSlotOp(engine, store, 'short_parry', { slotId: id('hook'), path: join(root, 'clip.mp4') }); // prettier-ignore
    expect(a).toMatchObject({ input: 'gameplay', target: id('hook') });
    const b = await fillSlotOp(engine, store, 'short_parry', { slotId: id('b1'), path: join(root, 'art.png') }); // prettier-ignore
    expect(b.input).toBe('image');
    const c = await fillSlotOp(engine, store, 'short_parry', { voLineId: 'short_parry_vo1', path: join(root, 'voice.wav') }); // prettier-ignore
    expect(c.input).toBe('voiceover');
    const v = (await shortsViewOp(engine, store)).shorts[0]!;
    expect(v.progress).toMatchObject({ slotsFilled: 2, linesRecorded: 1 });
    expect(v.slots.find((s) => s.id === id('b1'))!.chosen).toMatchObject({ name: 'art.png', input: 'image' }); // prettier-ignore
    expect(v.voiceLines[0]!.chosen!.name).toBe('voice.wav');
    // The same file again, by library id, into another slot.
    await fillSlotOp(engine, store, 'short_parry', { slotId: id('b2'), assetId: a.assetId });
    expect((await shortsViewOp(engine, store)).shorts[0]!.progress.slotsFilled).toBe(3);
    await store.close();
  });

  it('says what is wrong', async () => {
    const store = await open();
    await createShortOp(engine, store, { concept: { ...concept, formatId: 'game-trailer/tiktok-voiceover' }, name: 'Parry', wording: false }); // prettier-ignore
    const fill = (o: object) => fillSlotOp(engine, store, 'short_parry', o);
    await expect(fill({ path: 'x' })).rejects.toThrow(/exactly one of a slot id/);
    await expect(fill({ slotId: 'short_parry_hook' })).rejects.toThrow(
      /exactly one of a library file id/,
    );
    await expect(fill({ slotId: 'short_parry_hook', assetId: 'asset_nope' })).rejects.toThrow(
      /no library file/,
    );
    await expect(
      fill({ slotId: 'short_parry_hook', path: join(root, 'missing.mp4') }),
    ).rejects.toBeInstanceOf(OpError);
    await expect(fillSlotOp(engine, store, 'short_nope', { slotId: 'a', assetId: 'b' })).rejects.toThrow(/no TikTok/); // prettier-ignore
    const audio = await fill({ voLineId: 'short_parry_vo1', path: join(root, 'voice.wav') }).catch((e: Error) => e); // prettier-ignore
    expect(audio).toBeInstanceOf(Error); // the concept has no voiceover lines
    await expect(fill({ slotId: 'short_parry_hook', path: join(root, 'voice.wav') })).rejects.toThrow(/picture slot takes video or images/); // prettier-ignore
    await store.close();
  });
});

describe.skipIf(process.platform === 'win32')('Ask Claude Code', { timeout: 120_000 }, () => {
  async function fakeClaude(reply: unknown) {
    const bin = join(root, `claude-${n++}`);
    await writeFile(
      bin,
      `#!/usr/bin/env node
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c)).on('end', () => {
  process.stdout.write(JSON.stringify({ result: '', structured_output: ${JSON.stringify(reply)}, usage: { input_tokens: 1, output_tokens: 1 } }));
});
`,
    );
    await chmod(bin, 0o755);
    return bin;
  }
  const withRepo = async () => {
    const repo = join(root, `repo${n++}`);
    await mkdir(join(repo, 'Assets'), { recursive: true });
    await writeFile(join(repo, 'Assets', 'Boss.cs'), 'class Boss { void Parry() {} }');
    await writeFile(join(repo, 'README.md'), '# Ember Knight');
    const store = await open();
    store.dispatch('core/knowledge.add-source', { id: 'src_repo2', kind: 'local-repo', path: repo, extractorIds: ['core/generic'], include: [], exclude: [], lastScannedAt: null, digestHash: null }); // prettier-ignore
    return { store, repo };
  };

  it('shows exactly what it would send first, and refuses to run without a yes', async () => {
    const { store, repo } = await withRepo();
    // The sample project already has a source (its own repo); use the one added here.
    const p = await claudeCodeConceptsPreviewOp(engine, store, { repo });
    expect(p).toMatchObject({ repo, files: 2, warning: CLAUDE_CODE_CONCEPTS_WARNING });
    expect(p.prompt).toContain('read-only copy of the game');
    expect(p.prompt).toContain('Ember Knight');
    await expect(claudeCodeConceptsOp(engine, store, { repo })).rejects.toThrow(
      /Confirm explicitly/,
    );
    expect(store.state.concepts).toEqual([]);
    await store.close();
  });

  it('adds what Claude Code proposes as its own concepts, after the same checks', async () => {
    const { store, repo } = await withRepo();
    const bin = await fakeClaude({
      concepts: [
        { ...concept, source: undefined, title: 'From the code', formatId: 'game-trailer/tiktok-pov', entityIds: ['ent_warden'] },
        { ...concept, source: undefined, title: 'Too wordy', pitch: 'x'.repeat(1200) },
      ].map(({ source: _s, ...c }) => c),
    }); // prettier-ignore
    const notices: string[] = [];
    const r = await claudeCodeConceptsOp(engine, store, { repo, allow: true, claudeBin: bin, count: 2, onNotice: (m) => notices.push(m) }); // prettier-ignore
    expect(r.filesShared).toBe(2);
    expect(notices[0]).toMatch(/read 2 text files/);
    expect(r.added.map((c) => [c.title, c.source])).toEqual([['From the code', 'claude-code']]);
    expect(r.rejected.map((x) => x.title)).toEqual(['Too wordy']);
    expect(store.state.concepts[0]).toMatchObject({ source: 'claude-code' });
    await store.close();
  });
});
