import { describe, expect, it } from 'vitest';
import {
  asExportResult,
  asHandoffResult,
  blockedDetails,
  exportButtonLabel,
  parentFolder,
  parseOptionalNumber,
} from './export-view.js';

describe('export view helpers', () => {
  it('reads an export result and ignores anything else', () => {
    expect(asExportResult({ file: '/p/a.mov', sha256: 'ab', poster: '/p/a.png', preset: 'core/master', overridden: ['core/loudness'], warnings: ['w'] })).toEqual({
      file: '/p/a.mov', poster: '/p/a.png', sha256: 'ab', preset: 'core/master', reproducible: true, overridden: ['core/loudness'], warnings: ['w'],
    });
    expect(asExportResult({ reproducible: false, file: 'f', sha256: 's' })!.reproducible).toBe(false);
    expect(asExportResult(null)).toBeNull();
    expect(asExportResult({ file: 1 })).toBeNull();
    expect(asExportResult([])).toBeNull();
  }); // prettier-ignore

  it('reads a handoff result, skipping malformed entries', () => {
    expect(asHandoffResult({ dir: '/d', files: [{ format: 'edl', file: '/d/a.edl' }, { format: 3 }, null], graphics: ['/d/g.mov', 4], warnings: [] })).toEqual({
      dir: '/d', files: [{ format: 'edl', file: '/d/a.edl' }], graphics: ['/d/g.mov'], warnings: [],
    });
    expect(asHandoffResult({ files: [] })).toBeNull();
  }); // prettier-ignore

  it('explains a blocked export, and only that', () => {
    const e = { code: 'gate-blocked', details: { stage: 'output', verdict: { blocking: [{ message: 'clips', checkId: 'core/clipping' }], needsOverride: [{ message: 'loudness is off', checkId: 'core/loudness' }, {}], warnings: [] } } };
    expect(blockedDetails(e)).toEqual({ stage: 'output', lines: [{ text: 'clips', checkId: 'core/clipping', needsOverride: false }, { text: 'loudness is off', checkId: 'core/loudness', needsOverride: true }] });
    expect(blockedDetails({ code: 'failed', details: e.details })).toBeNull();
    expect(blockedDetails({ code: 'gate-blocked' })).toBeNull();
    expect(blockedDetails(undefined)).toBeNull();
  }); // prettier-ignore

  it('offers to resume only a cut-short run', () => {
    expect(exportButtonLabel('none')).toBe('Export');
    expect(exportButtonLabel('succeeded')).toBe('Export');
    expect(exportButtonLabel('blocked')).toBe('Export');
    expect(exportButtonLabel('cancelled')).toBe('Resume export');
    expect(exportButtonLabel('failed')).toBe('Resume export');
  });

  it('finds the folder of a path with either separator, and parses optional numbers', () => {
    expect(parentFolder('/p/exports/a.mov')).toBe('/p/exports');
    expect(parentFolder('C:\\p\\exports\\a.mov')).toBe('C:\\p\\exports');
    expect(parentFolder('a.mov')).toBe('a.mov');
    expect(parseOptionalNumber('', -30, -6)).toBeNull();
    expect(parseOptionalNumber(' -14 ', -30, -6)).toBe(-14);
    expect(parseOptionalNumber('-3', -30, -6)).toBeUndefined();
    expect(parseOptionalNumber('abc', 0, 5)).toBeUndefined();
  });
});
