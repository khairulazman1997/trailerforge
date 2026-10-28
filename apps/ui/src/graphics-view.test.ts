import { defaultBrand } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import {
  defaultsOf,
  fieldsOf,
  hashText,
  labelFor,
  previewFrame,
  secondsToFrameFlicks,
} from './graphics-view.js';

const schema = {
  type: 'object',
  properties: {
    text: { type: 'string', maxLength: 200, default: 'Game title' },
    subtitle: { type: 'string' },
    uppercase: { type: 'boolean', default: false },
    strength: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
    direction: { enum: ['left', 'right'], default: 'left' },
    nested: { type: 'object' },
  },
  required: ['text'],
};

describe('graphics view', () => {
  it('turns a JSON Schema into editor fields, leaving out what it cannot edit', () => {
    const f = fieldsOf(schema);
    expect(f.map((x) => [x.name, x.kind, x.required])).toEqual([
      ['text', 'text', true],
      ['subtitle', 'text', false],
      ['uppercase', 'boolean', false],
      ['strength', 'number', false],
      ['direction', 'choice', false],
    ]);
    expect(f[3]).toMatchObject({ min: 0, max: 1, default: 0.5, label: 'Strength' });
    expect(f[0]).toMatchObject({ maxLength: 200 });
    expect(f[4]!.choices).toEqual(['left', 'right']);
    expect(defaultsOf(schema)).toEqual({
      text: 'Game title',
      uppercase: false,
      strength: 0.5,
      direction: 'left',
    });
    expect(fieldsOf(undefined)).toEqual([]);
    expect(labelFor('barOpacity')).toBe('Bar opacity');
  });

  it('fingerprints text stably and tells different frames apart', () => {
    expect(hashText('abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(hashText('abc')).not.toBe(hashText('abd'));
    expect(hashText('')).toBe('811c9dc5');
  });

  it('draws a template frame with the brand, and says why it cannot when it cannot', () => {
    const size = { width: 1920, height: 1080 };
    const base = { brand: defaultBrand(), size, seconds: 3, at: 1.5 };
    const p = previewFrame({
      ...base,
      templateId: 'core/title-card',
      params: { text: 'Ember Knight' },
    });
    expect('svg' in p && p.svg).toContain('>Ember Knight</tspan>');
    expect('svg' in p && p.svg).toContain('#0b0d12');
    const again = previewFrame({
      ...base,
      templateId: 'core/title-card',
      params: { text: 'Ember Knight' },
    });
    expect('svg' in again && 'svg' in p && again.svg).toBe('svg' in p ? p.svg : '');
    const short = previewFrame({
      ...base,
      seconds: 1,
      at: 0.5,
      templateId: 'core/caption',
      params: { text: 'Parry the Warden at the last possible moment' },
    });
    expect('warnings' in short && short.warnings.some((w) => /reading it takes/.test(w))).toBe(
      true,
    );
    expect(previewFrame({ ...base, templateId: 'acme/plugin', params: {} })).toMatchObject({
      error: expect.stringMatching(/does not know/),
    });
    expect(
      previewFrame({ ...base, templateId: 'core/title-card', params: { nope: 1 } }),
    ).toHaveProperty('error');
  });

  it('puts a typed length on the frame grid', () => {
    const frame = 705_600_000 / 30;
    expect(secondsToFrameFlicks(0.25, { num: 30, den: 1 })).toBe(8 * frame); // 7.5 frames, to the nearest
    expect(secondsToFrameFlicks(0.001, { num: 30, den: 1 })).toBe(705_600_000 / 30); // at least one frame
  });
});
