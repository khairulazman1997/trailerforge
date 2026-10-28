import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePlugin, PLUGIN_API_VERSION } from '@trailerforge/plugin-api';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Engine } from './engine.js';

describe('Engine', () => {
  it('loads the core plugin, installs plugin commands and jobs, and reports on the bus', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tforge-engine-'));
    const extra = definePlugin({
      id: 'extra',
      name: 'Extra',
      version: '1.0.0',
      apiVersion: PLUGIN_API_VERSION,
      register(ctx) {
        ctx.commands.register({
          type: 'extra/set-status-scripted',
          payload: z.strictObject({}),
          label: () => 'Mark scripted',
          apply: (d) => {
            d.status = 'scripted';
          },
        });
        ctx.jobs.register({
          type: 'extra/echo',
          input: z.strictObject({ v: z.int() }),
          run: async (c) => c.input.v * 2,
        });
      },
    });
    const engine = await Engine.start({ home, plugins: [extra], autosaveMs: 0 });
    const events: string[] = [];
    engine.bus.onAny((type) => events.push(type));
    try {
      expect(engine.pluginStatus.map((s) => [s.id, s.state])).toEqual([
        ['core', 'active'],
        ['game-trailer', 'active'],
        ['extra', 'active'],
      ]);
      expect(engine.plugins.registries.platforms.get('core/tiktok')?.maxDuration).toBe(600);
      expect(engine.plugins.registries.graphicTemplates.get('core/title-card')?.kind).toBe('card');
      expect(engine.plugins.registries.graphicTemplates.list().length).toBe(11);

      const store = await engine.createProject(join(home, 'P.tforge'), { name: 'P' });
      store.dispatch('extra/set-status-scripted', {});
      expect(store.state.status).toBe('scripted');

      const id = engine.jobs.enqueue('extra/echo', { v: 21 });
      await new Promise<void>((r) =>
        engine.bus.on(
          'core/job.updated',
          (e) => void (e.jobId === id && e.status === 'succeeded' && r()),
        ),
      );
      expect(engine.jobs.get(id)?.output).toBe(42);

      await engine.closeProject(store.paths.dir);
      expect(events).toEqual(
        expect.arrayContaining([
          'core/project.opened',
          'core/project.changed',
          'core/job.updated',
          'core/project.closed',
        ]),
      );
      expect(await engine.openProject(join(home, 'P.tforge'))).toBeDefined();
    } finally {
      await engine.close();
    }
  });
});
