import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDecisions, type ProjectStore } from '@trailerforge/core';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import type { LlmRequest } from '@trailerforge/plugin-api';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acceptEffectOp, authorEffectOp, referenceStillsOp } from './effectcraft-ops.js';
import { Engine } from './engine.js';

/** M8 8.4d: an effect from an example (Lottie) or a reference clip (facts; stills only with consent). */

const STUB = fileURLToPath(
  new URL('../../effectcraft/src/__fixtures__/stub-cli.mjs', import.meta.url),
);
let replies: unknown[] = [];
let onAsk: (() => void) | undefined;
const asked: { prompt: string; images: number }[] = [];
const mock = createMockProvider(
  {
    'effectcraft.author': (req: LlmRequest<unknown>) => {
      asked.push({ prompt: `${req.system}\n${req.prompt}`, images: req.images?.length ?? 0 });
      onAsk?.();
      return replies.shift();
    },
  },
  'core/mock',
  { vision: true },
);
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? mock : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});
const edit = (comp: string) => ({
  name: 'Warden sting',
  summary: 'The example, retitled and timed to the hit.',
  commands: [
    { command: 'prop.set', params: { comp, layer: 'Title', path: 'text/sourceText', value: 'EMBER KNIGHT' } },
    { command: 'prop.addKey', params: { layer: 'Ember sting', path: 'transform/opacity', time: 0, value: 0 } },
  ],
}); // prettier-ignore

let root: string;
let engine: Engine;
let store: ProjectStore;
let lottie: string;
let clip: string;
const proposals = () => {
  const d = join(store.paths.cache, 'effectcraft', 'proposals');
  return existsSync(d) ? readdirSync(d) : [];
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-ecex-'));
  engine = await Engine.start({
    home: join(root, 'home'),
    autosaveMs: 0,
    loadUserPlugins: false,
    llm,
    effectcraft: { bin: process.execPath, prefixArgs: [STUB, 'ok'] },
  });
  store = await engine.createProject(join(root, 'Ex.tforge'), { ...sampleProject(), id: 'proj_ex' } as never); // prettier-ignore
  store.dispatch('core/knowledge.add-entity', { id: 'ent_secret', kind: 'character', name: 'Ash Warden' }); // prettier-ignore
  store.dispatch('core/knowledge.set-excluded', { id: 'ent_secret', excluded: true });
  store.dispatch('core/timeline.set', {
    timeline: { id: 'tl_rough', name: 'Rough cut', frameRate: { num: 30, den: 1 }, resolution: { width: 320, height: 180 }, tracks: [{ id: 'trk_v', kind: 'video', items: [] }] }, // prettier-ignore
  });
  lottie = join(root, 'sting.json');
  await writeFile(
    lottie,
    JSON.stringify({
      v: '5.7.0', nm: 'Ember sting', w: 1080, h: 1080, fr: 30, ip: 0, op: 60,
      layers: [
        { ty: 5, nm: 'Title', t: { d: { k: [{ s: { t: 'ASH WARDEN RISES' } }] } } },
        { ty: 4, nm: 'Ring' },
      ],
    }),
  ); // prettier-ignore
  clip = join(root, 'reference.mp4');
  const graph =
    "color=c=0xff7a1a:s=320x180:r=30:d=3[bg];color=c=white:s=40x40:r=30:d=3[box];[bg][box]overlay=x='40+t*60':y=70,fade=t=in:st=0:d=1";
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-filter_complex', graph, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip]); // prettier-ignore
}, 120_000);
afterAll(async () => {
  await engine.close();
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  replies = [];
  onAsk = undefined;
  asked.length = 0;
});

