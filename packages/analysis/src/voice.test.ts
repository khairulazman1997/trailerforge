import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Egress } from '@trailerforge/core';
import { JobQueue } from '@trailerforge/jobs';
import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { TRANSCRIBE_JOB, registerAnalysisJobs } from './jobs.js';
import { ModelConsentRequired, type ModelManifest } from './models.js';
import { SidecarError } from './sidecar.js';
import {
  PINNED_VOICE_MODEL,
  downloadVoiceModel,
  readTranscript,
  sidecarTranscriber,
  stubTranscriber,
  toTranscript,
  transcribeRecording,
  voiceDownloadDisclosure,
  voiceEnvelope,
  voiceModelDir,
  voiceModelStatus,
  type RawTranscript,
} from './index.js';

const F = FLICKS_PER_SECOND;
const HASH = 'a'.repeat(64);
let home: string;
let analysisDir: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tforge-voice-'));
  analysisDir = join(home, 'analysis');
});

const raw = (words: [number, number, string][] = [[0.5, 0.8, 'This'], [0.8, 1.1, 'boss']]): RawTranscript => ({
  duration: 3,
  language: 'en',
  languageProbability: 0.99,
  segments: [{ start: 0.5, end: 1.1, text: words.map((w) => w[2]).join(' ') }],
  words: words.map(([start, end, text]) => ({ start, end, text, p: 0.9 })),
  envelope: { hop: 0.01, db: [-90, -20, -21] },
}); // prettier-ignore

describe('the pinned voice model', () => {
  it('is faster-whisper small at a fixed revision, MIT, four files with sizes and sha256', () => {
    const m = PINNED_VOICE_MODEL!;
    expect(m.license).toBe('MIT');
    expect(m.files.map((f) => f.name)).toEqual(['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt']); // prettier-ignore
    for (const f of m.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.url).toContain('/resolve/536b0662742c02347bc0e980a01041f333bce120/');
    }
    const d = voiceDownloadDisclosure(m);
    expect(d.hosts).toEqual(['huggingface.co', 'us.aws.cdn.hf.co']);
    expect(d.totalBytes).toBeGreaterThan(480e6);
    expect(d.afterwards).toMatch(/never leave/);
  });
});

describe('voice model download', () => {
  const files: Record<string, Buffer> = { 'config.json': Buffer.from('{}'), 'model.bin': Buffer.from('m'.repeat(5000)) }; // prettier-ignore
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const manifest: ModelManifest = {
    id: 'test-whisper',
    title: 'Test Whisper',
    license: 'MIT',
    source: 'example/test@1',
    files: Object.entries(files).map(([name, b]) => ({ name, url: `https://models.example.org/${name}`, bytes: b.length, sha256: sha(b) })), // prettier-ignore
  };
  let fetched: string[] = [];
  const egress = () =>
    new Egress({
      logFile: join(home, 'logs', 'egress.jsonl'),
      fetch: (async (url: string) => {
        fetched.push(String(url));
        return new Response(new Uint8Array(files[String(url).split('/').pop()!]!));
      }) as unknown as typeof fetch,
    });
  beforeEach(() => {
    fetched = [];
  });

  it('needs a yes, downloads once through Egress, verifies, and is ready offline afterwards', async () => {
    expect(await voiceModelStatus(home, null)).toBe('unavailable');
    expect(await voiceModelStatus(home, manifest)).toBe('absent');
    await expect(downloadVoiceModel({ home, egress: egress(), manifest, consent: false })).rejects.toBeInstanceOf(ModelConsentRequired); // prettier-ignore
    expect(fetched).toEqual([]);
    await downloadVoiceModel({ home, egress: egress(), manifest, consent: true });
    expect(fetched).toHaveLength(2);
    expect(await voiceModelStatus(home, manifest)).toBe('ready');
    expect(await readFile(join(voiceModelDir(home, manifest), 'model.bin'), 'utf8')).toBe('m'.repeat(5000)); // prettier-ignore
    const log = await readFile(join(home, 'logs', 'egress.jsonl'), 'utf8');
    expect(log).toContain('voice transcription model');
    await downloadVoiceModel({ home, egress: egress(), manifest, consent: true });
    expect(fetched).toHaveLength(2); // nothing fetched again
  });
});

