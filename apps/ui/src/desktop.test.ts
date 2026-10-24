import { describe, expect, it } from 'vitest';
import { joinPath } from './desktop.js';

describe('joinPath', () => {
  it('keeps the separator the chosen folder uses', () => {
    expect(joinPath('C:\\Users\\me\\Games', 'Ember.tforge')).toBe(
      'C:\\Users\\me\\Games\\Ember.tforge',
    );
    expect(joinPath('C:\\Users\\me\\', 'Ember.tforge')).toBe('C:\\Users\\me\\Ember.tforge');
    expect(joinPath('/home/me/games/', 'Ember.tforge')).toBe('/home/me/games/Ember.tforge');
  });
});
