import { PluginHost, definePlugin, PLUGIN_API_VERSION } from '@trailerforge/plugin-api';
import { Storyboard } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { gameTrailerPack, storyboardTemplates, videoTypes } from './index.js';

const sum = (sb: Storyboard) =>
  sb.sections.flatMap((s) => s.slots).reduce((a, s) => a + s.duration.ideal, 0);

describe('storyboard templates', () => {
  it('cover every video type and match its defaultTemplateId', () => {
    for (const vt of videoTypes) {
      const t = storyboardTemplates.find((x) => x.videoTypeId === vt.id);
      expect(t?.id).toBe(vt.defaultTemplateId);
    }
  });

  for (const tpl of storyboardTemplates) {
    for (const target of [30, 60, 90]) {
      it(`${tpl.id} builds a valid ${target}s storyboard`, () => {
        const sb = Storyboard.parse(tpl.build({ targetDuration: target }));
        expect(sb.meta.templateId).toBe(tpl.id);
        expect(sb.meta.videoTypeId).toBe(tpl.videoTypeId);
        expect(sum(sb)).toBeCloseTo(target, 5);
        const ids = sb.sections.flatMap((s) => [s.id, ...s.slots.map((x) => x.id)]);
        expect(new Set(ids).size).toBe(ids.length);
        expect(sb.sections.at(-1)?.role).toBe('end-slate');
        for (const s of sb.sections.flatMap((x) => x.slots)) {
          expect(s.duration.ideal).toBeGreaterThan(0);
        }
      });
    }

    it(`${tpl.id} adds optional slots only in longer cuts`, () => {
      const count = (t: number) =>
        Storyboard.parse(tpl.build({ targetDuration: t })).sections.flatMap((s) => s.slots).length;
      expect(count(90)).toBeGreaterThan(count(30));
      const long = Storyboard.parse(tpl.build({ targetDuration: 90 }));
      const nice = long.sections.flatMap((s) => s.slots).filter((s) => s.priority === 'nice');
      expect(nice.length).toBeGreaterThan(0);
    });

    it(`${tpl.id} rejects a non-positive duration`, () => {
      expect(() => tpl.build({ targetDuration: 0 })).toThrow(RangeError);
    });
  }

  it('registers through the plugin host', async () => {
    const host = new PluginHost();
    await host.load([
      definePlugin({
        id: 'core',
        name: 'core',
        version: '0.0.0',
        apiVersion: PLUGIN_API_VERSION,
        register() {},
      }),
      gameTrailerPack,
    ]);
    expect(host.registries.templates.list()).toHaveLength(3);
    expect(host.registries.templates.require('game-trailer/tpl-release').name).toBe(
      'Release trailer',
    );
  });
});
