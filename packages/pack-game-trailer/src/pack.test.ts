import { definePlugin, PluginHost, PLUGIN_API_VERSION } from '@trailerforge/plugin-api';
import { describe, expect, it } from 'vitest';
import { GameBriefExt, gameTrailerPack } from './index.js';

const corePluginStub = definePlugin({
  id: 'core',
  name: 'core',
  version: '0.0.0',
  apiVersion: PLUGIN_API_VERSION,
  register() {},
});

describe('Game Trailer pack', () => {
  it('loads and registers the three video types with validated requirements', async () => {
    const host = new PluginHost();
    const statuses = await host.load([corePluginStub, gameTrailerPack]);
    expect(statuses.map((s) => s.state)).toEqual(['active', 'active']);
    const release = host.registries.videoTypes.require('game-trailer/release-trailer');
    expect(release.requirements.filter((r) => r.required).map((r) => r.label)).toEqual([
      'Game name',
      'Release date',
      'Platforms',
      'Genre',
      'Key selling points',
      'Tone',
      'Call to action',
      'Output formats and length',
    ]);
    expect(release.requirements.find((r) => r.label === 'Release date')?.anyOf).toEqual([
      'brief.extensions.game-trailer.releaseWindow',
    ]);
    expect(host.registries.videoTypes.list().map((v) => v.id)).toEqual([
      'game-trailer/announcement-trailer',
      'game-trailer/custom',
      'game-trailer/gameplay-trailer',
      'game-trailer/release-trailer',
    ]);
  });

  it('validates the brief extension slice', () => {
    expect(GameBriefExt.parse({ genre: 'Soulslike' }).gamePlatforms).toEqual([]);
    expect(GameBriefExt.safeParse({ steamAppId: 'abc' }).success).toBe(false);
    expect(GameBriefExt.safeParse({ platform: 'PC' }).success).toBe(false);
  });
});
