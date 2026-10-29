import { describe, expect, it } from 'vitest';
import { SHORTCUTS, isTyping, shortcutsFor } from './shortcuts.js';

describe('shortcuts', () => {
  it('lists each combination once', () => {
    const all = SHORTCUTS.flatMap((s) => s.keys.map((k) => `${s.scope}:${k}`));
    expect(new Set(all).size).toBe(all.length);
  });
  it('shows the global ones everywhere and the tab ones only there', () => {
    expect(shortcutsFor(null).every((s) => s.scope === 'global')).toBe(true);
    expect(shortcutsFor('brief').some((s) => s.scope === 'cut')).toBe(false);
    expect(shortcutsFor('cut').some((s) => s.keys.includes('←'))).toBe(true);
  });
  it('knows a text field from a button', () => {
    expect(isTyping({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isTyping({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});
