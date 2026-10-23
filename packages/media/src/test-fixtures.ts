/** Synthetic media generated with FFmpeg at test time: no binary fixtures in the repo. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = join(tmpdir(), 'tforge-media-fixtures-v1');

const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

function make(name: string, build: (out: string) => void): string {
  const out = join(dir, name);
  if (!existsSync(out)) build(out);
  return out;
}

export function fixtures() {
  mkdirSync(dir, { recursive: true });
  const clip = make('clip.mp4', (out) =>
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x180:r=30:d=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:d=2',
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
    ]),
  );
  return {
    dir,
    clip,
    noAudio: make('no-audio.mp4', (out) =>
      ff([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=320x180:r=30:d=1',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        out,
      ]),
    ),
    vfr: make('vfr.mp4', (out) =>
      ff([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=320x180:r=30:d=2',
        '-vf',
        "select='not(mod(n\\,3))+lt(n\\,10)'",
        '-fps_mode',
        'vfr',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        out,
      ]),
    ),
    tenBit: make('10bit.mp4', (out) =>
      ff([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=320x180:r=24:d=1',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p10le',
        out,
      ]),
    ),
    rotated: make('rotated.mp4', (out) =>
      ff(['-display_rotation:v:0', '90', '-i', clip, '-c', 'copy', out]),
    ),
    /** Near full-scale sine: true peak above -1 dBTP. */
    hot: make('hot.wav', (out) =>
      ff(['-f', 'lavfi', '-i', "aevalsrc='0.99*sin(2*PI*440*t)':s=48000:d=2", out]),
    ),
    truncated: make('truncated.mp4', (out) =>
      writeFileSync(out, readFileSync(clip).subarray(0, 2048)),
    ),
    garbage: make('garbage.mp4', (out) =>
      writeFileSync(out, Buffer.from('this is not a video file '.repeat(200))),
    ),
  };
}
