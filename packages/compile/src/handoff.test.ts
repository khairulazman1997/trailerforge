import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Timeline, framesToFlicks, rate, type Rate } from '@trailerforge/schema';
import type { SourceMedia } from './compile.js';
import { fileUrl, timecode, toEdl, toFcpxml, toOtio, type HandoffInput } from './handoff.js';

/** Golden FCPXML, OTIO and EDL for one small cut; the Python sidecar tests read them back. */

const golden = join(dirname(fileURLToPath(import.meta.url)), '__golden__');
const R = rate(24);
const f = (n: number) => framesToFlicks(n, R);

const src = (path: string, extra: Partial<SourceMedia> = {}): SourceMedia => ({
  path,
  contentHash: '0'.repeat(64),
  width: 1920,
  height: 1080,
  frameRate: rate(60),
  duration: 60,
  hasAudio: true,
  ...extra,
});

export function handoffFixture(): HandoffInput {
  const timeline = Timeline.parse({
    id: 'tl_trailer',
    name: 'Trailer',
    frameRate: R,
    resolution: { width: 1920, height: 1080 },
    tracks: [
      {
        id: 'trk_v',
        kind: 'video',
        name: 'Picture',
        items: [
          { id: 'c1', kind: 'clip', start: 0, duration: f(48), assetId: 'forest', sourceIn: f(300), slotId: 'shot_parry' },
          { id: 'c2', kind: 'clip', start: f(48), duration: f(36), assetId: 'boss', sourceIn: f(24), effects: [{ id: 'e1', effectId: 'core/grain', params: { strength: 20 } }] },
          { id: 'p1', kind: 'placeholder', start: f(84), duration: f(24), reason: 'missing-footage', note: 'Ending shot' },
        ],
        transitions: [{ id: 'tr1', transitionId: 'core/crossfade', fromItemId: 'c1', toItemId: 'c2', duration: f(12) }],
      },
      {
        id: 'trk_cards',
        kind: 'graphics',
        name: 'Cards',
        items: [{ id: 'g1', kind: 'graphic', start: f(108), duration: f(48), templateId: 'core/title-card', params: { text: 'Out now' } }],
      },
      { id: 'trk_cap', kind: 'caption', name: 'Captions', items: [{ id: 'cap1', kind: 'caption', start: f(12), duration: f(24), text: 'Parry & strike' }] },
      {
        id: 'trk_m',
        kind: 'audio',
        name: 'Music',
        items: [{ id: 'mu', kind: 'clip', start: 0, duration: f(156), assetId: 'music', sourceIn: 0, gainDb: { keyframes: [{ at: 0, value: 0 }, { at: f(132), value: 0 }, { at: f(156), value: -60 }] } }],
      },
    ],
    markers: [
      { id: 'mk_s1', at: f(48), kind: 'section', label: 'Reveal' },
      { id: 'mk_beat', at: f(12), kind: 'beat' },
    ],
  }); // prettier-ignore
  return {
    timeline,
    name: 'Parry: The Game — Trailer',
    sources: new Map([
      ['forest', src('/media/forest.mp4')],
      ['boss', src('C:\\Users\\Dev\\Boss Fight.mp4')],
      ['music', src('/media/music.wav', { width: 0, height: 0, duration: 120 })],
    ]),
    graphics: new Map([
      ['g1', { path: '/project/exports/handoff/g1.mov', frames: 48 }],
      ['cap1', { path: '/project/exports/handoff/cap1.mov', frames: 24 }],
    ]),
  };
}

function compareGolden(name: string, text: string) {
  const path = join(golden, name);
  if (process.env.UPDATE_GOLDEN || !existsSync(path)) {
    mkdirSync(golden, { recursive: true });
    writeFileSync(path, text);
  }
  expect(text).toBe(readFileSync(path, 'utf8'));
}

describe('NLE handoff', () => {
  it('writes FCPXML 1.10, OTIO and EDL matching the golden files, the same every time', () => {
    const input = handoffFixture();
    compareGolden('handoff.fcpxml', toFcpxml(input));
    compareGolden('handoff.otio', toOtio(input));
    compareGolden('handoff.edl', toEdl(input));
    expect(toFcpxml(handoffFixture())).toBe(toFcpxml(input));
  });

  it('refers to media in place with file URLs', () => {
    expect(fileUrl('/media/a b.mp4')).toBe('file:///media/a%20b.mp4');
    expect(fileUrl('C:\\Users\\Dev\\Boss Fight.mp4')).toBe('file:///C:/Users/Dev/Boss%20Fight.mp4');
    expect(fileUrl('/m/#1?.mov')).toBe('file:///m/%231%3F.mov');
  });

  it('writes exact timecodes at the common rates, drop-frame at 29.97 and 59.94', () => {
    const cases: [Rate, number, string][] = [
      [rate(24000, 1001), 24 * 3600, '01:00:00:00'],
      [rate(24), 24 * 61 + 5, '00:01:01:05'],
      [rate(25), 25 * 60 * 10 + 24, '00:10:00:24'],
      [rate(30), 30 * 59 + 29, '00:00:59:29'],
      [rate(60), 60 * 3600 + 59, '01:00:00:59'],
      [rate(30000, 1001), 1799, '00:00:59;29'],
      [rate(30000, 1001), 1800, '00:01:00;02'],
      [rate(30000, 1001), 17982, '00:10:00;00'],
      [rate(30000, 1001), 107892, '01:00:00;00'],
      [rate(60000, 1001), 3600, '00:01:00;04'],
      [rate(60000, 1001), 35964, '00:10:00;00'],
    ];
    for (const [r, frames, tc] of cases)
      expect(timecode(frames, r), `${r.num}/${r.den} ${frames}`).toBe(tc);
  });
});
