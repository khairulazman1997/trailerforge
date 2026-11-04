import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '@trailerforge/engine';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.js';

const reply = (title: string) => ({
  title,
  hook: 'A boss swing stops dead.',
  formatId: 'game-trailer/tiktok-montage',
  pitch: 'Fits.',
  shotList: ['A parry'],
  voiceover: [],
  targetSeconds: 20,
  entityIds: ['ent_warden'],
});
const llm = new LlmClient({
  providers: (id) =>
    id === 'core/mock'
      ? createMockProvider({
          'tiktok.concepts': { concepts: [reply('Parry or die'), reply('Dev diary')] },
          'tiktok.wording': { slots: [] },
        })
      : undefined,
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});
let root: string;
let home: string;
let project: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-clitiktok-'));
  home = join(root, 'home');
  project = join(root, 'Ember.tforge');
  const engine = await Engine.start({ home, autosaveMs: 0, loadUserPlugins: false, llm });
  await engine.createProject(project, sampleProject() as never);
  await engine.close();
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(root, 'clip.mp4')]); // prettier-ignore
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

describe('tforge tiktok', { timeout: 120_000 }, () => {
  it('asks for concepts, picks one, builds it, fills a slot and builds the cut', async () => {
    const c = await run(['tiktok', 'concepts', project, '--idea', 'boss in 3 s', '--count', '2']);
    expect(c.code).toBe(0);
    expect(c.out).toMatch(/con_parry_or_die\s+Parry or die/);
    expect(c.out).toMatch(/2 concepts added/);

    const n = await run([
      'tiktok',
      'new',
      project,
      '--concept',
      'con_parry_or_die',
      '--name',
      'Parry',
      '--no-wording',
    ]);
    expect(n.code).toBe(0);
    expect(n.out).toMatch(/Made short_parry: \d+ slots written, wording off/);

    const l = await run(['tiktok', 'list', project]);
    expect(l.out).toMatch(/concept con_dev_diary/);
    expect(l.out).toMatch(/short_parry\s+Parry: Hook \+ gameplay montage, 20 s, tiktok/);
    expect(l.out).toMatch(/pictures 0\/\d+, voiceover 0\/0, cut: not built/);

    const f = await run([
      'tiktok',
      'fill',
      project,
      'short_parry',
      '--slot',
      'short_parry_hook',
      '--file',
      join(root, 'clip.mp4'),
    ]);
    expect(f.code).toBe(0);
    expect(f.out).toBe('short_parry_hook ← ' + f.out.split('← ')[1]);
    expect(f.out).toMatch(/\(gameplay\)/);

    const s = await run([
      'tiktok',
      'subtitles',
      project,
      'short_parry',
      '--on',
      '--style',
      'word-pop',
      '--platform',
      'reels',
    ]);
    expect(s.out).toBe('Subtitles on (word-pop), made for reels, 0 hand changes');

    const mu = await run(['tiktok', 'music', project, 'short_parry', '--taps', '0,0.5,1,1.5,2,2.5', '--export', 'without']); // prettier-ignore
    expect(mu.code).toBe(0);
    expect(mu.out).toMatch(/tempo 120; export without/);
    expect(mu.out).toMatch(/tapped: 120 BPM/);
    expect((await run(['tiktok', 'music', project, 'short_parry', '--taps', '0,1'])).code).toBe(2);

    const cl = await run(['tiktok', 'clean', project, 'short_parry', '--off']);
    expect(cl.out).toMatch(/^Voice clean-up off/);
    expect((await run(['tiktok', 'clean', project, 'short_parry', '--on'])).out).toMatch(/^Voice clean-up on/); // prettier-ignore

    const po = await run(['tiktok', 'post', project, 'short_parry', '--caption', 'One perfect parry.', '--hashtags', '#EmberKnight,indiedev', '--comment', 'Wishlist!', '--cover', 'Parry or die', '--at', '1.5']); // prettier-ignore
    expect(po.out).toBe('One perfect parry.\n\n#EmberKnight #indiedev\n\nPinned comment:\nWishlist!\n\nCover title:\nParry or die\nCover frame at 1.5 s'); // prettier-ignore
    expect((await run(['tiktok', 'post', project, 'short_parry', '--at', 'poster'])).out).not.toMatch(/Cover frame/); // prettier-ignore

    const h0 = await run(['tiktok', 'hooks', project, 'short_parry']);
    expect(h0.out).toMatch(/^No hook versions/);
    const h1 = await run(['tiktok', 'hooks', project, 'short_parry', '--add', '--name', 'Question', '--caption', 'Can you parry this?', '--kind', 'question']); // prettier-ignore
    expect(h1.out).toBe('short_parry_hk_a  Question (question): Can you parry this?');
    const h2 = await run([
      'tiktok',
      'hooks',
      project,
      'short_parry',
      '--edit',
      'a',
      '--caption',
      'Try this',
    ]);
    expect(h2.out).toMatch(/Try this/);
    expect((await run(['tiktok', 'hooks', project, 'short_parry', '--remove', 'zz'])).code).toBe(2);
    expect((await run(['tiktok', 'hooks', project, 'short_parry', '--remove', 'a'])).out).toMatch(/^No hook versions/); // prettier-ignore

    const g = await run(['tiktok', 'generate', project, 'short_parry']);
    expect(g.code).toBe(1); // most slots are still empty: placeholders
    expect(g.out).toMatch(/Cut built \(on the beat\): \d+ items, \d+ placeholders/);
    expect(g.out).toMatch(/tforge draft\|export <dir> --version short_parry/);
    const json = JSON.parse((await run(['tiktok', 'list', project, '--json'])).out) as { shorts: { cut: { built: boolean } }[] }; // prettier-ignore
    expect(json.shorts[0]!.cut.built).toBe(true);
  });

  it('shows what Claude Code would send, and will not run without --yes', async () => {
    const r = await run(['tiktok', 'ask-claude', project]);
    // The sample project's repo is not on this machine, so the preview explains that.
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/game repo .* was not found on this computer/);
  });

  it('says what is wrong with usage errors (exit 2)', async () => {
    expect((await run(['tiktok', 'fill', project, 'short_parry', '--file', 'x'])).code).toBe(2);
    expect((await run(['tiktok', 'new', project])).code).toBe(2);
    expect((await run(['tiktok', 'subtitles', project, 'short_parry', '--on', '--off'])).code).toBe(
      2,
    );
    expect((await run(['tiktok', 'dance', project])).code).toBe(2);
    expect((await run(['tiktok', 'build', project])).code).toBe(2);
    const v = await run(['tiktok', 'voice']);
    expect(v.code).toBe(0);
    expect(v.out).toMatch(/Voice model: absent[\s\S]*tforge tiktok voice --yes/);
  });
});
