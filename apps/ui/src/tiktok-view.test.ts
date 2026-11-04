import { describe, expect, it } from 'vitest';
import { acceptsLabel, cueTime, inputFor, progressLabel, splitIdeas } from './tiktok-view.js';

describe('tiktok view helpers', () => {
  it('splits ideas by line and caps them', () => {
    expect(splitIdeas(' a \n\n b\r\nc', 2)).toEqual(['a', 'b']);
  });
  it('words what a slot accepts', () => {
    expect(acceptsLabel([])).toBe('a gameplay recording');
    expect(acceptsLabel(['gameplay', 'image', 'video'])).toBe(
      'a gameplay recording, an image or a video',
    );
  });
  it('tags a dropped file by the slot and the file', () => {
    expect(inputFor(['gameplay', 'image'], 'C:\\a\\key.PNG')).toBe('image');
    expect(inputFor(['gameplay', 'image'], 'run.mp4')).toBe('gameplay');
    expect(inputFor(['video'], 'x.mov')).toBe('video');
  });
  it('words progress and times', () => {
    expect(progressLabel({ slots: 3, slotsFilled: 1, lines: 0, linesRecorded: 0 })).toBe(
      '1 of 3 shots filled',
    );
    expect(cueTime(705_600_000 * 65.5)).toBe('1:05.5');
  });
});
