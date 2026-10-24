import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { summarizeFootage, toFootageAnalysis, toMusicAnalysis } from './convert.js';
import { FootageAnalysis, MusicAnalysis, type FootageRaw, type MusicRaw } from './schemas.js';

const F = FLICKS_PER_SECOND;
const music: MusicRaw = {
  sampleRate: 22050,
  duration: 10,
  tempo: 120,
  beats: [1.0, 0.5, 1.0, 1.5000000001, 10.2],
  downbeats: [0.5],
  beatsPerBar: 4,
  onsets: [0.49],
  energy: { hop: 0.1, values: [0, 50, 100] },
  sections: [
    { start: 0, end: 4, energy: 20 },
    { start: 4, end: 4, energy: 30 },
    { start: 4, end: 12, energy: 90 },
  ],
};

describe('toMusicAnalysis', () => {
  it('converts seconds to integer flicks once, sorted, unique and inside the track', () => {
    const m = MusicAnalysis.parse(toMusicAnalysis(music));
    expect(m.beats).toEqual([0.5 * F, 1 * F, 1.5 * F, 10 * F]); // 1.5000000001 rounds to 1.5 s
    expect(m.duration).toBe(10 * F);
    expect(m.energy.hop).toBe(0.1 * F);
    expect(m.sections).toEqual([
      { start: 0, end: 4 * F, energy: 20 },
      { start: 4 * F, end: 10 * F, energy: 90 },
    ]);
    expect(m.beats.every(Number.isInteger)).toBe(true);
  });
});

describe('toFootageAnalysis', () => {
  it('maps frames to flicks at the analysis rate, including NTSC rates exactly', () => {
    const raw: FootageRaw = {
      rate: { num: 30000, den: 1001 },
      frameCount: 100,
      scenes: [0, 30, 30, 120],
      black: [
        [10, 20],
        [95, 140],
      ],
      flashes: [45],
      frozen: [[50, 50]],
      brightness: Array(100).fill(100),
      motion: Array(100).fill(3),
    };
    const f = FootageAnalysis.parse(toFootageAnalysis(raw));
    const frame = (F * 1001) / 30000; // 23,523,500 flicks: an integer
    expect(f.scenes).toEqual([30 * frame]); // the first frame and out-of-range frames are not cuts
    expect(f.black).toEqual([
      { start: 10 * frame, end: 20 * frame },
      { start: 95 * frame, end: 100 * frame },
    ]);
    expect(f.flashes).toEqual([45 * frame]);
    expect(f.frozen).toEqual([]);
    expect(f.duration).toBe(100 * frame);
  });
});

describe('summarizeFootage', () => {
  it('turns an analysis into the plain numbers a take ranking compares', () => {
    const raw: FootageRaw = {
      rate: { num: 30, den: 1 },
      frameCount: 90,
      scenes: [30, 60],
      black: [[0, 15]],
      flashes: [40, 41],
      frozen: [[60, 90]],
      brightness: Array(90).fill(100),
      motion: Array(90).fill(50), // 5 grey levels of change per frame
    };
    const f = summarizeFootage(FootageAnalysis.parse(toFootageAnalysis(raw)));
    expect(f).toEqual({
      seconds: 3,
      blackSeconds: 0.5,
      frozenSeconds: 1,
      flashFrames: 2,
      sceneChanges: 2,
      motion: 20,
    });
  });
});
