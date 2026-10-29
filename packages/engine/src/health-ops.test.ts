import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from './engine.js';
import { REQUIRED_ENCODERS, REQUIRED_FILTERS, healthOp, missingTools, requireRenderTools, setupSidecarOp } from './health-ops.js'; // prettier-ignore
import { renderDraftOp } from './render-ops.js';

/** Setup checks and the render preflight, against a fake FFmpeg that lacks one filter. */

const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? createMockProvider({}) : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});
const posix = process.platform !== 'win32';
let root: string;
let engine: Engine;
let full: Engine;
const savedCmd = process.env.TFORGE_ANALYSIS_CMD;

/** A script that answers the three FFmpeg questions the checks ask. */
async function fakeFfmpeg(dir: string, without: string[]): Promise<string> {
  const filters = REQUIRED_FILTERS.filter((f) => !without.includes(f));
  const file = join(dir, `ffmpeg-${without.join('-') || 'full'}`);
  await writeFile(
    file,
    `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a.includes('-version')) console.log('ffmpeg version 6.1.1-fake Copyright --enable-gpl');
else if (a.includes('-encoders')) console.log(${JSON.stringify(REQUIRED_ENCODERS.map((e) => ` V....D ${e}           fake`).join('\n'))});
else if (a.includes('-filters')) console.log(${JSON.stringify(filters.map((f) => ` ... ${f}           V->V  fake`).join('\n'))});
`,
  );
  await chmod(file, 0o755);
  return file;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-health-'));
  if (!posix) return;
  const sidecar = join(root, 'sidecar.mjs');
  await writeFile(
    sidecar,
    `process.stdin.on('data', (d) => { const m = JSON.parse(String(d).split('\\n')[0]); console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { pong: true } })); });`,
  );
  process.env.TFORGE_ANALYSIS_CMD = JSON.stringify([process.execPath, sidecar]);
  const base = { autosaveMs: 0, loadUserPlugins: false, llm };
  engine = await Engine.start({ ...base, home: join(root, 'home1'), ffmpegTools: { ffmpeg: await fakeFfmpeg(root, ['xfade']), ffprobe: 'ffprobe' } }); // prettier-ignore
  full = await Engine.start({ ...base, home: join(root, 'home2'), ffmpegTools: { ffmpeg: await fakeFfmpeg(root, []), ffprobe: 'ffprobe' } }); // prettier-ignore
});
afterAll(async () => {
  if (savedCmd === undefined) delete process.env.TFORGE_ANALYSIS_CMD;
  else process.env.TFORGE_ANALYSIS_CMD = savedCmd;
  await engine?.close();
  await full?.close();
});

describe.skipIf(!posix)('health and the render preflight', () => {
  it('names the missing filter and says what to do; the rest of the checks still run', async () => {
    const r = await healthOp(engine);
    expect(r.ready).toBe(false);
    const ff = r.checks.find((c) => c.id === 'ffmpeg')!;
    expect(ff).toMatchObject({ status: 'fail' });
    expect(ff.detail).toMatch(/lacks the filter "xfade"/);
    expect(ff.fix).toMatch(/full FFmpeg build/);
    expect(r.checks.find((c) => c.id === 'analysis')).toMatchObject({ status: 'ok' });
    expect(r.checks.find((c) => c.id === 'disk')!.status).toMatch(/ok|warn/);
    expect(r.checks.find((c) => c.id === 'ai')!.status).toBe('info'); // mock only
    expect(r.checks.find((c) => c.id === 'hardware')!.detail).toMatch(/None found/);
    expect(r.checks.map((c) => c.id)).toEqual(['ffmpeg', 'analysis', 'disk', 'ai', 'vision', 'ffmpeg-text', 'hardware', 'system']); // prettier-ignore
    expect(r.sidecarSetup.approxMegabytes).toBeGreaterThan(100);
  });

  it('is ready when FFmpeg has everything', async () => {
    const r = await healthOp(full);
    expect(r.checks.find((c) => c.id === 'ffmpeg')).toMatchObject({ status: 'ok' });
    expect(r.ready).toBe(true);
  });

  it('refuses a render before it starts, naming the filter or encoder', async () => {
    await expect(requireRenderTools(engine, ['libx264'])).rejects.toMatchObject({ code: 'missing-tool', details: { filters: ['xfade'] } }); // prettier-ignore
    await expect(requireRenderTools(engine, ['libx264'])).rejects.toThrow(
      /does not have the filter "xfade"/,
    );
    await expect(requireRenderTools(full, ['libx264', 'aac'])).resolves.toBeUndefined();
    await expect(requireRenderTools(full, ['libx265'])).rejects.toThrow(/the encoder "libx265"/);
    const store = await engine.createProject(join(root, 'P.tforge'), sampleProject() as never);
    await expect(renderDraftOp(engine, store, null)).rejects.toMatchObject({
      code: 'missing-tool',
    });
  });

  it('reports a missing FFmpeg with how to install it', async () => {
    const e = await Engine.start({ autosaveMs: 0, loadUserPlugins: false, llm, home: join(root, 'home3'), ffmpegTools: { ffmpeg: join(root, 'nope'), ffprobe: 'x' } }); // prettier-ignore
    try {
      const r = await healthOp(e);
      expect(r.checks[0]).toMatchObject({ id: 'ffmpeg', status: 'fail' });
      expect(r.checks[0]!.detail).toMatch(/could not be started/);
      expect(r.checks[0]!.fix).toMatch(/Install FFmpeg|TFORGE_FFMPEG_DIR/);
      await expect(requireRenderTools(e)).rejects.toMatchObject({ code: 'missing-tool' });
    } finally {
      await e.close();
    }
  });

  it('creating the analysis environment needs consent', async () => {
    await expect(setupSidecarOp(engine, { consent: false })).rejects.toMatchObject({
      code: 'usage',
    });
  });

  it('knows what is missing', () => {
    expect(missingTools({ filters: new Set(['scale']), encoders: new Set() }, { filters: ['scale', 'xfade'], encoders: ['aac'] })).toEqual({ filters: ['xfade'], encoders: ['aac'] }); // prettier-ignore
  });
});
