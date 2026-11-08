import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Scene } from '@trailerforge/graphics';
import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EffectCraftError,
  EffectCraftRenderer,
  PROJECT_TEMPLATE_ID,
  SEQUENCE_DONE,
  checkProjectFile,
  chunkCommands,
  EffectCraftCli,
  locateCli,
  parseCliVersion,
  compareVersions,
  compatProblem,
  EFFECTCRAFT_TESTED_VERSION,
  findInstalledCli,
  installedCliCandidates,
  parseCommandIds,
  REQUIRED_COMMANDS,
  resolveCliForApp,
  sceneCommands,
  sweepWorkRoot,
  type CliLocation,
} from './index.js';

const STUB = fileURLToPath(new URL('./__fixtures__/stub-cli.mjs', import.meta.url));
const stub = (mode = 'ok'): CliLocation => ({ bin: process.execPath, prefixArgs: [STUB, mode] });
const rate = { num: 30, den: 1 };
const sec = (s: number) => Math.round(s * FLICKS_PER_SECOND);

function scene(): Scene {
  return {
    size: { width: 320, height: 180 },
    duration: sec(0.5),
    background: '#101820',
    warnings: [],
    layers: [
      {
        id: 'bar',
        kind: 'rect',
        box: { x: 10, y: 150, w: 300, h: 10 },
        fill: '#ff6600',
        radius: 4,
      },
      {
        id: 'title',
        kind: 'text',
        box: { x: 20, y: 40, w: 280, h: 100 },
        font: { family: 'Inter', weight: 700 },
        fill: '#ffffff',
        text: 'EMBER KNIGHT',
        layout: {
          lines: [
            { text: 'EMBER', x: 160, y: 80, width: 120 },
            { text: 'KNIGHT', x: 160, y: 120, width: 130 },
          ],
          size: 36,
          lineHeight: 1.1,
          bounds: { x: 95, y: 50, w: 130, h: 80 },
          align: 'middle',
          shrunk: false,
          truncated: false,
          warnings: [],
        },
        animation: {
          opacity: {
            keyframes: [
              { at: 0, value: 0, easing: 'ease-out' },
              { at: sec(0.2), value: 1, easing: 'linear' },
            ],
          },
          scale: {
            keyframes: [
              { at: 0, value: 0.9, easing: 'ease-in-out' },
              { at: sec(0.3), value: 1, easing: 'hold' },
              { at: sec(0.4), value: 1.05, easing: 'linear' },
            ],
          },
          reveal: 1,
        },
      },
      { id: 'logo', kind: 'image', box: { x: 0, y: 0, w: 10, h: 10 }, href: 'media/x.svg' },
    ],
  };
}

let root: string;
let work: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tf-ec-'));
  work = join(root, 'work');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const leftovers = async () => (existsSync(work) ? await readdir(work) : []);
const sha = async (p: string) =>
  createHash('sha256')
    .update(await readFile(p))
    .digest('hex');
const ac = () => new AbortController().signal;

