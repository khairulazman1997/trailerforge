import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTools } from './detect.js';

/** A folder with empty ffmpeg.exe and ffprobe.exe in it. */
function exes(dir: string): string {
  mkdirSync(dir, { recursive: true });
  for (const f of ['ffmpeg.exe', 'ffprobe.exe']) writeFileSync(join(dir, f), '');
  return dir;
}

describe('resolveTools on Windows', () => {
  const root = mkdtempSync(join(tmpdir(), 'tforge-tools-'));

  it('looks past a Chocolatey shim to the real FFmpeg', () => {
    const choco = join(root, 'chocolatey');
    const shims = exes(join(choco, 'bin'));
    const real = exes(join(choco, 'lib', 'ffmpeg', 'tools', 'ffmpeg', 'bin'));
    expect(resolveTools({ PATH: `${join(root, 'none')};${shims}` }, 'win32')).toEqual({
      ffmpeg: join(real, 'ffmpeg.exe'),
      ffprobe: join(real, 'ffprobe.exe'),
    });
  });

  it('looks past a Scoop shim to the real FFmpeg', () => {
    const scoop = join(root, 'scoop');
    const shims = exes(join(scoop, 'shims'));
    const real = exes(join(scoop, 'apps', 'ffmpeg', 'current', 'bin'));
    expect(resolveTools({ PATH: shims }, 'win32').ffmpeg).toBe(join(real, 'ffmpeg.exe'));
  });

  it('keeps a plain FFmpeg on PATH, and TFORGE_FFMPEG_DIR wins over everything', () => {
    const plain = exes(join(root, 'ffmpeg', 'bin'));
    expect(resolveTools({ PATH: plain }, 'win32')).toEqual({
      ffmpeg: 'ffmpeg',
      ffprobe: 'ffprobe',
    });
    expect(resolveTools({ PATH: '' }, 'win32').ffmpeg).toBe('ffmpeg');
    expect(resolveTools({ TFORGE_FFMPEG_DIR: plain, PATH: '' }, 'win32').ffprobe).toBe(
      join(plain, 'ffprobe.exe'),
    );
    // a shim whose real program cannot be found stays as it is
    const lone = exes(join(root, 'lone', 'chocolatey', 'bin'));
    expect(resolveTools({ PATH: lone }, 'win32').ffmpeg).toBe('ffmpeg');
  });
});
