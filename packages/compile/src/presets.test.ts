import { describe, expect, it } from 'vitest';
import { rate } from '@trailerforge/schema';
import {
  EXPORT_PRESETS,
  defaultPresetFor,
  exportFileName,
  posterTime,
  presetIssues,
  presetById,
  resolveExport,
  safeFileName,
} from './presets.js';

const hd = { resolution: { width: 1920, height: 1080 }, frameRate: rate(24) };
const tall = { resolution: { width: 1080, height: 1920 }, frameRate: rate(30) };

describe('export presets', () => {
  it('has the five presets with unique ids, all in the −14/−16 LUFS, −1 dBTP family', () => {
    expect(EXPORT_PRESETS.map((p) => p.id)).toEqual([
      'core/youtube',
      'core/steam',
      'core/vertical',
      'core/x',
      'core/master',
    ]);
    expect(new Set(EXPORT_PRESETS.map((p) => p.id)).size).toBe(5);
    for (const p of EXPORT_PRESETS) {
      expect(p.loudness.truePeakDb).toBe(-1);
      expect(p.loudness.lufs).toBe(p.id === 'core/master' ? -16 : -14);
    }
  });

  it('picks a default by shape, and falls back with an issue for an unknown id', () => {
    expect(defaultPresetFor(hd.resolution).id).toBe('core/youtube');
    expect(defaultPresetFor(tall.resolution).id).toBe('core/vertical');
    const r = resolveExport('acme/other', tall);
    expect(r.preset.id).toBe('core/vertical');
    expect(r.issues[0]).toMatch(/acme\/other is not installed/);
  });

  it('resolves render settings and the loudness override', () => {
    const r = resolveExport('core/master', hd, { loudnessLufs: -18 });
    expect(r).toMatchObject({
      extension: 'mov',
      encode: { container: 'mov', video: { codec: 'prores_ks', pixFmt: 'yuv422p10le' } },
      loudness: { lufs: -18, truePeakDb: -1 },
      issues: [],
    });
  });

  it('says what does not fit a preset', () => {
    const steam = presetById('core/steam')!;
    expect(presetIssues(steam, hd)).toEqual([]);
    expect(presetIssues(steam, tall)[0]).toMatch(/wants 1920×1080; this version is 1080×1920/);
    const vertical = presetById('core/vertical')!;
    expect(presetIssues(vertical, tall)).toEqual([]);
    expect(presetIssues(vertical, hd)[0]).toMatch(/wants 9:16; this version is 16:9/);
    expect(presetIssues(presetById('core/youtube')!, { ...hd, frameRate: rate(120) })[0]).toMatch(
      /up to 60 fps/,
    );
    expect(
      presetIssues(presetById('core/youtube')!, {
        ...hd,
        resolution: { width: 7680, height: 4320 },
      })[0],
    ).toMatch(/up to 3840×2160/);
  });
});

describe('file names', () => {
  it('fills the template and keeps names safe on every platform', () => {
    const vars = {
      project: 'Parry: The Game',
      version: 'Shorts 9:16',
      format: 'TikTok',
      preset: 'core/vertical',
    };
    expect(exportFileName(undefined, vars, 'mp4')).toBe(
      'Parry-The-Game-Shorts-9-16-core-vertical.mp4',
    );
    expect(exportFileName('{project}_trailer', vars, 'mov')).toBe('Parry-The-Game_trailer.mov');
    expect(safeFileName('CON')).toBe('CON_');
    expect(safeFileName('a<b>c|d?e*f./')).toBe('a b c d e f');
    expect(safeFileName('  ... ')).toBe('trailer');
    expect(safeFileName('x'.repeat(300))).toHaveLength(120);
  });

  it('takes the poster early but inside the version', () => {
    expect(posterTime(30)).toBe(2);
    expect(posterTime(1)).toBe(0.5);
    expect(posterTime(30, 5)).toBe(5);
    expect(posterTime(3, 99)).toBeCloseTo(2.95);
  });
});
