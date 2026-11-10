import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installRunFonts, isolatedEnv, runFontDir } from './cli.js';
import { motionContentHash } from './motion-cache.js';

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('fonts for EffectCraft runs', () => {
  it('puts font files in the per-user font folder the isolated environment points at', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tf-fonts-'));
    const font = join(dir, 'Brand.otf');
    await writeFile(font, 'font bytes');
    const cwd = join(dir, 'run');
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      await installRunFonts(cwd, [font], platform);
      expect(await readFile(join(runFontDir(cwd, platform), 'tf0-Brand.otf'), 'utf8')).toBe(
        'font bytes',
      );
    }
    // Windows: the folder sits under the run's LOCALAPPDATA.
    expect(runFontDir(cwd, 'win32').startsWith(isolatedEnv(cwd).LOCALAPPDATA!)).toBe(true);
  });

  it('counts the fonts in the content hash only when there are any', () => {
    const base = {
      version: '0.22.0',
      templateId: 'effectcraft/project',
      sourceSha256: 'a'.repeat(64),
      params: { comp: 'tf-effect' },
      resolution: { width: 1920, height: 1080 },
      frameRate: { num: 30, den: 1 },
      duration: 1,
    };
    expect(motionContentHash({ ...base, fontSha256: [] })).toBe(motionContentHash(base));
    expect(motionContentHash({ ...base, fontSha256: ['b'.repeat(64)] })).not.toBe(
      motionContentHash(base),
    );
  });
});
