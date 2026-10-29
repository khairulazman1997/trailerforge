import { createHash } from 'node:crypto';
import dns from 'node:dns';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDemoOp, demoMusic } from './demo-ops.js';
import { Engine } from './engine.js';
import { renderDraftOp } from './render-ops.js';

/** The demo project: complete, clean, identical on a second run, and built without any network. */

const network = {
  connect: vi.spyOn(net.Socket.prototype, 'connect'),
  lookup: vi.spyOn(dns, 'lookup'),
  fetch: vi.spyOn(globalThis, 'fetch'),
};
const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? createMockProvider({}) : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
let root: string;
const runs: { engine: Engine; out: Awaited<ReturnType<typeof createDemoOp>>; media: Record<string, string> }[] = []; // prettier-ignore

async function build(name: string) {
  const engine = await Engine.start({ home: join(root, name), autosaveMs: 0, loadUserPlugins: false, llm }); // prettier-ignore
  const out = await createDemoOp(engine);
  const dir = join(engine.home, 'demo-media');
  const media = Object.fromEntries((await readdir(dir)).sort().map((f) => [f.replace(/\.tmp.*/, ''), sha(join(dir, f))])); // prettier-ignore
  runs.push({ engine, out, media });
  return runs.at(-1)!;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-demo-'));
  await build('a');
  await build('b');
}, 240_000);
afterAll(async () => {
  for (const r of runs) await r.engine.close();
});

describe('demo project', { timeout: 300_000 }, () => {
  it('has a storyboard, takes on every shot, a cut with no placeholders, and two versions', () => {
    const { engine, out } = runs[0]!;
    const p = [...engine.projects.values()].find((s) => s.state.id === out.projectId)!.state;
    expect(p.name).toBe('Demo: Ember Knight');
    const slots = p.storyboard!.sections.flatMap((s) => s.slots);
    const shots = slots.filter((s) => s.kind === 'shot');
    expect(shots).toHaveLength(5);
    for (const s of shots) {
      expect(s.kind === 'shot' && s.takes.length).toBe(1);
      expect(s.kind === 'shot' && s.takes[0]!.matchedBy).toBe('code');
    }
    const cut = p.timelines.find((t) => t.id === 'tl_rough')!;
    const items = cut.tracks.flatMap((t) => t.items);
    expect(items.some((i) => i.kind === 'placeholder')).toBe(false);
    expect(items.filter((i) => i.kind === 'clip' && i.slotId).length).toBe(5);
    expect(cut.tracks.some((t) => t.kind === 'audio' && t.items.length > 0)).toBe(true);
    expect(p.storyboard!.variants.map((v) => v.formatTargetId)).toEqual(['fmt_yt', 'fmt_tt']);
    expect(p.brand?.colors.primary).toBe('#f2aa4c');
    expect(p.knowledge).toHaveLength(3);
    expect(out).toMatchObject({ shots: 5, versions: expect.any(Array) });
    expect(out.seconds).toBeGreaterThan(15);
    expect(out.seconds).toBeLessThan(26);
  });

  it('the music has the beat its analysis says: 120 BPM, a kick on every beat', () => {
    const { wav, analysis } = demoMusic();
    expect(analysis.tempo).toBe(120);
    expect(analysis.beats).toHaveLength(48);
    const view = new DataView(wav.buffer);
    const rms = (sec: number, len = 0.03) => {
      const from = Math.round(sec * 44_100);
      const n = Math.round(len * 44_100);
      let sum = 0;
      for (let i = 0; i < n; i++) sum += view.getInt16(44 + 2 * (from + i), true) ** 2;
      return Math.sqrt(sum / n);
    };
    // The kick makes every beat clearly louder than the bass alone between beats.
    for (const k of [0, 3, 10, 40]) expect(rms(k * 0.5)).toBeGreaterThan(2 * rms(k * 0.5 + 0.35));
  });

  it('is identical on a second run: the same recordings, music, cut and video', async () => {
    const [a, b] = runs as [(typeof runs)[number], (typeof runs)[number]];
    expect(b.media).toEqual(a.media);
    const cut = (r: typeof a) =>
      JSON.stringify(
        [...r.engine.projects.values()].find((s) => s.state.id === r.out.projectId)!.state
          .timelines,
      );
    expect(cut(b)).toBe(cut(a));
    const draft = async (r: typeof a) => {
      const store = [...r.engine.projects.values()].find((s) => s.state.id === r.out.projectId)!;
      return sha((await renderDraftOp(r.engine, store, null, { hardware: false })).file);
    };
    expect(await draft(b)).toBe(await draft(a));
  });

  it('opens a second demo next to the first without a clash, and used no network', async () => {
    const { engine } = runs[0]!;
    const again = await createDemoOp(engine);
    expect(again.projectId).not.toBe(runs[0]!.out.projectId);
    expect(again.dir).toMatch(/Ember Knight demo 2\.tforge$/);
    expect(network.connect).not.toHaveBeenCalled();
    expect(network.lookup).not.toHaveBeenCalled();
    expect(network.fetch).not.toHaveBeenCalled();
  });
});
