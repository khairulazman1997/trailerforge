import { describe, expect, it } from 'vitest';
import {
  FLICKS_PER_SECOND,
  flicksPerFrame,
  flicksToFrames,
  flicksToSeconds,
  framesToFlicks,
  rate,
  secondsToFlicks,
  snapToFrame,
} from './time.js';

const videoRates = [
  rate(24000, 1001),
  rate(24),
  rate(25),
  rate(30000, 1001),
  rate(30),
  rate(48),
  rate(50),
  rate(60000, 1001),
  rate(60),
  rate(90),
  rate(100),
  rate(120),
];
const sampleRates = [8000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 192000];

describe('flicks', () => {
  it.each(videoRates)('one frame at %o is an exact integer number of flicks', (r) => {
    expect(Number.isInteger(flicksPerFrame(r))).toBe(true);
  });

  it.each(sampleRates)('one sample at %i Hz is an exact integer number of flicks', (hz) => {
    expect(Number.isInteger(FLICKS_PER_SECOND / hz)).toBe(true);
  });

  it('round-trips frames through flicks with no drift over an hour of NTSC video', () => {
    const r = rate(30000, 1001);
    const frames = 107_892; // ~1 hour at 29.97
    expect(flicksToFrames(framesToFlicks(frames, r), r)).toBe(frames);
    expect(framesToFlicks(frames, r) % flicksPerFrame(r)).toBe(0);
  });

  it('converts seconds both ways', () => {
    expect(secondsToFlicks(1.5)).toBe(1_058_400_000);
    expect(flicksToSeconds(secondsToFlicks(2.25))).toBe(2.25);
  });

  it('snaps an arbitrary position to the nearest frame boundary', () => {
    const r = rate(24);
    const f = flicksPerFrame(r);
    expect(snapToFrame(Math.round(f * 10.4), r)).toBe(f * 10);
    expect(snapToFrame(Math.round(f * 10.6), r)).toBe(f * 11);
  });
});
