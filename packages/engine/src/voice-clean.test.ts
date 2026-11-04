import { describe, expect, it } from 'vitest';
import { noiseFloorDb, transcriptHash } from './voice-clean.js';

const RATE = 16000;
function signal(seconds: number, f: (t: number, i: number) => number): Float32Array {
  const x = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < x.length; i++) x[i] = f(i / RATE, i);
  return x;
}
// A fixed pseudo-random hiss (no Math.random: the test must not change).
const hiss = (amp: number) => {
  let s = 12345;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return ((s / 0x7fffffff) * 2 - 1) * amp;
  };
};

describe('voice clean-up measurements', () => {
  it('finds the hiss between words', () => {
    const h = hiss(0.01); // uniform ±0.01: RMS about -45 dBFS
    const x = signal(3, (t) => h() + (t > 1 && t < 2 ? 0.3 * Math.sin(2 * Math.PI * 200 * t) : 0));
    expect(noiseFloorDb(x, RATE)).toBeGreaterThanOrEqual(-47);
    expect(noiseFloorDb(x, RATE)).toBeLessThanOrEqual(-43);
  });
  it('digital silence means no noise; nonstop sound never gets a floor above -30', () => {
    expect(noiseFloorDb(new Float32Array(RATE), RATE)).toBe(-80);
    expect(
      noiseFloorDb(
        signal(1, (t) => 0.5 * Math.sin(2 * Math.PI * 200 * t)),
        RATE,
      ),
    ).toBe(-30);
    expect(noiseFloorDb(new Float32Array(0), RATE)).toBe(-80);
  });
  it('keys the cleaned transcript apart from the original', () => {
    const q = 'a'.repeat(64);
    expect(transcriptHash(q, false)).toBe(q);
    expect(transcriptHash(q, true)).toMatch(/^[0-9a-f]{64}$/);
    expect(transcriptHash(q, true)).not.toBe(q);
  });
});
