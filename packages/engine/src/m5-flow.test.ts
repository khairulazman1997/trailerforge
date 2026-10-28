import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fallbackFontPath } from '@trailerforge/core';
import { deriveVariant, timelineHash } from '@trailerforge/cut';
import { shotCodes } from '@trailerforge/pack-game-trailer';
import { FALLBACK_FONTS } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from './engine.js';
import {
  ROUGH_CUT_TIMELINE_ID,
  analyzeOp,
  generateCutOp,
  importFootageOp,
  matchAcceptOp,
  takeSources,
} from './footage-ops.js';
import {
  brandImportOp,
  createDefaultVariantsOp,
  renderVariantGraphicsOp,
  variantsViewOp,
} from './graphics-ops.js';

const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

let root: string;
let engine: Engine;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-m5-'));
  engine = await Engine.start({ home: join(root, 'home'), autosaveMs: 0, loadUserPlugins: false });
});
afterAll(async () => {
  await engine.close();
});

async function idle(ms = 90_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (engine.jobs.list().every((j) => j.status !== 'queued' && j.status !== 'running')) return;
    if (Date.now() > end) throw new Error('jobs did not finish');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const recording = (name: string, seconds: number, src: string) =>
  ff([
    '-f',
    'lavfi',
    '-i',
    `${src}=s=320x180:r=30:d=${seconds}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    join(root, name),
  ]);

describe('the whole M5 flow', () => {
  it('master cut → brand kit → 16:9 and 9:16 versions with a title, captions, a transition and a sound → identical twice → undo', async () => {
    const store = await engine.createProject(join(root, 'Versions.tforge'), {
      ...sampleProject(),
      id: 'proj_m5',
    } as never);
    const start = JSON.stringify(store.state);

    // A title card after the boss reveal (the sample has the flash out of the parry into the
    // boss, the name label over the boss, a whoosh before it and the end slate).
    store.dispatch('core/storyboard.add-slot', {
      sectionId: 'sec_escalation',
      slot: {
        id: 'card_title',
        kind: 'card',
        cardKind: 'title',
        templateId: 'core/title-card',
        text: 'Ember Knight',
        params: { subtitle: 'A dark fantasy action RPG' },
        duration: { min: 2, ideal: 2, max: 3 },
      },
    });

    // Coded recordings for both shots and a song with a clear beat.
    const codes = shotCodes(store.state);
    recording(`parry ${codes.get('shot_parry')}.mp4`, 5, 'testsrc2');
    recording(`boss ${codes.get('shot_boss')}.mp4`, 6, 'smptebars');
    const song = join(root, 'm5-song.wav');
    ff([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='if(lt(mod(t-0.25\\,0.5)\\,0.01)*gte(t\\,0.25)\\,sin(2*PI*2000*t)\\,0)':s=44100:d=20",
      song,
    ]);
    await importFootageOp(engine, store, {
      paths: [
        join(root, `parry ${codes.get('shot_parry')}.mp4`),
        join(root, `boss ${codes.get('shot_boss')}.mp4`),
        song,
      ],
    });
    await idle();
    const songId = engine.library.list().find((a) => a.originalName === 'm5-song.wav')!.id;
    store.dispatch('core/music.set-track', { assetId: songId });
    await analyzeOp(engine, store);
    await idle();
    await matchAcceptOp(engine, store, { minConfidence: 'certain' });
    await generateCutOp(engine, store);

    // The master has every accent the versions must carry.
    const master = store.state.timelines.find((t) => t.id === ROUGH_CUT_TIMELINE_ID)!;
    const items = master.tracks.flatMap((t) => t.items);
    expect(items.some((i) => i.kind === 'graphic' && i.templateId === 'core/title-card')).toBe(
      true,
    );
    expect(items.some((i) => i.kind === 'caption' && i.text === 'The Ash Warden')).toBe(true);
    expect(master.tracks.flatMap((t) => t.transitions).map((t) => t.transitionId)).toContain(
      'core/flash',
    );
    expect(master.tracks.some((t) => t.id === 'trk_sfx' && t.items.length > 0)).toBe(true);

    // A brand kit: colours and a heading font imported into the project.
    store.dispatch('core/brand.set-colors', {
      patch: { background: '#101820', text: '#f2f2f2', primary: '#f2aa4c' },
    });
    const font = join(root, 'Heading-Bold.otf');
    await copyFile(fallbackFontPath(FALLBACK_FONTS[1]!), font);
    await brandImportOp(store, { kind: 'font', path: font });

    // The sample has a 9:16 version; add the 16:9 one.
    expect(createDefaultVariantsOp(store).added).toHaveLength(1);
    const view = await variantsViewOp(engine, store);
    const ids = view.variants.map((v) => v.id);
    expect(view.variants.map((v) => v.format!.resolution)).toEqual(
      expect.arrayContaining([
        { width: 1920, height: 1080 },
        { width: 1080, height: 1920 },
      ]),
    );

    // Each version derives the same timeline every time, from scratch, and keeps the accents.
    const sources = await takeSources(engine, store);
    for (const variantId of ids) {
      const t0 = performance.now();
      const a = deriveVariant({ project: store.state, variantId, sources });
      // A few ms alone; the budget only catches a real regression under `pnpm check`'s load.
      expect(performance.now() - t0).toBeLessThan(2000);
      const b = deriveVariant({
        project: JSON.parse(JSON.stringify(store.state)),
        variantId,
        sources: await takeSources(engine, store),
      });
      expect(timelineHash(b.timeline)).toBe(timelineHash(a.timeline));
      const kinds = a.timeline.tracks.flatMap((t) => t.items.map((i) => i.kind));
      expect(kinds).toContain('graphic');
      expect(kinds).toContain('caption');
      expect(a.timeline.tracks.some((t) => t.id === 'trk_sfx' && t.items.length)).toBe(true);
    }

    // The graphics of every version render to the same pixels twice, into separate caches.
    const render = async (cache: string) => {
      const out = [];
      for (const variantId of ids)
        out.push(
          await renderVariantGraphicsOp(engine, store, variantId, {
            samples: 3,
            cacheDir: join(root, cache),
          }),
        );
      return out;
    };
    const first = await render('frames-1');
    const second = await render('frames-2');
    expect(second).toEqual(first);
    for (const v of first) {
      expect(v.items.map((i) => i.templateId)).toEqual(
        expect.arrayContaining(['core/title-card', 'core/lower-third', 'core/end-slate']),
      );
      expect(v.warnings.filter((w) => /font|logo/i.test(w))).toEqual([]);
    }
    // Wide and tall frames differ; the brand font is in the cache key.
    expect(first[0]!.items[0]!.frames[1]!.png).not.toBe(first[1]!.items[0]!.frames[1]!.png);

    // Undo walks every step back to the project as it was opened.
    while (store.undo());
    expect(JSON.stringify(store.state)).toBe(start);
  }, 180_000);
});
