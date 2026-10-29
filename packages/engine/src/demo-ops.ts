import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MUSIC_ANALYZER, musicCacheFile, type MusicAnalysis } from '@trailerforge/analysis';
import { writeAnalysisCache } from '@trailerforge/core';
import { encodeWav } from '@trailerforge/effects';
import { runTool } from '@trailerforge/media';
import { shotCodes } from '@trailerforge/pack-game-trailer';
import { FLICKS_PER_SECOND, rate, type ProjectInput } from '@trailerforge/schema';
import type { Engine } from './engine.js';
import { generateCutOp, importFootageOp, matchAcceptOp } from './footage-ops.js';
import { createDefaultVariantsOp } from './graphics-ops.js';
import { requireRenderTools } from './health-ops.js';
import { OpError } from './ops.js';
import { qualityOp } from './render-ops.js';

/**
 * "Try a demo": a small finished project built entirely on this computer, so every tab has
 * something to show. Nothing is downloaded and nothing leaves the machine: the recordings are
 * synthetic (smooth moving colour and a "character", no flashing) made by FFmpeg, the music is a
 * 120 BPM loop synthesized here with a known beat, and the storyboard is written in code. The shots
 * are named with their shot codes, so matching is certain; the cut, the versions and the Quality
 * Gate then run the same code a real project uses. The same inputs give the same files and cut.
 */

const BPM = 120;
const MUSIC_SECONDS = 24;
const SAMPLE_RATE = 44_100;

interface DemoShot {
  id: string;
  title: string;
  file: string;
  /** Background gradient end colour. */
  colour: string;
  seed: number;
  ideal: number;
}

const SHOTS: DemoShot[] = [
  { id: 'shot_parry', title: 'Opening parry', file: 'opening-parry', colour: '0x7a3b1d', seed: 11, ideal: 3 },
  { id: 'shot_forest', title: 'Run through the forest', file: 'forest-run', colour: '0x1f5a3a', seed: 23, ideal: 3 },
  { id: 'shot_boss', title: 'Boss reveal', file: 'boss-reveal', colour: '0x5a1f4a', seed: 37, ideal: 4 },
  { id: 'shot_finisher', title: 'The finisher', file: 'finisher', colour: '0xa8541a', seed: 41, ideal: 3 },
  { id: 'shot_last', title: 'Last stand', file: 'last-stand', colour: '0x1a4a7a', seed: 53, ideal: 3 },
]; // prettier-ignore

function demoProject(): ProjectInput {
  const t = '2026-10-29T00:00:00.000Z';
  const range = (ideal: number) => ({ min: Math.max(1.5, ideal - 1), ideal, max: ideal + 2 });
  const shot = (s: DemoShot, extra: object = {}) => ({
    id: s.id,
    kind: 'shot' as const,
    title: s.title,
    purpose: `Show ${s.title.toLowerCase()}`,
    duration: range(s.ideal),
    captureInstruction: `Record ${s.title.toLowerCase()} with the HUD off.`,
    location: s.id === 'shot_forest' ? 'Cinder Forest' : 'Ash Arena',
    hud: 'off' as const,
    ...extra,
  });
  const [parry, forest, boss, finisher, last] = SHOTS as [DemoShot, DemoShot, DemoShot, DemoShot, DemoShot]; // prettier-ignore
  return {
    schemaVersion: 1 as never,
    id: 'proj_demo',
    name: 'Demo: Ember Knight',
    createdAt: t,
    updatedAt: t,
    domainPackId: 'game-trailer',
    platformTargets: ['core/youtube', 'core/tiktok'],
    brief: {
      videoTypeId: 'game-trailer/release-trailer',
      title: 'Ember Knight',
      freeText: 'A demo project made on this computer: invented game, synthetic footage, generated music.',
      tone: ['intense', 'heroic'],
      audience: 'Players of action games',
      goals: ['Wishlists'],
      keySellingPoints: ['Parry-driven combat', 'Hand-drawn bosses', 'One more try'],
      keyDates: [{ label: 'Release', date: '2027-02-14' }],
      callToAction: 'Wishlist now',
      extensions: { 'game-trailer': { genre: 'action RPG', gamePlatforms: ['PC'] } },
    },
    formatTargets: [
      { id: 'fmt_yt', name: 'YouTube 16:9', aspect: '16:9', resolution: { width: 1920, height: 1080 }, frameRate: rate(30), targetDuration: 20, platformIds: ['core/youtube'] }, // prettier-ignore
      { id: 'fmt_tt', name: 'TikTok 9:16', aspect: '9:16', resolution: { width: 1080, height: 1920 }, frameRate: rate(30), targetDuration: 14, platformIds: ['core/tiktok'] }, // prettier-ignore
    ],
    storyboard: {
      id: 'sb_demo',
      meta: {
        videoTypeId: 'game-trailer/release-trailer',
        tone: ['intense'],
        targetDuration: 20,
        masterResolution: { width: 1920, height: 1080 },
      },
      sections: [
        { id: 'sec_hook', name: 'Hook', role: 'hook', slots: [shot(parry)] },
        { id: 'sec_escalation', name: 'Escalation', role: 'escalation', slots: [
          shot(forest, { entityIds: ['ent_forest'] }),
          shot(boss, { entityIds: ['ent_warden'], overlays: [{ id: 'ov_name', templateId: 'core/lower-third', text: 'The Ash Warden' }] }),
        ] },
        { id: 'sec_climax', name: 'Climax', role: 'climax', slots: [shot(finisher), shot(last)] },
        { id: 'sec_end', name: 'End slate', role: 'end-slate', slots: [
          { id: 'card_end', kind: 'card', cardKind: 'cta', templateId: 'core/end-slate', text: 'Wishlist now', title: 'Call to action', duration: { min: 3, ideal: 4, max: 5 } },
        ] },
      ],
      voLines: [],
      music: {
        direction: 'Driving hybrid percussion at 120 BPM; the hit lands on the boss reveal',
        structure: [],
        hitPoints: [{ id: 'hit_boss', kind: 'drop', slotId: 'shot_boss' }],
        sfxCues: [],
      },
    },
    knowledge: [
      { id: 'ent_warden', kind: 'boss', name: 'The Ash Warden', description: 'Second-act boss with two phases.', origin: 'user' },
      { id: 'ent_forest', kind: 'level', name: 'Cinder Forest', description: 'The first level, all embers and fog.', origin: 'user' },
      { id: 'ent_parry', kind: 'mechanic', name: 'Perfect parry', description: 'Time a block to turn a hit into a counter.', origin: 'user' },
    ],
    plugins: [{ id: 'game-trailer', version: '0.0.0' }],
  } as unknown as ProjectInput; // prettier-ignore
}