describe('compatibility', () => {
  it('reads the CLI banner and the command list, and compares versions', () => {
    expect(parseCliVersion('effectcraft-cli 0.22.0\n')).toBe('0.22.0');
    expect(parseCliVersion('something else')).toBeNull();
    expect(parseCommandIds('[{"id":"comp.new"},{"id":"prop.set","enabled":false},{}]')).toEqual(
      new Set(['comp.new', 'prop.set']),
    );
    expect(parseCommandIds('not json')).toBeNull();
    expect(compareVersions('0.22.0', '0.9.2')).toBeGreaterThan(0);
    expect(compareVersions('0.9.2', '0.9.2')).toBe(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(0);
  });

  it('accepts any recent build that has every command, and says which are missing', () => {
    const all = new Set(REQUIRED_COMMANDS);
    expect(compatProblem('0.22.0', all)).toBeNull();
    expect(compatProblem('3.1.0', all)).toBeNull();
    expect(compatProblem('0.8.0', all)).toMatch(/older than 0\.9\.2/);
    expect(compatProblem(null, all)).toMatch(/did not report/);
    expect(compatProblem('0.22.0', null)).toMatch(/did not list its commands/);
    const less = new Set([...all].filter((c) => c !== 'keys.toggleHold' && c !== 'effect.apply'));
    expect(compatProblem('0.30.0', less)).toBe(
      'EffectCraft 0.30.0 lacks commands this app uses: keys.toggleHold, effect.apply',
    );
  });

  it('the engine finds the CLI only through TFORGE_EFFECTCRAFT', () => {
    expect(locateCli({})).toBeNull();
    expect(locateCli({ TFORGE_EFFECTCRAFT: ' /opt/ec/effectcraft-cli ' })).toEqual({
      bin: '/opt/ec/effectcraft-cli',
    });
  });

  it('the app finds the installed copy; the variable wins, and empty switches it off', () => {
    const env = { ProgramFiles: 'C:\\Program Files', PATH: 'C:\\bin;C:\\tools' };
    const exe = join('C:\\Program Files', 'EffectCraft', 'effectcraft-cli.exe');
    expect(installedCliCandidates(env, 'win32')).toEqual([
      exe,
      join('C:\\bin', 'effectcraft-cli.exe'),
      join('C:\\tools', 'effectcraft-cli.exe'),
    ]);
    expect(findInstalledCli(env, 'win32', (p) => p === exe)).toBe(exe);
    expect(findInstalledCli(env, 'win32', () => false)).toBeNull();
    expect(resolveCliForApp(env, 'win32', (p) => p === exe)).toBe(exe);
    expect(resolveCliForApp({ ...env, TFORGE_EFFECTCRAFT: '/dev/ec' }, 'win32', () => true)).toBe('/dev/ec'); // prettier-ignore
    expect(resolveCliForApp({ ...env, TFORGE_EFFECTCRAFT: '' }, 'win32', () => true)).toBe('');
    expect(resolveCliForApp(env, 'win32', () => false)).toBeUndefined();
    expect(installedCliCandidates({}, 'darwin')[0]).toBe(
      '/Applications/EffectCraft.app/Contents/MacOS/effectcraft-cli',
    );
  });

  it('available(): ready, untested, too old, lacking a command, missing, not installed', async () => {
    expect(await new EffectCraftRenderer({ cli: stub(), workRoot: work }).available()).toEqual({
      ok: true,
      version: EFFECTCRAFT_TESTED_VERSION,
    });
    const newer = await new EffectCraftRenderer({ cli: stub('newer'), workRoot: work }).available();
    expect(newer).toEqual({ ok: true, version: '0.30.0', note: expect.stringMatching(/tested with 0\.22\.0/) }); // prettier-ignore
    const old = await new EffectCraftRenderer({ cli: stub('old'), workRoot: work }).available();
    expect(old).toEqual({ ok: false, kind: 'incompatible', version: '0.8.0', reason: expect.stringMatching(/older than/) }); // prettier-ignore
    const lacking = await new EffectCraftRenderer({ cli: stub('lacking'), workRoot: work }).available(); // prettier-ignore
    expect(lacking).toMatchObject({ ok: false, kind: 'incompatible', reason: /lacks commands this app uses: keys\.toggleHold$/ }); // prettier-ignore
    const gone = new EffectCraftRenderer({ cli: { bin: join(root, 'nope') }, workRoot: work });
    expect(await gone.available()).toMatchObject({ ok: false, kind: 'missing', reason: /missing at/ }); // prettier-ignore
    const none = new EffectCraftRenderer({ cli: null, workRoot: work });
    expect(await none.available()).toMatchObject({ ok: false, kind: 'not-installed' });
    expect(await leftovers()).toEqual([]);
  });

  it('refuses to render with an incompatible build', async () => {
    const r = new EffectCraftRenderer({ cli: stub('old'), workRoot: work });
    await expect(r.renderScene(scene(), rate, join(root, 'out'), ac())).rejects.toMatchObject({
      code: 'version',
    });
    expect(existsSync(join(root, 'out'))).toBe(false);
  });
});

describe('sceneCommands', () => {
  it('builds the scene as a composition through commands', () => {
    const { commands, warnings, compName } = sceneCommands(scene(), rate);
    expect(compName).toBe('TrailerForge');
    expect(commands[0]).toEqual({
      command: 'comp.new',
      params: { name: 'TrailerForge', width: 320, height: 180, frameRate: 30, duration: 0.5 },
    });
    expect(commands[1]).toMatchObject({
      command: 'layer.newSolid',
      params: { name: 'tf_background', color: '#101820', width: 320, height: 180 },
    });
    expect(commands).toContainEqual({
      command: 'prop.set',
      params: { layer: 'tf_bar', path: 'transform/position', value: [160, 155] },
    });
    const text = commands.find((c) => c.command === 'layer.newText')!;
    expect(text.params).toMatchObject({
      name: 'tf_title',
      text: 'EMBER\nKNIGHT',
      position: [160, 80],
      font: 'Inter',
      style: 'Bold',
      size: 36,
      justify: 'center',
      leading: 40,
    });
    // Anchor at the box centre (160, 90) in layer space, whose origin is (160, 80).
    expect(commands).toContainEqual({
      command: 'prop.set',
      params: { layer: 'tf_title', path: 'transform/anchor', value: [0, 10] },
    });
    expect(commands).toContainEqual({
      command: 'prop.addKey',
      params: { layer: 'tf_title', path: 'transform/opacity', time: 0.2, value: 100 },
    });
    expect(commands).toContainEqual({
      command: 'prop.addKey',
      params: { layer: 'tf_title', path: 'transform/scale', time: 0, value: [90, 90] },
    });
    // ease-out on the first opacity key slows the end: the second key's in side.
    const eases = commands
      .map((c, i) => [c, commands[i + 1]] as const)
      .filter(([c]) => c.command === 'keys.select')
      .map(([c, next]) => {
        const k = (c.params.keys as { path: string; time: number }[])[0]!;
        return [k.path, k.time, next!.command, next!.params.which ?? null];
      });
    expect(eases).toEqual([
      ['transform/opacity', 0.2, 'keys.easyEase', 'in'],
      ['transform/scale', 0, 'keys.easyEase', 'out'],
      ['transform/scale', 0.3, 'keys.easyEase', 'in'],
    ]);
    expect(commands).toContainEqual({ command: 'keys.toggleHold', params: {} });
    expect(warnings).toEqual([
      'rect layer bar: rounded corners are not drawn',
      'layer title: the reveal animation is not drawn by the EffectCraft version',
      'image layer logo is not drawn by the EffectCraft version',
    ]);
    expect(JSON.stringify(sceneCommands(scene(), rate))).toBe(
      JSON.stringify(sceneCommands(scene(), rate)),
    );
  });

  it('splits long command lists under the command-line budget, in order', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      command: 'prop.set',
      params: { layer: `tf_${i}`, path: 'transform/opacity', value: i },
    }));
    const chunks = chunkCommands(many, 600);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.join('').length).toBeLessThan(600);
    expect(chunks.flat().filter((_, i) => i % 2 === 0)).toEqual(many.map((c) => c.command));
    expect(chunks.flat()[1]).toBe(JSON.stringify(many[0]!.params));
  });
});

