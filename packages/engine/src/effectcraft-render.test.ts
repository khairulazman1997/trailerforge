import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRender, ffmpegArgs, type EncodeSettings } from '@trailerforge/compile';
import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from './engine.js';
import { buildVersion, renderGraphics } from './render-ops.js';

/** M8 8.3: EffectCraft graphics through the build, the frame cache and the compiler (stub CLI). */

const STUB = fileURLToPath(
  new URL('../../effectcraft/src/__fixtures__/stub-cli.mjs', import.meta.url),
);
const RAW: EncodeSettings = {
  container: 'nut',
  threads: 1,
  video: { codec: 'rawvideo', pixFmt: 'yuv444p', args: [] },
};
const ff = (args: string[]) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return r.stdout;
};

const TIMELINE = {
  id: 'tl_rough',
  name: 'Rough cut',
  frameRate: { num: 30, den: 1 },
  resolution: { width: 320, height: 180 },
  tracks: [
    {
      id: 'trk_cards',
      kind: 'graphics',
      items: [
        {
          id: 'it_title',
          kind: 'graphic',
          start: 0,
          duration: FLICKS_PER_SECOND,
          templateId: 'effectcraft/project',
          params: { project: 'media/title.ecproj', comp: 'T' },
        },
      ],
    },
  ],
};

let root: string;
let engine: Engine;
let store: Awaited<ReturnType<Engine['createProject']>>;

async function writeEcproj(name: string) {
  await mkdir(join(store.paths.dir, 'media'), { recursive: true });
  await writeFile(
    join(store.paths.dir, 'media', 'title.ecproj'),
    JSON.stringify({
      savedBy: '0.9.2',
      schema: 2,
      comps: [{ name, width: 320, height: 180, frameRate: 30, duration: 2 }],
      log: [],
    }),
  );
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-ec-'));
  engine = await Engine.start({
    home: join(root, 'home'),
    autosaveMs: 0,
    loadUserPlugins: false,
    effectcraft: { bin: process.execPath, prefixArgs: [STUB, 'ok'] },
  });
  store = await engine.createProject(join(root, 'EC.tforge'), {
    ...sampleProject(),
    id: 'proj_ec',
  } as never);
  await writeEcproj('T');
  store.dispatch('core/timeline.set', { timeline: TIMELINE });
}, 60_000);
afterAll(async () => {
  await engine.close();
  await rm(root, { recursive: true, force: true });
});

describe('EffectCraft graphics in a render', { timeout: 120_000 }, () => {
  it('builds, renders once, serves the cache, and a range equals the full render', async () => {
    const b = await buildVersion(engine, store, null);
    expect(b.motion.map((m) => m.itemId)).toEqual(['it_title']);
    expect(b.scenes).toEqual([]);
    expect(b.warnings.join('\n')).not.toMatch(/not installed|needs EffectCraft/);
    expect(b.graphics.get('it_title')).toMatchObject({ frames: 30 });

    const first = await renderGraphics(store, b, undefined);
    const g = first.frames.get('it_title')!;
    expect(g).toMatchObject({ frames: 30, contentHash: b.motion[0]!.contentHash });
    expect(first.nonReproducible).toEqual([]);
    const frame0 = g.pattern.replace('%06d', '000000');
    const before = statSync(frame0).mtimeMs;
    const again = await renderGraphics(store, b, undefined);
    expect(again.frames.get('it_title')!.pattern).toBe(g.pattern);
    expect(statSync(frame0).mtimeMs).toBe(before); // nothing re-rendered

    const decode = (range?: { start: number; frames: number }) => {
      const plan = compileRender({
        timeline: b.timeline,
        sources: b.sources,
        graphics: first.frames,
        encode: RAW,
        ...(range ? { range } : {}),
      });
      const out = join(root, `${plan.planHash}.nut`);
      ff(ffmpegArgs(plan, out));
      return ff(['-i', out, '-f', 'rawvideo', '-pix_fmt', 'yuv444p', '-']);
    };
    const full = decode();
    const part = decode({ start: 10, frames: 8 });
    const frameBytes = 320 * 180 * 3;
    expect(full.length).toBe(30 * frameBytes);
    expect(part.equals(full.subarray(10 * frameBytes, 18 * frameBytes))).toBe(true);
    // The EffectCraft frames really are in the picture (the stub draws a band of colour).
    expect(full.subarray(0, frameBytes).some((v) => v !== full[0])).toBe(true);
  });

  it('the plan hash changes with what is drawn, not with where the project sits', async () => {
    const a = await buildVersion(engine, store, null);
    const same = await buildVersion(engine, store, null);
    expect(same.contentHash).toBe(a.contentHash);
    await writeEcproj('Other');
    const changed = await buildVersion(engine, store, null);
    expect(changed.contentHash).not.toBe(a.contentHash);
    await writeEcproj('T');
    expect((await buildVersion(engine, store, null)).contentHash).toBe(a.contentHash);
    expect(readFileSync(join(store.paths.dir, 'media', 'title.ecproj'), 'utf8')).toMatch(/"T"/);
  });

  it('without EffectCraft the item is left out with a reason', async () => {
    const bare = await Engine.start({
      home: join(root, 'home2'),
      autosaveMs: 0,
      loadUserPlugins: false,
      effectcraft: null,
    });
    try {
      const s = await bare.createProject(join(root, 'Bare.tforge'), {
        ...sampleProject(),
        id: 'proj_bare',
      } as never);
      s.dispatch('core/timeline.set', { timeline: TIMELINE });
      const b = await buildVersion(bare, s, null);
      expect(b.motion).toEqual([]);
      expect(b.warnings.join('\n')).toMatch(
        /"it_title" needs EffectCraft, which is not available: EffectCraft is not bundled/,
      );
    } finally {
      await bare.close();
    }
  });
});