/** One 120 BPM bar of kick, hat and a bass note, repeated; the beat is exactly where the analysis says. */
export function demoMusic(): { wav: Uint8Array; analysis: MusicAnalysis } {
  const n = MUSIC_SECONDS * SAMPLE_RATE;
  const out = new Float32Array(n);
  const beat = 60 / BPM;
  const bass = [55, 55, 65.41, 49];
  for (let k = 0; k * beat < MUSIC_SECONDS; k++) {
    const t0 = Math.round(k * beat * SAMPLE_RATE);
    const loud = k < 16 ? 0.6 : 1; // the last bars hit harder
    for (let i = 0; i < 0.22 * SAMPLE_RATE && t0 + i < n; i++) {
      const t = i / SAMPLE_RATE;
      const kick = Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-t * 28)) * t) * Math.exp(-t * 14);
      out[t0 + i]! += 0.7 * loud * kick;
    }
    for (
      let i = 0;
      i < 0.04 * SAMPLE_RATE && t0 + Math.round(beat * 0.5 * SAMPLE_RATE) + i < n;
      i++
    ) {
      const t = i / SAMPLE_RATE;
      const hat = Math.sin(2 * Math.PI * 7000 * t) * Math.exp(-t * 90);
      out[t0 + Math.round(beat * 0.5 * SAMPLE_RATE) + i]! += 0.12 * hat;
    }
    const f = bass[Math.floor(k / 4) % bass.length]!;
    for (let i = 0; i < beat * 0.9 * SAMPLE_RATE && t0 + i < n; i++) {
      const t = i / SAMPLE_RATE;
      out[t0 + i]! +=
        0.2 * Math.sin(2 * Math.PI * f * t) * Math.min(1, t * 80) * Math.exp(-t * 1.5);
    }
  }
  for (let i = 0; i < n; i++) out[i] = Math.max(-0.95, Math.min(0.95, out[i]!));
  const fl = (sec: number) => Math.round(sec * FLICKS_PER_SECOND);
  const beats = Array.from({ length: MUSIC_SECONDS * 2 }, (_, k) => fl(k * beat));
  const hop = fl(0.5);
  const analysis: MusicAnalysis = {
    analyzer: 'music',
    version: MUSIC_ANALYZER.version,
    duration: fl(MUSIC_SECONDS),
    tempo: BPM,
    beatsPerBar: 4,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    onsets: beats,
    energy: {
      hop,
      values: Array.from({ length: MUSIC_SECONDS * 2 }, (_, i) => (i < 16 ? 45 : i < 32 ? 70 : 95)),
    },
    sections: [
      { start: 0, end: fl(8), energy: 45 },
      { start: fl(8), end: fl(16), energy: 70 },
      { start: fl(16), end: fl(24), energy: 95 },
    ],
  };
  return { wav: encodeWav(out, SAMPLE_RATE), analysis };
}