describe('an effect from an example', { timeout: 180_000 }, () => {
  it('imports a Lottie, tells the model its structure as text, and the edit round-trips to the timeline', async () => {
    replies = [
      { ...edit('Other comp'), name: 'Wrong' }, // refused: another composition
      edit('Ember sting'),
    ];
    const p = await authorEffectOp(engine, store, { words: 'Our title, on the hit', seconds: 2, landAt: 1, example: { file: lottie } }); // prettier-ignore
    expect(p).toMatchObject({ name: 'Warden sting', attempts: 2 });
    expect(p.repaired.join()).toMatch(
      /only the compositions "tf-effect", "Ember sting" may be used/,
    );
    expect(p.sent!.example).toMatchObject({
      kind: 'lottie',
      composition: 'Ember sting',
      size: { width: 1080, height: 1080 },
      seconds: 2,
      layers: [
        { name: 'Title', kind: 'text', text: '[redacted] RISES' },
        { name: 'Ring', kind: 'shape' },
      ],
      nestedAs: { scalePercent: 16.667 },
    });
    const prompt = asked[0]!.prompt;
    expect(prompt).toMatch(/Start from the example/);
    expect(prompt).not.toMatch(/Ash Warden/i);
    for (const path of [root, lottie, store.paths.dir]) expect(prompt).not.toContain(path);
    expect(asked.map((a) => a.images)).toEqual([0, 0]);
    expect(p.preview.frames).toBe(60);

    const r = await acceptEffectOp(engine, store, { proposalId: p.id, at: 0 });
    const stored = JSON.parse(readFileSync(join(store.paths.dir, r.project), 'utf8')) as { comps: { name: string }[]; log: [string, unknown][] }; // prettier-ignore
    expect(stored.comps.map((c) => c.name)).toEqual(['Ember sting', 'tf-effect']);
    expect(stored.log.map(([c]) => c)).toContain('layer.addItem');
    store.undo();
    expect(store.state.timelines[0]!.tracks.some((t) => t.id === 'trk_user_effects')).toBe(false);
  });

  it('refuses what is not a usable example, storing nothing', async () => {
    const bad = join(root, 'bad.json');
    await writeFile(bad, '{"nm":"x"}');
    await expect(authorEffectOp(engine, store, { words: 'x', seconds: 1, example: { file: bad } })).rejects.toMatchObject({ code: 'usage', message: /not a Lottie animation/ }); // prettier-ignore
    await expect(authorEffectOp(engine, store, { words: 'x', seconds: 1, example: { file: join(root, 'a.lottie') } })).rejects.toMatchObject({ code: 'usage' }); // prettier-ignore
    expect(asked).toEqual([]);
    expect(proposals()).toEqual([]);
  });

  it('cancel stores nothing', async () => {
    const ctl = new AbortController();
    replies = [edit('Ember sting')];
    onAsk = () => ctl.abort();
    const before = store.state;
    await expect(authorEffectOp(engine, store, { words: 'x', seconds: 2, example: { file: lottie } }, { signal: ctl.signal })).rejects.toThrow(); // prettier-ignore
    expect(store.state).toBe(before);
    expect(proposals()).toEqual([]);
  });
});

describe('an effect from a reference clip', { timeout: 180_000 }, () => {
  const good = { name: 'Orange sweep', summary: 'x', commands: [{ command: 'layer.newText', params: { name: 'T', text: 'GO' } }] }; // prettier-ignore

  it('sends only the measured facts by default: no images, no paths', async () => {
    replies = [good];
    const p = await authorEffectOp(engine, store, { words: 'like this', seconds: 1, reference: { file: clip } }); // prettier-ignore
    expect(p.sent!.reference).toMatchObject({ seconds: 3, motion: { direction: 'right' } });
    expect((p.sent!.reference as { events: { kind: string }[] }).events.map((e) => e.kind)).toContain('fade-in'); // prettier-ignore
    expect(asked).toEqual([{ prompt: expect.stringMatching(/Match the style of the reference clip/), images: 0 }]); // prettier-ignore
    for (const path of [root, clip]) expect(asked[0]!.prompt).not.toContain(path);
  });

  it('sends exactly the shown stills only with consent, and records it', async () => {
    const { stills } = await referenceStillsOp(engine, store, { file: clip });
    expect(stills).toHaveLength(8);
    expect(stills.every((s) => existsSync(s.path))).toBe(true);
    const again = await referenceStillsOp(engine, store, { file: clip });
    expect(again.stills.map((s) => s.sha256)).toEqual(stills.map((s) => s.sha256));

    // Hashes that are not the ones shown: refused before anything is sent.
    await expect(
      authorEffectOp(engine, store, { words: 'x', seconds: 1, reference: { file: clip, stills: { consent: true, sha256: stills.slice(1).map((s) => s.sha256) } } }),
    ).rejects.toMatchObject({ code: 'usage', message: /changed since you saw them/ }); // prettier-ignore
    await expect(
      authorEffectOp(engine, store, { words: 'x', seconds: 1, reference: { file: clip, stills: { consent: 'yes', sha256: [] } as never } }),
    ).rejects.toMatchObject({ code: 'usage' }); // prettier-ignore
    expect(asked).toEqual([]);

    replies = [good];
    const p = await authorEffectOp(engine, store, { words: 'x', seconds: 1, reference: { file: clip, stills: { consent: true, sha256: stills.map((s) => s.sha256) } } }); // prettier-ignore
    expect(asked.map((a) => a.images)).toEqual([8]);
    expect(asked[0]!.prompt).toMatch(/The 8 images attached are stills/);
    const log = await readDecisions(store.paths.decisions);
    expect(log.find((d) => d.id === `dec_${p.id}_stills`)).toMatchObject({
      step: 'effectcraft/reference-stills',
      choice: { frames: stills.map((s) => ({ at: s.at, sha256: s.sha256 })) },
    });
  });
});
