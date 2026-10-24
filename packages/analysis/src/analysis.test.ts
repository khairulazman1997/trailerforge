import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobQueue, type JobRecord } from '@trailerforge/jobs';
import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analyzeFootage,
  analyzeMusic,
  footageCacheFile,
  musicCacheFile,
  readMusicAnalysis,
} from './analyze.js';
import { FOOTAGE_JOB, MUSIC_JOB, registerAnalysisJobs } from './jobs.js';
import { SidecarError, callSidecar } from './sidecar.js';

const F = FLICKS_PER_SECOND;
const H = 'c'.repeat(64);
let dir: string;
const queues: JobQueue[] = [];
const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tforge-analysis-'));
});
afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close()));
});

/** 120 bpm: a 10 ms 2 kHz click every half second, first at 0.25 s. */
function clicks(seconds = 8) {
  const out = join(dir, 'clicks.wav');
  ff([
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='if(lt(mod(t-0.25\\,0.5)\\,0.01)*gte(t\\,0.25)\\,sin(2*PI*2000*t)\\,0)':s=44100:d=${seconds}`,
    out,
  ]);
  return out;
}
/** 1 s pattern, 0.5 s black, 1 s another pattern, at 30 fps. */
function shots() {
  const out = join(dir, 'shots.mp4');
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=320x180:r=30:d=1',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=320x180:r=30:d=0.5',
    '-f',
    'lavfi',
    '-i',
    'mandelbrot=s=320x180:r=30',
    '-filter_complex',
    '[2:v]trim=duration=1,setpts=PTS-STARTPTS[m];[0:v][1:v][m]concat=n=3:v=1[v]',
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    out,
  ]);
  return out;
}

function makeQueue() {
  const q = new JobQueue({
    dbPath: join(dir, 'jobs.sqlite'),
    tempRoot: join(dir, 'tmp'),
    progressThrottleMs: 0,
  });
  registerAnalysisJobs(q);
  q.start();
  queues.push(q);
  return q;
}
async function settle(q: JobQueue, id: string): Promise<JobRecord> {
  for (let i = 0; i < 2400; i++) {
    const j = q.get(id)!;
    if (!['queued', 'running'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job did not finish');
}

describe('analysis through the sidecar', () => {
  it('music: tempo, beats on the clicks in flicks, progress reported', async () => {
    const seen: number[] = [];
    const m = await analyzeMusic(clicks(), { onProgress: (f) => seen.push(f) });
    expect(Math.abs(m.tempo - 120)).toBeLessThan(1);
    const frame = F / 30;
    for (let i = 1; i < 14; i++) {
      const truth = (0.25 + 0.5 * i) * F;
      expect(Math.min(...m.beats.map((b) => Math.abs(b - truth)))).toBeLessThanOrEqual(frame);
    }
    expect(m.beats.every(Number.isInteger)).toBe(true);
    expect(m.downbeats.every((d) => m.beats.includes(d))).toBe(true);
    expect(seen.at(-1)).toBe(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  }, 120_000);

  it('footage: black stretch and the shot changes around it, in flicks', async () => {
    const r = await analyzeFootage(shots(), { rate: { num: 30, den: 1 }, duration: 2.5 });
    const frame = F / 30;
    expect(r.frameCount).toBe(75);
    expect(r.black).toHaveLength(1);
    expect(Math.abs(r.black[0]!.start - 1 * F)).toBeLessThanOrEqual(frame);
    expect(Math.abs(r.black[0]!.end - 1.5 * F)).toBeLessThanOrEqual(frame);
    for (const cut of [1, 1.5])
      expect(r.scenes.some((s) => Math.abs(s - cut * F) <= frame)).toBe(true);
  }, 120_000);

  it('reports sidecar failures with codes', async () => {
    const bad = join(dir, 'bad.mp4');
    await writeFile(bad, 'not media');
    await expect(analyzeMusic(bad)).rejects.toMatchObject({ code: 'decode-failed' });
    await expect(callSidecar('nope', {})).rejects.toBeInstanceOf(SidecarError);
    await expect(
      callSidecar('ping', {}, { command: { command: 'tforge-no-such-binary', args: [] } }),
    ).rejects.toMatchObject({ code: 'sidecar-missing' });
    expect(await callSidecar('ping', {})).toEqual({ pong: true });
  }, 120_000);
});

describe('analysis jobs', () => {
  it('cache the result by hash and analyzer version, and reuse it', async () => {
    const q = makeQueue();
    const input = { path: clicks(), quickHash: H, analysisDir: join(dir, 'cache', 'analysis') };
    const first = await settle(q, q.enqueue(MUSIC_JOB, input));
    expect(first).toMatchObject({ status: 'succeeded', output: { cached: false } });
    expect((first.output as { cacheFile: string }).cacheFile).toBe(
      musicCacheFile(input.analysisDir, H),
    );
    expect((await readMusicAnalysis(input.analysisDir, H))?.analyzer).toBe('music');
    const second = await settle(q, q.enqueue(MUSIC_JOB, input));
    expect(second).toMatchObject({ status: 'succeeded', output: { cached: true } });
  }, 120_000);

  it('fail for good on files that cannot be analysed', async () => {
    const q = makeQueue();
    const bad = join(dir, 'bad.wav');
    await writeFile(bad, 'nope');
    const job = await settle(
      q,
      q.enqueue(MUSIC_JOB, { path: bad, quickHash: H, analysisDir: dir }),
    );
    expect(job).toMatchObject({ status: 'failed', attempts: 1, error: { code: 'decode-failed' } });
  }, 120_000);

  it('cancelling leaves no cache file behind', async () => {
    const q = makeQueue();
    const long = join(dir, 'long.mp4');
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=640x360:r=60:d=120',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      long,
    ]);
    const analysisDir = join(dir, 'cache', 'analysis');
    const id = q.enqueue(FOOTAGE_JOB, { path: long, quickHash: H, analysisDir });
    for (let i = 0; i < 400 && (q.get(id)?.progress ?? 0) === 0; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(await q.cancel(id)).toBe(true);
    expect(q.get(id)?.status).toBe('cancelled');
    expect(existsSync(footageCacheFile(analysisDir, H))).toBe(false);
  }, 120_000);
});

describe('crash recovery', () => {
  it('a killed app stops its sidecar; the analysis resumes on restart and leaves no partial cache', async () => {
    const { spawn } = await import('node:child_process');
    const { createRequire } = await import('node:module');
    const { dirname } = await import('node:path');
    const { fileURLToPath, pathToFileURL } = await import('node:url');
    const long = join(dir, 'crash.mp4');
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=640x360:r=60:d=90',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      long,
    ]);
    const analysisDir = join(dir, 'cache', 'analysis');
    const here = dirname(fileURLToPath(import.meta.url));
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', tsx, join(here, 'crash-child.ts'), dir, long, analysisDir],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let err = '';
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      child.stdout.on('data', (d: Buffer) => {
        if (d.toString().includes('progress')) child.kill('SIGKILL');
      });
      child.on('exit', (_c, signal) => (signal === 'SIGKILL' ? resolve() : reject(new Error(err))));
    });
    expect(existsSync(footageCacheFile(analysisDir, 'd'.repeat(64)))).toBe(false);

    // The orphaned sidecar notices within a couple of seconds and stops decoding.
    const commandLines = () =>
      process.platform === 'win32'
        ? execFileSync('powershell', [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }',
          ]).toString()
        : execFileSync('ps', ['-eo', 'args']).toString();
    const running = () =>
      commandLines()
        .split('\n')
        .filter((l) => l.includes('crash.mp4') && !l.includes('ps -eo')).length;
    for (let i = 0; i < 100 && running() > 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(running()).toBe(0);

    const q = new JobQueue({
      dbPath: join(dir, 'jobs.sqlite'),
      tempRoot: join(dir, 'tmp'),
      progressThrottleMs: 0,
    });
    queues.push(q);
    const [orphan] = q.list();
    expect(orphan?.status).toBe('running');
    registerAnalysisJobs(q);
    q.start();
    const job = await settle(q, orphan!.id);
    expect(job).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(existsSync(footageCacheFile(analysisDir, 'd'.repeat(64)))).toBe(true);
  }, 240_000);
});

describe('a sidecar that exits at once', () => {
  it('fails the call cleanly instead of throwing an unhandled write error', async () => {
    const quick = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
    for (let i = 0; i < 5; i++) {
      await expect(
        callSidecar('ping', { pad: 'x'.repeat(200_000) }, { command: quick }),
      ).rejects.toMatchObject({ code: 'crashed' });
    }
  });
});
