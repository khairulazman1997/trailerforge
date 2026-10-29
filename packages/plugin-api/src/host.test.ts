import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PluginHost, type EventSource } from './host.js';
import { definePlugin, PLUGIN_API_VERSION, type Plugin } from './manifest.js';

const base = { name: 'Test', version: '1.0.0', apiVersion: PLUGIN_API_VERSION };

const releaseTrailerPack = definePlugin({
  ...base,
  id: 'game-trailer',
  name: 'Game Trailer pack',
  register(ctx) {
    ctx.videoTypes.register({
      id: 'game-trailer/release-trailer',
      name: 'Release trailer',
      requirements: [
        { field: 'title', label: 'Game name' },
        { field: 'keySellingPoints', label: 'Key selling points', minItems: 3 },
      ],
    });
    ctx.exportPresets.register({
      id: 'game-trailer/steam-1080p',
      name: 'Steam 1080p',
      container: 'mp4',
      video: { codec: 'h264', resolution: { width: 1920, height: 1080 }, bitrateKbps: 12000 },
      audio: { codec: 'aac', bitrateKbps: 320 },
    });
  },
});

const throwing = (id: string, extra: Partial<Plugin> = {}): Plugin => ({
  ...base,
  id,
  register() {
    throw new Error(`${id} exploded`);
  },
  ...extra,
});

const noop = (id: string, extra: Partial<Plugin> = {}): Plugin => ({
  ...base,
  id,
  register() {},
  ...extra,
});

