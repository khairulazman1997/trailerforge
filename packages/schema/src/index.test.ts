import { describe, expect, it } from 'vitest';
import { PROJECT_SCHEMA_VERSION } from './index.js';

describe('schema package', () => {
  it('exposes a positive integer schema version', () => {
    expect(Number.isInteger(PROJECT_SCHEMA_VERSION)).toBe(true);
    expect(PROJECT_SCHEMA_VERSION).toBeGreaterThan(0);
  });
});