async function makeShot(
  engine: Engine,
  s: DemoShot,
  code: string,
  dir: string,
  signal?: AbortSignal,
) {
  const file = join(dir, `${s.file} ${code}.mp4`);
  if (
    await stat(file).then(
      () => true,
      () => false,
    )
  )
    return file;
  const tmp = `${file}.tmp-${process.pid}.mp4`;
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `gradients=s=1280x720:r=30:d=8:c0=0x14101c:c1=${s.colour}:speed=0.02:seed=${s.seed}`,
    '-f', 'lavfi', '-i', 'color=c=0xf4efe6:s=90x150:r=30:d=8',
    '-filter_complex', "[0:v][1:v]overlay=x='mod(t*230+120,1100)':y='440+40*sin(t*3)',format=yuv420p",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-threads', '1',
    '-fflags', '+bitexact', '-flags:v', '+bitexact', '-map_metadata', '-1', tmp,
  ]; // prettier-ignore
  await runTool(engine.tools.ffmpeg, args, signal ? { signal } : {});
  await rename(tmp, file);
  return file;
}

async function waitIdle(engine: Engine, signal?: AbortSignal, ms = 120_000) {
  const end = Date.now() + ms;
  for (;;) {
    signal?.throwIfAborted();
    if (engine.jobs.list().every((j) => j.status !== 'queued' && j.status !== 'running')) return;
    if (Date.now() > end) throw new OpError('failed', 'preparing the demo media took too long');
    await new Promise((r) => setTimeout(r, 50));
  }
}

export interface DemoOutcome {
  projectId: string;
  dir: string;
  /** What the demo contains, for a first look. */
  shots: number;
  versions: string[];
  seconds: number;
}

/** A folder name for the demo that is not taken yet: "Ember Knight demo", then " 2", " 3"... */
async function freeDir(base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const dir = n === 1 ? `${base}.tforge` : `${base} ${n}.tforge`;
    if (
      !(await stat(dir).then(
        () => true,
        () => false,
      ))
    )
      return dir;
  }
}

/**
 * Build the demo project, open it, and check that it is clean. `dir` is where the project goes
 * (default: `<home>/demo-projects/Ember Knight demo.tforge`, numbered if taken).
 */
export async function createDemoOp(
  engine: Engine,
  opts: { dir?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<DemoOutcome> {
  const { signal } = opts;
  await requireRenderTools(engine, ['libx264', 'aac']);
  const parent = join(engine.home, 'demo-projects');
  await mkdir(parent, { recursive: true });
  const dir = opts.dir ?? (await freeDir(join(parent, 'Ember Knight demo')));
  const init = demoProject();
  // A second demo opened next to the first needs its own id.
  const open = [...engine.projects.values()].map((s) => s.state.id);
  if (open.includes(init.id)) init.id = `proj_demo_${open.length + 1}`;
  const store = await engine.createProject(dir, init as never);
  try {
    const media = join(engine.home, 'demo-media');
    await mkdir(media, { recursive: true });
    const codes = shotCodes(store.state);
    const files: string[] = [];
    for (const s of SHOTS) files.push(await makeShot(engine, s, codes.get(s.id)!, media, signal));
    const music = demoMusic();
    const musicFile = join(media, 'demo-music.wav');
    await writeFile(musicFile, music.wav);
    await importFootageOp(engine, store, { paths: [...files, musicFile], signal });
    await waitIdle(engine, signal);
    await engine.library.reload();
    const track = engine.library.list().find((a) => a.originalName === 'demo-music.wav');
    if (!track) throw new OpError('failed', 'the demo music did not import');
    store.dispatch('core/music.set-track', { assetId: track.id });
    // The beat is known by construction, so no analysis (and no Python) is needed.
    await writeAnalysisCache(musicCacheFile(store.paths.analysisCache, track.quickHash), music.analysis); // prettier-ignore
    store.dispatch('core/brand.set-colors', { patch: { background: '#14101c', text: '#f4efe6', primary: '#f2aa4c', accent: '#7bd3c8' } }); // prettier-ignore
    await matchAcceptOp(engine, store, { minConfidence: 'certain' });
    await generateCutOp(engine, store);
    createDefaultVariantsOp(store);
    // The demo must be clean: a blocked Quality Gate would be a bug here, not a lesson.
    const versions = store.state.storyboard!.variants.map((v) => v.id);
    for (const v of [null, ...versions]) {
      const q = await qualityOp(engine, store, v);
      if (!q.verdict.allowed)
        throw new OpError('failed', `the demo's ${v ?? 'master'} cut is blocked by the Quality Gate: ${q.verdict.blocking.map((f) => f.message).join('; ')}`); // prettier-ignore
    }
    await store.save();
    const tl = store.state.timelines.find((t) => t.id === 'tl_rough')!;
    const end = Math.max(...tl.tracks.flatMap((t) => t.items.map((i) => i.start + i.duration)));
    return {
      projectId: store.state.id,
      dir,
      shots: SHOTS.length,
      versions,
      seconds: end / FLICKS_PER_SECOND,
    };
  } catch (err) {
    await engine.closeProject(dir).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}
