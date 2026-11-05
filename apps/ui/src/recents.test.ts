import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearLegacyRecents, legacyRecents } from './recents.js';

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  return data;
}
afterEach(() => vi.unstubAllGlobals());

describe('legacy recent projects', () => {
  it('reads what an older version kept, newest first, and ignores junk', () => {
    stubStorage({ 'tforge.recent': JSON.stringify(['/p/new', '', 7, '/p/old']) });
    expect(legacyRecents()).toEqual(['/p/new', '/p/old']);
  });

  it('is empty when nothing, something unreadable or blocked storage is there', () => {
    stubStorage();
    expect(legacyRecents()).toEqual([]);
    stubStorage({ 'tforge.recent': '{ not json' });
    expect(legacyRecents()).toEqual([]);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(legacyRecents()).toEqual([]);
    expect(() => clearLegacyRecents()).not.toThrow();
  });

  it('is gone once cleared', () => {
    const data = stubStorage({ 'tforge.recent': JSON.stringify(['/p/a']) });
    clearLegacyRecents();
    expect(data.has('tforge.recent')).toBe(false);
    expect(legacyRecents()).toEqual([]);
  });
});
