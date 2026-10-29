import { describe, expect, it } from 'vitest';
import { examplePath, joinPath, platformOf } from './desktop.js';

describe('joinPath', () => {
  it('keeps the separator the chosen folder uses', () => {
    expect(joinPath('C:\\Users\\me\\Games', 'Ember.tforge')).toBe(
      'C:\\Users\\me\\Games\\Ember.tforge',
    );
    expect(joinPath('C:\\Users\\me\\', 'Ember.tforge')).toBe('C:\\Users\\me\\Ember.tforge');
    expect(joinPath('/home/me/games/', 'Ember.tforge')).toBe('/home/me/games/Ember.tforge');
  });
});

describe('example paths', () => {
  it('look like paths on this computer', () => {
    expect(platformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130')).toBe('windows');
    expect(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari')).toBe('mac');
    expect(platformOf('Mozilla/5.0 (X11; Linux x86_64) Firefox')).toBe('other');
    expect(examplePath('MyGame.tforge', 'windows')).toBe('C:\\Users\\you\\Games\\MyGame.tforge');
    expect(examplePath('MyGame.tforge', 'mac')).toBe('/Users/you/Games/MyGame.tforge');
    expect(examplePath('MyGame.tforge', 'other')).toBe('/home/you/games/MyGame.tforge');
  });
});
