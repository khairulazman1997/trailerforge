/** Synthetic recordings generated with FFmpeg at test time (no binary fixtures in the repo). */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = join(tmpdir(), 'tforge-ingest-fixtures-v1');

const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

/** A short clip; the title metadata makes each `name` a different file (different hash). */
export function clip(name: string, opts: { vfr?: boolean } = {}): string {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${name}.mp4`);
  if (existsSync(out)) return out;
  const vf = opts.vfr ? ['-vf', "select='not(mod(n\\,3))+lt(n\\,10)'", '-fps_mode', 'vfr'] : [];
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=320x180:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:d=2',
    ...vf,
    '-metadata',
    `title=${name}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    out,
  ]);
  return out;
}
