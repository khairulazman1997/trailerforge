import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '@trailerforge/engine';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { shotCodes } from '@trailerforge/pack-game-trailer';
import { Project } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.js';

const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? createMockProvider({}) : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});
const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

let root: string;
let home: string;
let project: string;
let recordings: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-clifoot-'));
  home = join(root, 'home');
  project = join(root, 'Ember.tforge');
  recordings = join(root, 'rec');
  mkdirSync(recordings);
  const code = shotCodes(Project.parse(sampleProject())).get('shot_parry')!;
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=320x180:r=30:d=6',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    join(recordings, `${code}.mp4`),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='if(lt(mod(t-0.25\\,0.5)\\,0.01)*gte(t\\,0.25)\\,sin(2*PI*2000*t)\\,0)':s=44100:d=20",
    join(recordings, 'song.wav'),
  ]);
  const engine = await Engine.start({ home, autosaveMs: 0, loadUserPlugins: false, llm });
  const store = await engine.createProject(project, sampleProject() as never);
  store.dispatch('core/music.set-track', { assetId: null });
  await engine.close();
});

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    [...args, '--home', home],
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    process.env,
    { engine: { llm } },
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('tforge ingest → analyze → match → cut', () => {
  it('runs the whole footage flow from the command line', async () => {
    const song = join(recordings, 'song.wav');
    // the song is music, not footage: import it by hand and choose it (as the app will)
    const setup = await Engine.start({ home, autosaveMs: 0, loadUserPlugins: false, llm });
    const store = await setup.openProject(project);
    const music = (await setup.library.importFile(song)).asset;
    store.dispatch('core/music.set-track', { assetId: music.id });
    await setup.close();

    const imp = await run(['ingest', project, join(recordings, 'TF-' + 'x'), '--wait']);
    expect(imp.code).toBe(1); // nothing found at that path
    expect(imp.out).toMatch(/Queued 0/);

    const ok = await run(['ingest', project, recordings, '--wait']);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/Imported: 2 done/);

    const status = await run(['footage', project]);
    expect(status.out).toMatch(/1 recording;/);
    expect(status.out).toMatch(/not analysed/);

    expect((await run(['analyze', project, '--wait'])).out).toMatch(/Analysed: 2 done/);

    const suggest = await run(['match', project]);
    expect(suggest.out).toMatch(/shot_parry \(code, certain\)/);
    const accept = await run(['match', project, '--accept']);
    expect(accept.out).toMatch(/Attached 1 recording/);

    const cut = await run(['cut', project]);
    expect(cut.code).toBe(0);
    expect(cut.out).toMatch(/Rough cut: \d+ items, 1 placeholder/);

    const json = JSON.parse((await run(['cut', project, '--json'])).out) as {
      timelineId: string;
      keptEdits: string[];
    };
    expect(json.timelineId).toBe('tl_rough');
    const saved = JSON.parse(await readFile(join(project, 'project.json'), 'utf8')) as {
      timelines: { id: string }[];
    };
    expect(saved.timelines.map((t) => t.id)).toContain('tl_rough');
  }, 180_000);

  it('explains what is missing', async () => {
    const bare = join(root, 'Bare.tforge');
    const engine = await Engine.start({ home, autosaveMs: 0, loadUserPlugins: false, llm });
    await engine.createProject(bare, { name: 'Bare' });
    await engine.close();
    const r = await run(['cut', bare]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no storyboard/);
    expect((await run(['match', project, '--min', 'sure'])).code).toBe(2);
    expect((await run(['cut', project])).code).toBe(0);
    expect((await run(['ingest', project])).code).toBe(2);
  });
});
