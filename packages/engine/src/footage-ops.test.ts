import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { shotCodes } from '@trailerforge/pack-game-trailer';
import { Project, type ShotSlot } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from './engine.js';
import {
  ROUGH_CUT_TIMELINE_ID,
  analyzeOp,
  footageStatusOp,
  generateCutOp,
  importFootageOp,
  matchAcceptOp,
  matchSuggestOp,
  rankTakesOp,
} from './footage-ops.js';

const mock = createMockProvider({
  'cut.rank-takes': () => ({
    shots: [{ key: 'shot-1', best: 'take-2', reason: 'Fewer black frames.' }],
  }),
});
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});
const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

let root: string;
let engine: Engine;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-footage-'));
  engine = await Engine.start({
    home: join(root, 'home'),
    autosaveMs: 0,
    loadUserPlugins: false,
    llm,
  });
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

describe('footage ops, end to end', () => {
  it('import → analyse → match by code → rank → rough cut → regenerate keeps an edit → undo', async () => {
    const p = Project.parse(sampleProject());
    const codes = shotCodes(p);
    const recDir = join(root, 'recordings');
    mkdirSync(recDir);
    const clip = (name: string, seed: string) => {
      const out = join(recDir, name);
      ff([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=320x180:r=30:d=6',
        '-metadata',
        `title=${seed}`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        out,
      ]);
      return out;
    };
    // shot_parry has two takes (one coded, one numbered), shot_boss none
    clip(`${codes.get('shot_parry')} take1.mp4`, 'a');
    clip(`${codes.get('shot_parry')} take2.mp4`, 'b');
    const music = join(recDir, 'music.wav');
    ff([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='if(lt(mod(t-0.25\\,0.5)\\,0.01)*gte(t\\,0.25)\\,sin(2*PI*2000*t)\\,0)':s=44100:d=20",
      music,
    ]);

    const store = await engine.createProject(join(root, 'Cut.tforge'), {
      ...sampleProject(),
      id: 'proj_cut',
    } as never);
    const imp = await importFootageOp(engine, store, { paths: [recDir] });
    expect(imp.jobs).toHaveLength(3);
    await idle();
    const status = await footageStatusOp(engine, store);
    expect(status.footage).toHaveLength(2);
    expect(status.footage.every((f) => f.previews.proxy && f.file === 'ok')).toBe(true);
    expect(status.jobs.failed).toEqual([]);

    // the music: a library asset that is not footage; choose it, then analyse everything
    const m = (await engine.library.importFile(music)).asset;
    store.dispatch('core/music.set-track', { assetId: m.id });
    const an = await analyzeOp(engine, store);
    expect(an.jobs.map((j) => j.type).sort()).toEqual([
      'analysis/footage',
      'analysis/footage',
      'analysis/music',
    ]);
    await idle();

    const suggest = await matchSuggestOp(engine, store);
    expect(suggest.matches.filter((x) => x.kind === 'code')).toHaveLength(2);
    const accepted = await matchAcceptOp(engine, store);
    expect(accepted.attached).toHaveLength(2);
    const parry = () =>
      store.state
        .storyboard!.sections.flatMap((s) => s.slots)
        .find((s) => s.id === 'shot_parry') as ShotSlot;
    expect(parry().takes).toHaveLength(2);
    expect(parry().status).toBe('recorded');
    store.undo();
    expect(parry().takes).toHaveLength(0); // accepting was one undo step
    store.redo();

    const ranked = await rankTakesOp(engine, store);
    expect(ranked.chosen).toEqual([
      { slotId: 'shot_parry', takeId: parry().takes[1]!.id, reason: 'Fewer black frames.' },
    ]);
    expect(parry().chosenTakeId).toBe(parry().takes[1]!.id);

    const cut = await generateCutOp(engine, store);
    expect(cut).toMatchObject({ timelineId: ROUGH_CUT_TIMELINE_ID, unanalysed: 0 });
    const tl = () => store.state.timelines.find((t) => t.id === ROUGH_CUT_TIMELINE_ID)!;
    const items = () => tl().tracks.flatMap((t) => t.items);
    expect(items().find((i) => i.slotId === 'shot_parry')).toMatchObject({
      kind: 'clip',
      assetId: parry().takes[1]!.assetId,
    });
    expect(items().find((i) => i.slotId === 'shot_boss')).toMatchObject({ kind: 'placeholder' });
    expect(cut.placeholders).toBe(1);

    // a hand trim survives a rebuild; one undo takes the rebuild away again
    store.dispatch('core/timeline.trim', {
      timelineId: ROUGH_CUT_TIMELINE_ID,
      itemId: 'rc_shot_parry',
      edge: 'out',
      delta: -30_000_000,
    });
    const trimmed = items().find((i) => i.id === 'rc_shot_parry')!.duration;
    const again = await generateCutOp(engine, store);
    expect(again.keptEdits).toEqual(['rc_shot_parry']);
    expect(items().find((i) => i.id === 'rc_shot_parry')!.duration).toBe(trimmed);
    store.undo();
    expect(items().find((i) => i.id === 'rc_shot_parry')!.duration).toBe(trimmed);
  }, 180_000);

  it('says what is missing instead of guessing', async () => {
    const bare = await engine.createProject(join(root, 'Bare.tforge'), { name: 'Bare' });
    await expect(generateCutOp(engine, bare)).rejects.toMatchObject({ code: 'not-found' });
    const store = await engine.createProject(join(root, 'NoMusic.tforge'), {
      ...sampleProject(),
      id: 'proj_nm',
    } as never);
    store.dispatch('core/music.set-track', { assetId: null });
    await expect(generateCutOp(engine, store)).rejects.toMatchObject({ code: 'usage' });
    store.dispatch('core/music.set-track', { assetId: 'asset_not_in_library' });
    await expect(generateCutOp(engine, store)).rejects.toMatchObject({ code: 'not-found' });
    await expect(importFootageOp(engine, store, { paths: [] })).rejects.toMatchObject({
      code: 'usage',
    });
  });
});