describe('transcripts', () => {
  it('converts seconds to flicks once, at the boundary', () => {
    const t = toTranscript(raw(), 'm1');
    expect(t).toMatchObject({ modelId: 'm1', language: 'en', duration: 3 * F });
    expect(t.words[0]).toEqual({ start: 0.5 * F, end: 0.8 * F, text: 'This', p: 0.9 });
    expect(t.envelope).toEqual({ hop: 0.01 * F, db: [-90, -20, -21] });
  });

  it('are cached by recording, model, language and prompt', async () => {
    const t = stubTranscriber(() => raw());
    const rec = { path: '/x/vo.wav', quickHash: HASH, analysisDir };
    expect(await readTranscript('stub', rec)).toBeNull();
    const a = await transcribeRecording(t, rec, { prompt: 'This boss' });
    expect(a.cached).toBe(false);
    expect((await transcribeRecording(t, rec, { prompt: 'This boss' })).cached).toBe(true);
    expect(t.calls).toBe(1);
    expect(await readTranscript('stub', rec, { prompt: 'This boss' })).toEqual(a.transcript);
    // Another prompt or language is another transcript.
    expect((await transcribeRecording(t, rec, { prompt: 'Other words' })).cached).toBe(false);
    expect((await transcribeRecording(t, rec, { language: 'de' })).cached).toBe(false);
    expect(t.calls).toBe(3);
    const other = stubTranscriber(() => raw(), 'other');
    expect((await transcribeRecording(other, rec)).cached).toBe(false);
  });

  it('runs as a background job with progress, from the cache the second time', async () => {
    const queue = new JobQueue({ dbPath: join(home, 'jobs.sqlite'), tempRoot: join(home, 'tmp'), progressThrottleMs: 0 }); // prettier-ignore
    const t = stubTranscriber(() => raw());
    registerAnalysisJobs(queue, { transcriber: () => t });
    queue.start();
    try {
      const input = { path: '/x/vo.wav', quickHash: HASH, analysisDir, modelDir: '/m', modelId: 'stub', prompt: 'This boss' }; // prettier-ignore
      const run = async () => {
        const id = queue.enqueue(TRANSCRIBE_JOB, input);
        for (;;) {
          const j = queue.get(id)!;
          if (j.status === 'succeeded' || j.status === 'failed') return j;
          await new Promise((r) => setTimeout(r, 20));
        }
      };
      expect((await run()).output).toEqual({ cached: false, words: 2 });
      expect((await run()).output).toEqual({ cached: true, words: 2 });
      expect(t.calls).toBe(1);
    } finally {
      await queue.close();
    }
  });
});

describe('the real sidecar', { timeout: 120_000 }, () => {
  const wav = async () => {
    const p = join(home, 'vo.wav');
    // 0.5 s silence, 1 s tone, 0.5 s silence.
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      "aevalsrc='if(between(t\\,0.5\\,1.5)\\,0.3*sin(2*PI*220*t)\\,0)':s=48000:d=2", p]); // prettier-ignore
    return p;
  };

  it('measures the envelope with no model, and caches it', async () => {
    const path = await wav();
    const e = await voiceEnvelope({ path, quickHash: HASH, analysisDir });
    expect(e.cached).toBe(false);
    expect(e.duration).toBe(2 * F);
    expect(e.envelope.hop).toBe(0.01 * F);
    expect(e.envelope.db).toHaveLength(200);
    expect(e.envelope.db[20]).toBeLessThan(-60);
    expect(e.envelope.db[100]).toBeGreaterThan(-20);
    expect((await voiceEnvelope({ path, quickHash: HASH, analysisDir })).cached).toBe(true);
  });

  it('refuses to transcribe without the model files (and never fetches one)', async () => {
    const path = await wav();
    const t = sidecarTranscriber(join(home, 'no-model'), 'whisper-small-ct2');
    const err = await t.transcribe(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SidecarError);
    expect((err as SidecarError).code).toBe('model-missing');
  });

  it.skipIf(!process.env.TFORGE_VOICE_LIVE)(
    'live: transcribes a real recording with the downloaded model (TFORGE_VOICE_LIVE=1 TFORGE_VOICE_WAV=<file>)',
    async () => {
      const m = PINNED_VOICE_MODEL!;
      const egress = new Egress({ logFile: join(home, 'egress.jsonl') });
      const shared = join(tmpdir(), 'tforge-voice-live');
      await downloadVoiceModel({ home: shared, egress, manifest: m, consent: true });
      const t = sidecarTranscriber(voiceModelDir(shared, m), m.id);
      const r = await t.transcribe(process.env.TFORGE_VOICE_WAV ?? (await wav()));
      expect(r.envelope.db.length).toBeGreaterThan(0);
      console.log(JSON.stringify(r.words.slice(0, 20)));
    },
    900_000,
  );
});
