import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { detectCapabilities, pickH264Encoder, resolveTools } from './detect.js';
import { classifyFailure, MediaError } from './errors.js';
import { FilterGraph, renderFilter } from './filtergraph.js';
import { measureLoudness } from './loudness.js';
import { ensureFreeSpace } from './disk.js';
import { extractThumbnail, ffmpeg, makeFilmstrip, makeProxy } from './operations.js';
import { probe, toMediaInfo } from './probe.js';
import { runTool } from './process.js';
import {
  coreQualityChecks,
  createQualityContext,
  runQualityGate,
  type QualityCheck,
} from './quality-gate.js';
import { fixtures } from './test-fixtures.js';

let f: ReturnType<typeof fixtures>;
let out: string;

beforeAll(async () => {
  f = fixtures();
  out = await mkdtemp(join(tmpdir(), 'tforge-media-out-'));
}, 60_000);

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof MediaError) return err.code;
    throw err;
  }
  return 'resolved';
};

describe('capabilities', () => {
  it('detects version, encoders and filters, and verifies hardware encoders', async () => {
    const caps = await detectCapabilities();
    expect(caps.version).not.toBe('unknown');
    expect(caps.encoders.has('libx264')).toBe(true);
    expect(caps.filters.has('loudnorm')).toBe(true);
    expect(caps.filters.has('xfade')).toBe(true);
    // Every reported hardware encoder passed a real test encode.
    for (const e of caps.workingHwEncoders) expect(caps.encoders.has(e)).toBe(true);
    expect(pickH264Encoder(caps, false)).toBe('libx264');
  }, 60_000);

  it('reports a missing FFmpeg clearly', async () => {
    const tools = resolveTools({ TFORGE_FFMPEG_DIR: '/nonexistent' });
    expect(await codeOf(probe(f.clip, { tools }))).toBe('ffmpeg-missing');
  });
});

describe('probe', () => {
  it('reads a normal clip', async () => {
    const info = await probe(f.clip);
    expect(info.video[0]).toMatchObject({
      width: 320,
      height: 180,
      frameRate: { num: 30, den: 1 },
      variableFrameRate: false,
      rotation: 0,
      bitDepth: 8,
      hdr: false,
    });
    expect(info.audio[0]).toMatchObject({ sampleRate: 48000, channels: 1 });
    expect(info.duration).toBeGreaterThan(1.9);
    expect(info.sizeBytes).toBeGreaterThan(0);
  });

  it('flags variable frame rate, rotation, 10-bit and missing audio', async () => {
    expect((await probe(f.vfr)).video[0]?.variableFrameRate).toBe(true);
    expect([90, 270]).toContain((await probe(f.rotated)).video[0]?.rotation);
    expect((await probe(f.tenBit)).video[0]?.bitDepth).toBe(10);
    expect((await probe(f.noAudio)).audio).toEqual([]);
  });

  it('classifies missing, truncated and non-media files', async () => {
    expect(await codeOf(probe(join(out, 'nope.mp4')))).toBe('file-not-found');
    expect(await codeOf(probe(f.truncated))).toBe('corrupt-file');
    expect(await codeOf(probe(f.garbage))).toBe('corrupt-file');
  });

  it('detects HDR and skips cover-art streams', () => {
    const info = toMediaInfo(
      {
        format: { format_name: 'mov', duration: '1' },
        streams: [
          {
            index: 0,
            codec_type: 'video',
            codec_name: 'hevc',
            width: 3840,
            height: 2160,
            avg_frame_rate: '60000/1001',
            r_frame_rate: '60000/1001',
            pix_fmt: 'yuv420p10le',
            color_transfer: 'smpte2084',
          },
          {
            index: 1,
            codec_type: 'video',
            codec_name: 'mjpeg',
            width: 600,
            height: 600,
            disposition: { attached_pic: 1 },
          },
        ],
      },
      100,
    );
    expect(info.video).toHaveLength(1);
    expect(info.video[0]).toMatchObject({
      hdr: true,
      bitDepth: 10,
      frameRate: { num: 60000, den: 1001 },
    });
  });
});