describe('EffectCraftRenderer on the stub CLI', () => {
  it('authors a project, renders transparent PNG frames, leaves nothing behind', async () => {
    const r = new EffectCraftRenderer({ cli: stub(), workRoot: work });
    const out = join(root, 'frames', 'title');
    const res = await r.renderScene(scene(), rate, out, ac());
    expect(res).toMatchObject({ dir: out, pattern: 'frame_%06d.png', frames: 15 });
    expect(res.project).toMatchObject({
      path: `${out}.ecproj`,
      header: { savedBy: '0.22.0', schema: 2 },
    });
    expect(res.project.sha256).toBe(await sha(`${out}.ecproj`));
    expect(res.warnings).toHaveLength(3);
    const files = (await readdir(out)).sort();
    expect(files).toHaveLength(16);
    expect(files[0]).toBe('SEQUENCE_DONE');
    expect(files[1]).toBe('frame_000000.png');
    expect(files).toContain('frame_000014.png');
    expect(files).toContain(SEQUENCE_DONE);
    expect(files.some((f) => /RenderLog/.test(f))).toBe(false);
    expect(await readFile(join(out, SEQUENCE_DONE), 'utf8')).toBe('15\n');
    expect(await leftovers()).toEqual([]);

    // Same scene, same frames; rendering again replaces the folder.
    const first = await sha(join(out, 'frame_000007.png'));
    await r.renderScene(scene(), rate, out, ac());
    expect(await sha(join(out, 'frame_000007.png'))).toBe(first);
    expect(await readdir(out)).toHaveLength(16);
  });

  it('renders a template with the slot text as values', async () => {
    const tpl = join(root, 'title.ectemplate');
    await writeFile(
      tpl,
      JSON.stringify({
        savedBy: '0.9.2',
        schema: 2,
        controls: ['text', 'subtitle'],
        comps: [{ name: 'T', width: 64, height: 36, frameRate: 30, duration: 2 }],
      }),
    );
    const r = new EffectCraftRenderer({
      cli: stub(),
      workRoot: work,
      templates: { 'effectcraft/title-reveal': tpl },
    });
    expect(r.supports('effectcraft/title-reveal')).toBe(true);
    expect(r.supports(PROJECT_TEMPLATE_ID)).toBe(true);
    expect(r.supports('core/title-card')).toBe(false);
    const job = {
      templateId: 'effectcraft/title-reveal',
      params: { text: 'NIGHTFALL' },
      duration: sec(1),
      resolution: { width: 64, height: 36 },
      frameRate: { num: 24, den: 1 },
      outDir: join(root, 'tpl'),
    };
    expect((await r.render(job, ac())).frames).toBe(24);
    const a = await sha(join(root, 'tpl', 'frame_000003.png'));
    await r.render({ ...job, params: { text: 'DAYBREAK' } }, ac());
    expect(await sha(join(root, 'tpl', 'frame_000003.png'))).not.toBe(a);
    await expect(r.render({ ...job, params: { bogus: 1 } }, ac())).rejects.toThrow(
      /unknown control bogus; valid: text, subtitle/,
    );
    await expect(
      r.render({ ...job, duration: sec(3), outDir: join(root, 'long') }, ac()),
    ).rejects.toMatchObject({ code: 'bad-output', message: /rendered 48 frames, 72/ });
    expect(existsSync(join(root, 'long'))).toBe(false);
    expect(await leftovers()).toEqual([]);
  });

  it('cancel kills the process and leaves no temp files or partial output', async () => {
    const r = new EffectCraftRenderer({ cli: stub('slow'), workRoot: work });
    const c = new AbortController();
    const out = join(root, 'cancelled');
    const p = r.renderScene(scene(), rate, out, c.signal);
    // Let the authoring finish and the render get a few frames in.
    setTimeout(() => c.abort(), 1200);
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.ecproj`)).toBe(false);
    expect(await leftovers()).toEqual([]);
  });

  it('refuses output that is not what was asked for', async () => {
    for (const [mode, msg] of [
      ['wrong-size', /rendered 322×180, 320×180/],
      ['no-alpha', /no alpha channel/],
      ['fail-render', /render: Title: renderer crashed/],
    ] as const) {
      const r = new EffectCraftRenderer({ cli: stub(mode), workRoot: work });
      const out = join(root, mode);
      await expect(r.renderScene(scene(), rate, out, ac())).rejects.toThrow(msg);
      expect(existsSync(out)).toBe(false);
    }
    expect(await leftovers()).toEqual([]);
  });

  it('an unknown command stops authoring and saves nothing', async () => {
    const r = new EffectCraftRenderer({ cli: stub(), workRoot: work });
    const dest = join(root, 'x.ecproj');
    await expect(
      r.authorProject(
        [
          { command: 'comp.new', params: { name: 'A' } },
          { command: 'layer.explode', params: {} },
        ],
        dest,
        ac(),
      ),
    ).rejects.toThrow(/run: layer\.explode: unknown command/);
    expect(existsSync(dest)).toBe(false);
    expect(await leftovers()).toEqual([]);
  });

  it('runs EffectCraft with an isolated environment', async () => {
    const dump = join(root, 'env.json');
    process.env.TFORGE_TEST_SECRET = 'do-not-pass';
    try {
      const r = new EffectCraftRenderer({ cli: stub(`env:${dump}`), workRoot: work });
      expect(await r.available()).toMatchObject({ ok: true });
    } finally {
      delete process.env.TFORGE_TEST_SECRET;
    }
    const env = JSON.parse(await readFile(dump, 'utf8')) as Record<string, string>;
    expect(env.TFORGE_TEST_SECRET).toBeUndefined();
    expect(env.EFFECTCRAFT_CONFIG_DIR!.startsWith(join(work, 'ec-'))).toBe(true);
    expect(env.HOME!.startsWith(join(work, 'ec-'))).toBe(true);
    expect(env.TMPDIR!.startsWith(join(work, 'ec-'))).toBe(true);
  });
});

describe('project files', () => {
  it('accepts any EffectCraft project the installed copy opens; newer files warn', async () => {
    const cli = new EffectCraftCli(stub());
    const cwd = join(root, 'cwd');
    await mkdir(cwd, { recursive: true });
    const f = join(root, 'p.ecproj');
    const running = { cwd, runningVersion: '0.22.0' };
    await writeFile(f, JSON.stringify({ savedBy: '0.22.0', schema: 2, comps: [] }));
    expect(await checkProjectFile(cli, f, running)).toMatchObject({ warnings: [] });
    await writeFile(f, JSON.stringify({ savedBy: '0.9.1', schema: 2, comps: [] }));
    expect((await checkProjectFile(cli, f, running)).warnings).toEqual([]);
    await writeFile(f, JSON.stringify({ savedBy: '0.30.0', schema: 2, comps: [] }));
    expect((await checkProjectFile(cli, f, running)).warnings).toEqual([
      'saved by EffectCraft 0.30.0, newer than the installed 0.22.0',
    ]);
    await writeFile(f, JSON.stringify({ savedBy: '1.0.0', comps: [] }));
    await expect(checkProjectFile(cli, f, { cwd })).rejects.toThrow(/no `schema` field/);
    // The installed copy is the judge: one that cannot open the file refuses it.
    await writeFile(f, JSON.stringify({ savedBy: '1.0.0', schema: 3, comps: [] }));
    await expect(checkProjectFile(cli, f, { cwd })).rejects.toMatchObject({ code: 'bad-project' });
    await writeFile(f, '{ nope');
    await expect(checkProjectFile(cli, f, { cwd })).rejects.toThrow(/not JSON/);
    await writeFile(f, JSON.stringify({ savedBy: '0.22.0', schema: 2, bogus: 1 }));
    await expect(checkProjectFile(cli, f, { cwd })).rejects.toMatchObject({
      code: 'bad-project',
      message: /cannot open it: .*missing field settings/,
    });
  });

  it('sweeps run folders of dead processes only', async () => {
    await mkdir(join(work, 'ec-999999999-dead'), { recursive: true });
    await mkdir(join(work, `ec-${process.pid}-mine`), { recursive: true });
    await mkdir(join(work, 'other'), { recursive: true });
    await sweepWorkRoot(work);
    expect((await readdir(work)).sort()).toEqual([`ec-${process.pid}-mine`, 'other']);
  });

  it('EffectCraftError carries a code', () => {
    expect(new EffectCraftError('missing', 'x')).toMatchObject({ code: 'missing' });
  });
});

// The real CLI, when one is named (`TFORGE_EFFECTCRAFT=…/effectcraft-cli`).
const real = locateCli();
describe.skipIf(!real)('EffectCraftRenderer on the real effectcraft-cli', () => {
  it('renders a scene to transparent PNG frames, identical twice', async () => {
    const r = new EffectCraftRenderer({ cli: real, workRoot: work });
    expect(await r.available()).toMatchObject({ ok: true, version: expect.any(String) });
    const a = await r.renderScene(scene(), rate, join(root, 'a'), ac());
    const b = await r.renderScene(scene(), rate, join(root, 'b'), ac());
    expect([a.frames, b.frames]).toEqual([15, 15]);
    for (const k of [0, 7, 14]) {
      const name = `frame_${String(k).padStart(6, '0')}.png`;
      expect(await sha(join(root, 'a', name))).toBe(await sha(join(root, 'b', name)));
    }
    expect(await leftovers()).toEqual([]);
  }, 120_000);
});