describe('PluginHost', () => {
  it('loads a plugin that registers a video type and an export preset', async () => {
    const host = new PluginHost();
    const [status] = await host.load([releaseTrailerPack]);
    expect(status).toMatchObject({ id: 'game-trailer', state: 'active' });
    const vt = host.registries.videoTypes.require('game-trailer/release-trailer');
    expect(vt.description).toBe(''); // schema defaults applied
    expect(vt.requirements[1]?.minItems).toBe(3);
    expect(host.registries.exportPresets.get('game-trailer/steam-1080p')?.audio.sampleRate).toBe(
      48_000,
    );
    expect(host.registries.exportPresets.ownerOf('game-trailer/steam-1080p')).toBe('game-trailer');
  });

  it('isolates a broken plugin and still loads the others', async () => {
    const host = new PluginHost();
    const statuses = await host.load([throwing('broken'), releaseTrailerPack]);
    expect(statuses.map((s) => [s.id, s.state])).toEqual([
      ['broken', 'disabled'],
      ['game-trailer', 'active'],
    ]);
    expect(statuses[0]?.error).toBe('broken exploded');
  });

  it('rolls back everything a plugin registered before failing', async () => {
    const host = new PluginHost();
    const partial = noop('partial', {
      register(ctx) {
        ctx.videoTypes.register({ id: 'partial/a', name: 'A' });
        ctx.videoTypes.register({ id: 'partial/b', name: 'B' });
        throw new Error('late failure');
      },
    });
    await host.load([partial]);
    expect(host.registries.videoTypes.list()).toEqual([]);
  });

  it('enforces id namespacing and uniqueness', async () => {
    const host = new PluginHost();
    const squatter = noop('squatter', {
      register(ctx) {
        ctx.videoTypes.register({ id: 'game-trailer/release-trailer', name: 'Fake' });
      },
    });
    const [s] = await host.load([squatter]);
    expect(s?.error).toMatch(/must start with "squatter\/"/);
  });

  it('validates data contributions', async () => {
    const host = new PluginHost();
    const bad = noop('bad', {
      register(ctx) {
        ctx.exportPresets.register({
          id: 'bad/x',
          name: 'X',
          container: 'avi' as 'mp4',
          video: { codec: 'h264' },
          audio: { codec: 'aac' },
        });
      },
    });
    const [s] = await host.load([bad]);
    expect(s?.state).toBe('disabled');
    expect(s?.error).toMatch(/invalid export preset.*container/);
  });

  it('refuses invalid manifests, other API versions, missing register and duplicates', async () => {
    const host = new PluginHost();
    const statuses = await host.load([
      { ...noop('Bad Id') },
      noop('future', { apiVersion: PLUGIN_API_VERSION + 1 }),
      { ...base, id: 'no-register' } as unknown as Plugin,
      noop('twin'),
      noop('twin'),
    ]);
    expect(statuses.map((s) => s.state)).toEqual([
      'disabled',
      'disabled',
      'disabled',
      'active',
      'disabled',
    ]);
    expect(statuses[0]?.error).toMatch(/invalid manifest/);
    expect(statuses[1]?.error).toMatch(/needs plugin API v2/);
    expect(statuses[2]?.error).toMatch(/missing register/);
    expect(statuses[4]?.error).toMatch(/duplicate plugin id "twin"/);
  });

  it('loads dependencies first, regardless of list order', async () => {
    const host = new PluginHost();
    const order: string[] = [];
    const track = (id: string, dependsOn: string[] = []) =>
      noop(id, { dependsOn, register: () => void order.push(id) });
    await host.load([track('c', ['b']), track('b', ['a']), track('a')]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('disables dependents of failed or missing plugins, and cycles', async () => {
    const host = new PluginHost();
    const statuses = await host.load([
      throwing('base-pack'),
      noop('needs-base', { dependsOn: ['base-pack'] }),
      noop('needs-ghost', { dependsOn: ['ghost'] }),
      noop('loop-a', { dependsOn: ['loop-b'] }),
      noop('loop-b', { dependsOn: ['loop-a'] }),
    ]);
    const err = Object.fromEntries(statuses.map((s) => [s.id, s.error]));
    expect(err['needs-base']).toBe('dependency "base-pack" failed to load');
    expect(err['needs-ghost']).toBe('dependency "ghost" is not installed');
    expect(err['loop-a']).toBe('dependency cycle');
    expect(err['loop-b']).toBe('dependency cycle');
  });

  it('accepts dependencies loaded in an earlier batch', async () => {
    const host = new PluginHost();
    await host.load([noop('core-pack')]);
    const [s] = await host.load([noop('addon', { dependsOn: ['core-pack'] })]);
    expect(s?.state).toBe('active');
  });

  it('supports async register and times out hung ones', async () => {
    // A wide margin: under a full parallel `pnpm check` a busy machine can take tens of ms to run
    // a 10 ms timer, and the hung plugin still has to wait the whole timeout.
    const host = new PluginHost({ registerTimeoutMs: 1000 });
    const statuses = await host.load([
      noop('slow-ok', { register: () => new Promise((r) => setTimeout(r, 10)) }),
      noop('hung', { register: () => new Promise(() => {}) }),
    ]);
    expect(statuses.map((s) => s.state)).toEqual(['active', 'disabled']);
    expect(statuses[1]?.error).toMatch(/timed out/);
  });

  it('wires events, isolates throwing handlers and unsubscribes on rollback', async () => {
    const handlers = new Map<string, Set<(p: unknown) => void>>();
    const bus: EventSource = {
      on(type, handler) {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type)!.add(handler);
        return () => handlers.get(type)!.delete(handler);
      },
    };
    const logs: string[] = [];
    const host = new PluginHost({ events: bus, log: (e) => logs.push(`${e.plugin}:${e.message}`) });
    const seen: unknown[] = [];
    await host.load([
      noop('listener', {
        register(ctx) {
          ctx.on('render.done', (p) => seen.push(p));
          ctx.on('render.done', () => {
            throw new Error('handler bug');
          });
        },
      }),
      noop('quitter', {
        register(ctx) {
          ctx.on('render.done', () => seen.push('should not run'));
          throw new Error('fails after subscribing');
        },
      }),
    ]);
    for (const h of handlers.get('render.done') ?? []) h({ file: 'out.mp4' });
    expect(seen).toEqual([{ file: 'out.mp4' }]);
    expect(logs.some((l) => l.startsWith('listener:handler for "render.done" threw'))).toBe(true);
  });

  it('exposes feature flags and accepts a flag-gated Planner panel', async () => {
    const host = new PluginHost({ featureFlags: ['planner'] });
    let enabled = false;
    await host.load([
      noop('planner', {
        register(ctx) {
          enabled = ctx.features.isEnabled('planner');
          ctx.uiPanels.register({
            id: 'planner/calendar',
            slot: 'nav.planner',
            title: 'Content Calendar',
            entry: './calendar.js',
            featureFlag: 'planner',
          });
        },
      }),
    ]);
    expect(enabled).toBe(true);
    expect(host.registries.uiPanels.get('planner/calendar')?.slot).toBe('nav.planner');
  });

  it('registers commands and jobs under the plugin namespace', async () => {
    const host = new PluginHost();
    const [ok] = await host.load([
      noop('tools', {
        register(ctx) {
          ctx.commands.register({
            type: 'tools/noop',
            payload: z.strictObject({}),
            label: () => 'noop',
            apply: () => {},
          });
          ctx.jobs.register({ type: 'tools/scan', input: z.strictObject({}), run: async () => {} });
        },
      }),
    ]);
    expect(ok?.state).toBe('active');
    expect(host.registries.commands.get('tools/noop')?.def.label({})).toBe('noop');
    expect(host.registries.jobs.get('tools/scan')).toBeDefined();
  });
});

describe('loadFromDirectory', () => {
  it('loads plugin folders and isolates ones that fail to import', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tforge-plugins-'));
    await mkdir(join(dir, 'hello'));
    await writeFile(join(dir, 'hello', 'package.json'), JSON.stringify({ main: 'index.mjs' }));
    await writeFile(
      join(dir, 'hello', 'index.mjs'),
      `export default {
        id: 'hello', name: 'Hello', version: '0.1.0', apiVersion: ${PLUGIN_API_VERSION},
        register(ctx) { ctx.videoTypes.register({ id: 'hello/devlog', name: 'Devlog teaser' }); },
      };`,
    );
    await mkdir(join(dir, 'syntax-error'));
    await writeFile(
      join(dir, 'syntax-error', 'package.json'),
      JSON.stringify({ main: 'index.mjs' }),
    );
    await writeFile(join(dir, 'syntax-error', 'index.mjs'), 'export default {');

    const host = new PluginHost();
    const statuses = await host.loadFromDirectory(dir);
    expect(statuses.map((s) => [s.id, s.state]).sort()).toEqual([
      ['dir:syntax-error', 'disabled'],
      ['hello', 'active'],
    ]);
    expect(host.registries.videoTypes.get('hello/devlog')?.name).toBe('Devlog teaser');
  });
});
