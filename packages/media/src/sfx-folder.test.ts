import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SFX_KINDS, encodeWav, synthSfx } from '@trailerforge/effects';
import { describe, expect, it } from 'vitest';
import { resolveTools } from './detect.js';
import { buildSfxCatalog, ensureGeneratedSfx, guessSfxKind, scanSfxFolder } from './sfx-folder.js';

const tools = resolveTools();

/** A one-second 440 Hz tone at -12 dBFS, as a user's sound file. */
function tone(path: string, seconds = 1) {
  const r = spawnSync(tools.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${seconds}:sample_rate=48000`,
    '-af',
    'volume=-12dB',
    path,
  ]);
  if (r.status !== 0) throw new Error(String(r.stderr));
}

describe('sound effect folders', () => {
  it("guesses a sound's kind from its file name", () => {
    expect(guessSfxKind('Whoosh_Fast_03.wav')).toBe('whoosh');
    expect(guessSfxKind('cinematic-riser.mp3')).toBe('riser');
    expect(guessSfxKind('Big Impact 2.wav')).toBe('impact');
    expect(guessSfxKind('sub_drop_deep.flac')).toBe('sub-drop');
    expect(guessSfxKind('door.wav')).toBe('custom');
  });

  it('writes the generated sounds once, byte-identical every time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tforge-sfx-'));
    const a = await ensureGeneratedSfx(dir);
    expect([...a.keys()]).toEqual([...SFX_KINDS]);
    for (const [kind, path] of a)
      expect(
        Buffer.from(await readFile(path)).equals(Buffer.from(encodeWav(synthSfx(kind), 48_000))),
      ).toBe(true);
    const before = await readFile(a.get('impact')!);
    await ensureGeneratedSfx(dir);
    expect((await readFile(a.get('impact')!)).equals(before)).toBe(true);
  });

  it('lists only audio files, sorted, and treats a missing folder as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tforge-sfxdir-'));
    await writeFile(join(dir, 'b-whoosh.wav'), 'x');
    await writeFile(join(dir, 'a-impact.MP3'), 'x');
    await writeFile(join(dir, 'notes.txt'), 'x');
    expect((await scanSfxFolder(dir)).map((f) => [f.name, f.kind])).toEqual([
      ['a-impact.MP3', 'impact'],
      ['b-whoosh.wav', 'whoosh'],
    ]);
    expect(await scanSfxFolder(join(dir, 'nope'))).toEqual([]);
  });

  it('builds a catalog of generated and user sounds with measured length and level', async () => {
    const work = await mkdtemp(join(tmpdir(), 'tforge-sfxcat-'));
    const user = join(work, 'user');
    await import('node:fs/promises').then((fs) => fs.mkdir(user));
    tone(join(user, 'Boom-Impact.wav'), 1.5);
    await writeFile(join(user, 'door.wav'), 'not audio, and no kind');
    await writeFile(join(user, 'broken-whoosh.wav'), 'not audio');
    const { catalog, files, warnings } = await buildSfxCatalog({
      generatedDir: join(work, 'gen'),
      userDir: user,
    });
    expect(catalog.filter((o) => o.source === 'generated').map((o) => o.id)).toEqual(
      SFX_KINDS.map((k) => `generated:${k}`),
    );
    const boom = catalog.find((o) => o.id === 'user:Boom-Impact.wav')!;
    expect(boom).toMatchObject({ kind: 'impact', source: 'user' });
    expect(boom.duration / 705_600_000).toBeCloseTo(1.5, 1);
    expect(boom.peakDb).toBeGreaterThan(-31);
    expect(boom.peakDb).toBeLessThan(-29); // measured, not assumed
    expect(files.get('user:Boom-Impact.wav')).toBe(join(user, 'Boom-Impact.wav'));
    expect(files.has('generated:whoosh')).toBe(true);
    expect(warnings).toEqual([
      expect.stringMatching(/^broken-whoosh\.wav: cannot be read as audio/),
      expect.stringMatching(/^door\.wav: cannot tell what kind/),
    ]);
    expect(catalog.some((o) => o.id === 'user:door.wav' || o.id === 'user:broken-whoosh.wav')).toBe(
      false,
    );
  });
});
