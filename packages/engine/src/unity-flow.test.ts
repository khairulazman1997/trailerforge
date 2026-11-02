import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { musicCacheFile } from '@trailerforge/analysis';
import { writeAnalysisCache } from '@trailerforge/core';
import { type ShotSlot } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureExportOp } from './capture-ops.js';
import { demoMusic } from './demo-ops.js';
import { Engine } from './engine.js';
import { generateCutOp, importFootageOp, matchAcceptOp } from './footage-ops.js';

// The whole M9 flow with a real Unity: TrailerForge exports the pack, Unity (batch mode, the fixture project) records
// three takes of two shots into a watched folder at levels 1, 3 and 4, the watcher imports them, they attach by code and the rough
// cut uses them. Needs Unity 2022.3 with graphics; runs from `pnpm test:unity` (TFORGE_UNITY_FLOW=1), never in check.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

let root: string;
let engine: Engine;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-unity-flow-'));
  engine = await Engine.start({ home: join(root, 'home'), autosaveMs: 0, loadUserPlugins: false });
});
afterAll(async () => {
  await engine?.close();
});

async function idle(ms = 120_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (engine.jobs.list().every((j) => j.status !== 'queued' && j.status !== 'running')) return;
    if (Date.now() > end) throw new Error('jobs did not finish');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.runIf(process.env.TFORGE_UNITY_FLOW)('recording from Unity, end to end', () => {
  it('pack → Unity records levels 1, 3 and 4 → watched folder → attached by code with origins → rough cut', async () => {
    const store = await engine.createProject(join(root, 'UnityFlow.tforge'), {
      ...sampleProject(),
      id: 'proj_unity_flow',
    } as never);
    const exported = await captureExportOp(engine, store, { formats: ['json'] });
    const pack = join(
      store.paths.dir,
      exported.files.find((f) => f.endsWith('.json'))!,
    );

    const out = join(root, 'unity-recordings');
    mkdirSync(out);
    const watcher = engine.ingestor.watch({
      folders: [out],
      stableChecks: 2,
      projectId: store.state.id,
    });
    await watcher.poll(); // the first look sees an empty folder

    const unity = spawnSync(
      process.execPath,
      [
        join(repo, 'scripts/unity-test.mjs'),
        '--filter',
        'TrailerForge.Capture.Tests.WholeFlowTests',
      ],
      {
        env: { ...process.env, TFORGE_FLOW_PACK: pack, TFORGE_FLOW_OUT: out },
        encoding: 'utf8',
        timeout: 900_000,
      },
    );
    expect(unity.status, `${unity.stdout}\n${unity.stderr}`).toBe(0);
    expect(unity.stdout).toContain('1/1 passed');

    for (let i = 0; i < 4; i++) await watcher.poll();
    await idle();
    const imported = engine.library
      .list()
      .map((a) => a.originalName)
      .sort();
    expect(imported).toHaveLength(3);
    expect(imported.every((n) => /^TF-[0-9A-Z]{5}_take0[12]\.mp4$/.test(n))).toBe(true);
    // Unity's work folder is gone once every take is published
    expect(existsSync(join(out, '.tfpartial'))).toBe(false);

    const accepted = await matchAcceptOp(engine, store, { minConfidence: 'certain' });
    expect(accepted.attached).toHaveLength(3);
    const shots = store.state
      .storyboard!.sections.flatMap((s) => s.slots)
      .filter((s): s is ShotSlot => s.kind === 'shot' && s.takes.length > 0);
    expect(shots).toHaveLength(2);
    const takes = shots.flatMap((s) => s.takes);
    expect(takes.map((t) => t.origin?.level).sort()).toEqual(['camera', 'live', 'replay']);
    const replay = takes.find((t) => t.origin?.level === 'replay')!;
    expect(replay.origin?.label).toContain('0.5× speed');
    expect(replay.origin?.performanceId).toMatch(/^perf_/);
    // the live take and its replay sit on the same shot
    const both = shots.find((s) => s.takes.includes(replay))!;
    expect(both.takes.map((t) => t.origin?.level).sort()).toEqual(['live', 'replay']);

    // The beat is known by construction, so no Python is needed for the music.
    const music = demoMusic();
    const song = join(root, 'flow-music.wav');
    await writeFile(song, music.wav);
    await importFootageOp(engine, store, { paths: [song] });
    await idle();
    const track = engine.library.list().find((a) => a.originalName === 'flow-music.wav')!;
    store.dispatch('core/music.set-track', { assetId: track.id });
    await writeAnalysisCache(
      musicCacheFile(store.paths.analysisCache, track.quickHash),
      music.analysis,
    );

    await generateCutOp(engine, store);
    const tl = store.state.timelines.find((t) => t.id === 'tl_rough')!;
    const used = new Set(
      tl.tracks
        .flatMap((t) => t.items)
        .flatMap((i) => ('assetId' in i && i.assetId ? [i.assetId] : [])),
    );
    for (const s of shots)
      expect(
        s.takes.some((t) => used.has(t.assetId)),
        s.id,
      ).toBe(true);
  }, 1_200_000);
});
