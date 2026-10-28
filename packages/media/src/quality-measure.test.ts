import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rate } from '@trailerforge/schema';
import {
  checkOutput,
  measureOutput,
  runOutputGate,
  type OutputExpectations,
} from './quality-measure.js';

/** The output checks on generated files: one passing and one failing file per check. */

const dir = mkdtempSync(join(tmpdir(), 'tforge-qc-'));
const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const files: Record<string, string> = {};

function make(name: string, video: string, audio = 'sine=f=440:r=48000:d=2', extra: string[] = []) {
  const out = join(dir, `${name}.mkv`);
  ff([
    '-f',
    'lavfi',
    '-i',
    video,
    '-f',
    'lavfi',
    '-i',
    audio,
    '-c:v',
    'ffv1',
    '-c:a',
    'pcm_s16le',
    ...extra,
    out,
  ]);
  files[name] = out;
}

const grey = (expr: string) =>
  `color=black:s=160x90:r=30:d=2,format=yuv444p,geq=lum='${expr}':cb=128:cr=128`;

beforeAll(() => {
  make('good', 'testsrc2=s=160x90:r=30:d=2');
  make('strobe', grey('if(lt(mod(N,6),3),235,16)'));
  make('slow', grey('if(lt(mod(N,60),30),235,16)'));
  make('red', `color=black:s=160x90:r=30:d=2,format=gbrp,geq=r='if(lt(mod(N,6),3),255,0)':g=0:b=0`);
  make('gap', grey('if(between(N,30,38),16,128)'));
  make('frame', grey('if(eq(N,15),235,100)'));
  make('clip', 'testsrc2=s=160x90:r=30:d=2', "aevalsrc='1.5*sin(2*PI*220*t)':s=48000:d=2");
  make('drift', 'testsrc2=s=160x90:r=30:d=2', 'sine=f=440:r=48000:d=2.5');
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const exp = (over: Partial<OutputExpectations> = {}): OutputExpectations => ({
  width: 160,
  height: 90,
  rate: rate(30),
  frames: 60,
  loudness: null,
  ...over,
});
const ids = (xs: { checkId: string }[]) => [...new Set(xs.map((x) => x.checkId))];

describe('output checks', { timeout: 60_000 }, () => {
  it('a clean file passes, with its own loudness as the target', async () => {
    const facts = await measureOutput(files.good!);
    expect(facts.video).toMatchObject({ width: 160, height: 90, frames: 60 });
    const lufs = facts.loudness!.integratedLufs;
    expect(checkOutput(facts, exp({ loudness: { lufs, truePeakDb: 0 } }))).toEqual([]);
    // ...and fails the loudness and true-peak checks against a far target and a tight ceiling.
    const bad = checkOutput(facts, exp({ loudness: { lufs: lufs + 5, truePeakDb: -20 } }));
    expect(bad.map((x) => [x.checkId, x.tier])).toEqual([
      ['core/loudness', 'override'],
      ['core/true-peak', 'hard'],
    ]);
  });

  it('a strobe blocks hard; a slow blink does not', async () => {
    const strobe = checkOutput(await measureOutput(files.strobe!), exp());
    expect(strobe.find((x) => x.checkId === 'core/flash-risk')).toMatchObject({ tier: 'hard' });
    expect(ids(checkOutput(await measureOutput(files.slow!), exp()))).not.toContain(
      'core/flash-risk',
    );
  });

  it('a red strobe is caught as a red flash', async () => {
    const fs = checkOutput(await measureOutput(files.red!), exp());
    const risk = fs.find((x) => x.checkId === 'core/flash-risk')!;
    expect(risk.message).toMatch(/red flash/);
  });

  it('black inside the picture and a single flash frame need an override', async () => {
    const gap = checkOutput(await measureOutput(files.gap!), exp());
    expect(gap.map((x) => [x.checkId, x.tier, x.at])).toEqual([
      ['core/black-frames', 'override', { start: 1, end: 1.3 }],
    ]);
    const frame = checkOutput(await measureOutput(files.frame!), exp());
    expect(frame.map((x) => [x.checkId, x.at?.start])).toEqual([['core/flash-frames', 0.5]]);
  });

  it('a single bright frame at a planned flash is intended, elsewhere it is not', async () => {
    const facts = await measureOutput(files.frame!);
    expect(ids(checkOutput(facts, exp({ declaredFlashes: [0.55] })))).toEqual([]);
    expect(ids(checkOutput(facts, exp({ declaredFlashes: [1.5] })))).toEqual(['core/flash-frames']);
  });

  it('clipping blocks hard; sound running past the picture needs an override', async () => {
    expect(ids(checkOutput(await measureOutput(files.clip!), exp()))).toEqual(['core/clipping']);
    expect(ids(checkOutput(await measureOutput(files.drift!), exp()))).toEqual(['core/av-sync']);
  });

  it('the wrong size, rate or length blocks hard', async () => {
    const facts = await measureOutput(files.good!);
    const fs = checkOutput(facts, exp({ width: 1920, height: 1080, rate: rate(24), frames: 48 }));
    expect(fs.map((x) => [x.checkId, x.tier])).toEqual([
      ['core/output-format', 'hard'],
      ['core/output-format', 'hard'],
      ['core/output-format', 'hard'],
    ]);
  });

  it('caches the report by content hash; the same file gives the same report', async () => {
    const cacheDir = join(dir, 'qc-cache');
    const a = await runOutputGate(files.strobe!, exp(), { cacheDir });
    expect(readdirSync(cacheDir).filter((x) => x.endsWith('.json'))).toHaveLength(1);
    const b = await runOutputGate(files.strobe!, exp(), { cacheDir });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const fresh = await runOutputGate(files.strobe!, exp());
    expect(JSON.stringify(fresh)).toBe(JSON.stringify(a));
    expect(existsSync(join(cacheDir, 'x'))).toBe(false);
  });
});
