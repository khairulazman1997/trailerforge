import { describe, expect, it } from 'vitest';
import { projectCompSize } from './project-file.js';

describe('projectCompSize', () => {
  const text = JSON.stringify({
    savedBy: '0.22.0',
    schema: 2,
    items: {
      '1': { id: 1, name: 'tf-effect', kind: { type: 'Comp', width: 1920, height: 1080 } },
      '2': { id: 2, name: 'Solid', kind: { type: 'Solid', width: 100, height: 100 } },
    },
  });

  it('reads the named composition size', () => {
    expect(projectCompSize(text, 'tf-effect')).toEqual({ width: 1920, height: 1080 });
  });

  it('is null for another name, a non-composition or a file that is not JSON', () => {
    expect(projectCompSize(text, 'other')).toBeNull();
    expect(projectCompSize(text, 'Solid')).toBeNull();
    expect(projectCompSize('not json', 'tf-effect')).toBeNull();
  });
});