describe('errors', () => {
  it('classifies common ffmpeg failures', () => {
    expect(
      classifyFailure('ffmpeg', 'av_interleaved_write_frame(): No space left on device', 1).code,
    ).toBe('out-of-disk');
    expect(classifyFailure('ffmpeg', "Unknown encoder 'foo'", 1).code).toBe('unsupported-codec');
    expect(classifyFailure('ffmpeg', 'something else', 3).code).toBe('process-failed');
    expect(new MediaError('corrupt-file', 'x').retryable).toBe(false);
    expect(new MediaError('out-of-disk', 'x').retryable).toBe(true);
  });

  it('reports an unknown encoder from a real run', async () => {
    const run = ffmpeg(
      ['-f', 'lavfi', '-i', 'color=s=64x64:d=0.1', '-c:v', 'no_such_encoder', join(out, 'x.mp4')],
      0.1,
    );
    expect(await codeOf(run)).toBe('unsupported-codec');
  });

  it('cancels and times out long runs', async () => {
    const long = [
      '-hide_banner',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=1280x720:d=600',
      '-f',
      'null',
      '-',
    ];
    const ac = new AbortController();
    const p = runTool('ffmpeg', long, { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    expect(await codeOf(p)).toBe('cancelled');
    expect(await codeOf(runTool('ffmpeg', long, { timeoutMs: 100 }))).toBe('timeout');
  });

  it('fails fast when disk space is short', async () => {
    expect(await codeOf(ensureFreeSpace(out, Number.MAX_SAFE_INTEGER))).toBe('out-of-disk');
    expect(await codeOf(ensureFreeSpace(out, 1, 0))).toBe('resolved');
  });
});

describe('filtergraph', () => {
  it('renders chains with labels and named or positional args', () => {
    const g = new FilterGraph()
      .chain(
        ['0:v'],
        [
          { name: 'scale', args: { w: 1280, h: -2 } },
          { name: 'format', args: ['yuv420p'] },
        ],
        ['v'],
      )
      .chain(['0:a'], [{ name: 'anull' }], ['a']);
    expect(g.toString()).toBe('[0:v]scale=w=1280:h=-2,format=yuv420p[v];[0:a]anull[a]');
  });

  it('rejects unsafe filter names and pad labels', () => {
    expect(() => renderFilter({ name: 'scale;rm' })).toThrow();
    expect(() => new FilterGraph().chain(['a]b'], [{ name: 'null' }], ['v'])).toThrow();
  });

  it('escapes hostile text so ffmpeg receives it verbatim', async () => {
    const value = "it's: a [test], with; 'quotes' \\ and = signs";
    const file = join(out, 'meta.txt');
    const g = new FilterGraph().chain(
      ['0:v'],
      [
        { name: 'metadata', args: { mode: 'add', key: 'k', value } },
        { name: 'metadata', args: { mode: 'print', key: 'k', file } },
      ],
      ['v'],
    );
    await ffmpeg(
      [
        '-f',
        'lavfi',
        '-i',
        'color=s=32x32:d=0.04:r=25',
        '-filter_complex',
        g.toString(),
        '-map',
        '[v]',
        '-f',
        'null',
        '-',
      ],
      0.04,
    );
    expect(await readFile(file, 'utf8')).toContain(`k=${value}`);
  });
});

describe('operations', () => {
  it('makes a proxy without upscaling and reports progress up to 1', async () => {
    const info = await probe(f.clip);
    const progress: number[] = [];
    const dest = join(out, 'proxy.mp4');
    await makeProxy(f.clip, info, dest, { onProgress: (p) => progress.push(p) });
    const p = await probe(dest);
    expect(p.video[0]?.height).toBe(180);
    expect(p.audio[0]).toMatchObject({ channels: 2, sampleRate: 48000 });
    expect(progress.at(-1)).toBe(1);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it('extracts a thumbnail and a filmstrip', async () => {
    const info = await probe(f.clip);
    const thumb = join(out, 'thumb.jpg');
    const strip = join(out, 'strip.png');
    await extractThumbnail(f.clip, 1, thumb, 160);
    await makeFilmstrip(f.clip, info, strip, 5, 64);
    expect((await probe(thumb)).video[0]?.width).toBe(160);
    expect((await probe(strip)).video[0]?.width).toBe(5 * 64);
  });
});

describe('loudness and quality gate', () => {
  it('measures loudness', async () => {
    const m = await measureLoudness(f.clip);
    expect(m.integratedLufs).toBeLessThan(0);
    expect(m.integratedLufs).toBeGreaterThan(-40);
    expect(m.truePeakDb).toBeLessThan(0);
  });

  const ctxFor = (file: string, targets: Parameters<typeof createQualityContext>[1]) =>
    createQualityContext(file, targets, {
      info: () => probe(file),
      loudness: () => measureLoudness(file),
    });

  it('passes when the file meets its targets', async () => {
    const m = await measureLoudness(f.clip);
    const report = await runQualityGate(
      coreQualityChecks,
      ctxFor(f.clip, {
        loudnessLufs: Math.round(m.integratedLufs),
        loudnessToleranceLu: 1,
        truePeakDb: -1,
        maxDurationSec: 60,
      }),
    );
    expect(report).toEqual({ passed: true, findings: [], crashed: [] });
  });

  it('fails loudness, true peak and duration with actionable findings', async () => {
    const report = await runQualityGate(
      coreQualityChecks,
      ctxFor(f.hot, { loudnessLufs: -30, truePeakDb: -1, maxDurationSec: 1 }),
    );
    expect(report.passed).toBe(false);
    expect(report.findings.map((x) => x.checkId).sort()).toEqual([
      'core/duration',
      'core/loudness',
      'core/true-peak',
    ]);
    expect(report.findings.find((x) => x.checkId === 'core/loudness')?.suggestion).toMatch(
      /Lower the mix/,
    );
  });

  it('warns about missing audio and reports crashed checks instead of skipping them', async () => {
    const crashing: QualityCheck = {
      id: 'test/crash',
      name: 'Crash',
      run: async () => {
        throw new Error('bug');
      },
    };
    const report = await runQualityGate(
      [...coreQualityChecks, crashing],
      ctxFor(f.noAudio, { loudnessLufs: -14, truePeakDb: -1 }),
    );
    expect(report.findings).toEqual([
      expect.objectContaining({ checkId: 'core/loudness', severity: 'warning' }),
    ]);
    expect(report.crashed).toEqual([{ checkId: 'test/crash', error: 'bug' }]);
    expect(report.passed).toBe(false);
  });
});

it('fixtures are generated on demand', () => {
  expect(existsSync(f.clip)).toBe(true);
});
