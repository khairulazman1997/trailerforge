import type { MediaInfo } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { mediaWarnings } from './warnings.js';

const video = (o: Record<string, unknown> = {}) => ({
  index: 0,
  codec: 'h264',
  width: 1920,
  height: 1080,
  frameRate: { num: 60, den: 1 },
  variableFrameRate: false,
  colorRange: 'tv' as const,
  rotation: 0 as const,
  hdr: false,
  ...o,
});
const audio = { index: 1, codec: 'aac', sampleRate: 48000, channels: 2 };
const info = (o: Partial<MediaInfo> = {}): MediaInfo => ({
  container: 'mov,mp4',
  duration: 10,
  sizeBytes: 1000,
  video: [video()],
  audio: [audio],
  probedAt: '2026-10-24T10:00:00.000Z',
  ...o,
});
const codes = (i: MediaInfo) => mediaWarnings(i).map((w) => w.code);

describe('mediaWarnings', () => {
  it('says nothing about an ordinary recording', () => {
    expect(mediaWarnings(info())).toEqual([]);
  });
  it.each([
    ['variable-frame-rate', info({ video: [video({ variableFrameRate: true })] }), 'warn'],
    ['hdr', info({ video: [video({ hdr: true })] }), 'warn'],
    ['low-resolution', info({ video: [video({ width: 640, height: 360 })] }), 'warn'],
    ['very-short', info({ duration: 0.2 }), 'warn'],
    ['no-audio', info({ audio: [] }), 'info'],
    ['multiple-audio-tracks', info({ audio: [audio, { ...audio, index: 2 }] }), 'info'],
    ['rotated', info({ video: [video({ rotation: 90 })] }), 'info'],
    ['high-bit-depth', info({ video: [video({ bitDepth: 10 })] }), 'info'],
  ] as const)('flags %s', (code, i, severity) => {
    expect(mediaWarnings(i)).toEqual([expect.objectContaining({ code, severity })]);
  });
  it('treats a file with sound only as audio-only and nothing else', () => {
    expect(codes(info({ video: [] }))).toEqual(['audio-only']);
    expect(codes(info({ video: [], audio: [] }))).toEqual([]);
  });
});
