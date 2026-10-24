import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreCommands, ProjectStore } from '@trailerforge/core';
import { parseProject, Project } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import {
  PACK_ID,
  PLATFORM_PROFILES,
  platformProfile,
  readRecordingOverrides,
  recommendedBitrateMbps,
  recordingCommands,
  resolveRecordingSettings,
  type RecordingInputs,
} from './index.js';

function inputs(platforms: string[], extra: Partial<RecordingInputs> = {}): RecordingInputs {
  const p = Project.parse(sampleProject());
  return {
    brief: {
      ...p.brief,
      extensions: { [PACK_ID]: { gamePlatforms: platforms } },
    },
    formatTargets: [],
    storyboard: null,
    extensions: {},
    ...extra,
  };
}

const codes = (r: ReturnType<typeof resolveRecordingSettings>) => r.advice.map((a) => a.code);

describe('platform table', () => {
  // name, width, height, fps, codec, bitrate, expected platform advice
  it.each([
    ['PC (Steam)', 2560, 1440, 60, 'h264', 90, ['pc-overlay', 'hdr-capable']],
    ['PC (Epic)', 2560, 1440, 60, 'h264', 90, ['pc-overlay', 'hdr-capable']],
    ['macOS', 2560, 1440, 60, 'h264', 90, []],
    ['Steam Deck', 1280, 800, 60, 'h264', 25, ['pc-overlay', 'aspect-16-10']],
    ['PlayStation 5', 3840, 2160, 60, 'hevc', 140, ['console-capture', 'hdr-capable']],
    ['Xbox Series X|S', 3840, 2160, 60, 'hevc', 140, ['console-capture', 'hdr-capable']],
    [
      'Nintendo Switch 2',
      1920,
      1080,
      60,
      'h264',
      50,
      ['console-capture', 'low-fps-platform', 'hdr-capable'],
    ],
    ['Nintendo Switch', 1920, 1080, 60, 'h264', 50, ['console-capture', 'low-fps-platform']],
    ['iOS', 1920, 1080, 60, 'h264', 50, ['mobile-vfr']],
    ['Android', 1920, 1080, 60, 'h264', 50, ['mobile-vfr']],
  ] as const)('%s → %sx%s @%s %s %s Mbps', (name, w, h, fps, codec, mbps, platformAdvice) => {
    const r = resolveRecordingSettings(inputs([name]));
    expect(r.settings).toMatchObject({
      resolution: { width: w, height: h },
      fps,
      codec,
      bitrateMbps: mbps,
      container: 'mkv',
      hdr: false,
      hud: 'off',
    });
    expect(r.primaryPlatform).toBe(name);
    expect(codes(r)).toEqual(['cfr', ...platformAdvice]);
    expect(r.settings).toEqual(r.derived);
  });

  it('covers every GAME_PLATFORMS entry', () => {
    expect(PLATFORM_PROFILES.map((p) => p.name).sort()).toEqual(
      [
        'PC (Steam)',
        'PC (Epic)',
        'PlayStation 5',
        'Xbox Series X|S',
        'Nintendo Switch 2',
        'Nintendo Switch',
        'iOS',
        'Android',
        'macOS',
        'Steam Deck',
      ].sort(),
    );
  });

  it('accepts aliases and ignores case and spacing', () => {
    for (const n of ['PC', ' ps5 ', 'XBOX', 'switch  2', 'Steam']) {
      expect(platformProfile(n), n).not.toBeNull();
    }
    expect(platformProfile('switch 2')?.name).toBe('Nintendo Switch 2');
    expect(platformProfile('Stadia')).toBeNull();
  });
});

describe('resolveRecordingSettings', () => {
  it('uses the highest-spec platform and notes every platform caveat', () => {
    const r = resolveRecordingSettings(inputs(['iOS', 'PlayStation 5', 'Nintendo Switch']));
    expect(r.primaryPlatform).toBe('PlayStation 5');
    expect(r.settings.resolution).toEqual({ width: 3840, height: 2160 });
    expect(codes(r)).toEqual([
      'cfr',
      'console-capture',
      'mobile-vfr',
      'low-fps-platform',
      'hdr-capable',
    ]);
  });

  it('warns about unknown platforms and falls back to PC defaults when none are listed', () => {
    const none = resolveRecordingSettings(inputs([]));
    expect(codes(none)).toEqual(['no-platforms', 'cfr']);
    expect(none.settings.resolution).toEqual({ width: 1920, height: 1080 });
    expect(none.primaryPlatform).toBeNull();

    const odd = resolveRecordingSettings(inputs(['Stadia', 'Stadia', 'macOS']));
    expect(odd.platforms.map((p) => p.name)).toEqual(['Stadia', 'macOS']);
    const w = odd.advice.find((a) => a.code === 'unknown-platform')!;
    expect(w).toMatchObject({ severity: 'warn' });
    expect(w.message).toContain('Stadia');
  });

  it('ignores malformed brief data', () => {
    const base = inputs(['macOS']);
    const bad = {
      ...base,
      brief: { ...base.brief, extensions: { [PACK_ID]: { gamePlatforms: 5 } } },
    };
    expect(codes(resolveRecordingSettings(bad))).toEqual(['no-platforms', 'cfr']);
  });

  it('derives HUD from shots first, then the video type', () => {
    const sb = Project.parse(sampleProject()).storyboard!;
    const withHud = (huds: Array<'on' | 'off' | 'any'>, videoTypeId = sb.meta.videoTypeId) => {
      let i = 0;
      const copy = structuredClone(sb);
      copy.meta.videoTypeId = videoTypeId;
      copy.sections = [
        {
          ...copy.sections[0]!,
          slots: huds.map((hud) => ({
            ...(copy.sections[0]!.slots[0] as never as Record<string, unknown>),
            id: `h${i++}`,
            hud,
          })) as never,
        },
      ];
      return resolveRecordingSettings(inputs(['macOS'], { storyboard: copy }));
    };
    expect(withHud(['on', 'off']).settings.hud).toBe('per-shot');
    expect(codes(withHud(['on', 'off']))).toContain('hud-per-shot');
    expect(withHud(['on', 'any']).settings.hud).toBe('on');
    expect(withHud(['off']).settings.hud).toBe('off');
    expect(withHud(['any'], 'game-trailer/gameplay-trailer').settings.hud).toBe('on');
    expect(withHud(['any'], 'game-trailer/release-trailer').settings.hud).toBe('off');
    expect(withHud(['any'], 'other/unknown').settings.hud).toBe('off');
  });

  it('checks format targets: PC records up to the target, others warn', () => {
    const target = (w: number, h: number, fps: number) => ({
      id: 'fmt_t',
      name: 'Trailer 4K',
      aspect: '16:9' as const,
      resolution: { width: w, height: h },
      frameRate: { num: fps, den: 1 },
      targetDuration: 60,
      platformIds: [],
    });
    const pc = resolveRecordingSettings(
      inputs(['PC (Steam)'], { formatTargets: [target(3840, 2160, 60)] }),
    );
    expect(pc.settings.resolution).toEqual({ width: 3840, height: 2160 });
    expect(pc.settings.codec).toBe('hevc');
    expect(codes(pc)).not.toContain('below-target-res');

    const sw = resolveRecordingSettings(
      inputs(['Nintendo Switch'], { formatTargets: [target(3840, 2160, 120)] }),
    );
    expect(sw.settings.resolution).toEqual({ width: 1920, height: 1080 });
    expect(codes(sw)).toEqual(expect.arrayContaining(['below-target-res', 'below-target-fps']));
  });

  it('suggests 4K headroom for vertical targets', () => {
    const vertical = {
      id: 'fmt_v',
      name: 'TikTok',
      aspect: '9:16' as const,
      resolution: { width: 1080, height: 1920 },
      frameRate: { num: 30, den: 1 },
      targetDuration: 30,
      platformIds: [],
    };
    expect(
      codes(resolveRecordingSettings(inputs(['macOS'], { formatTargets: [vertical] }))),
    ).toContain('reframe-headroom');
    expect(
      codes(resolveRecordingSettings(inputs(['PlayStation 5'], { formatTargets: [vertical] }))),
    ).not.toContain('reframe-headroom');
  });

  it('is deterministic and independent of platform order', () => {
    const a = resolveRecordingSettings(inputs(['PlayStation 5', 'Xbox Series X|S', 'iOS']));
    const b = resolveRecordingSettings(inputs(['iOS', 'Xbox Series X|S', 'PlayStation 5']));
    expect(b.settings).toEqual(a.settings);
    expect(b.primaryPlatform).toBe(a.primaryPlatform);
    expect(JSON.stringify(resolveRecordingSettings(inputs(['iOS'])))).toBe(
      JSON.stringify(resolveRecordingSettings(inputs(['iOS']))),
    );
  });
});

describe('bitrate', () => {
  it.each([
    [1920, 1080, 60, 'h264', 50],
    [1920, 1080, 30, 'h264', 25],
    [2560, 1440, 60, 'h264', 90],
    [3840, 2160, 60, 'hevc', 140],
    [3840, 2160, 60, 'av1', 120],
    [640, 360, 30, 'h264', 10],
  ] as const)('%sx%s @%s %s → %s Mbps', (width, height, fps, codec, mbps) => {
    expect(recommendedBitrateMbps({ resolution: { width, height }, fps, codec })).toBe(mbps);
  });
});

describe('overrides', () => {
  it('apply on top of derived values, and bitrate and codec follow the effective resolution', () => {
    const p = Project.parse(sampleProject());
    const r = resolveRecordingSettings({
      ...inputs(['macOS']),
      brief: p.brief,
      extensions: {
        [PACK_ID]: { recording: { fps: 30, resolution: { width: 3840, height: 2160 } } },
      },
    });
    expect(r.settings).toMatchObject({ fps: 30, codec: 'hevc', bitrateMbps: 70 });
    expect(r.derived.fps).toBe(60);
    expect(r.sources).toMatchObject({ fps: 'override', resolution: 'override', codec: 'derived' });
  });

  it('warns on HDR and on a bitrate far below the suggestion', () => {
    const r = resolveRecordingSettings({
      ...inputs(['PlayStation 5']),
      extensions: { [PACK_ID]: { recording: { hdr: true, bitrateMbps: 20 } } },
    });
    expect(codes(r)).toEqual(expect.arrayContaining(['hdr-on', 'bitrate-low']));
    expect(codes(r)).not.toContain('hdr-capable');
  });

  it('ignores malformed stored overrides', () => {
    expect(
      readRecordingOverrides({ extensions: { [PACK_ID]: { recording: { fps: 'fast' } } } }),
    ).toEqual({});
    expect(readRecordingOverrides({ extensions: { [PACK_ID]: 5 } })).toEqual({});
  });
});

describe('recording commands', () => {
  async function openStore() {
    const dir = join(await mkdtemp(join(tmpdir(), 'tforge-rec-')), 'P.tforge');
    const registry = coreCommands();
    for (const c of recordingCommands) registry.register(c);
    const open = { commands: registry, autosaveMs: 0 };
    return {
      dir,
      open,
      store: await ProjectStore.create(dir, Project.parse(sampleProject()), open),
    };
  }
  const overrides = (store: ProjectStore) => readRecordingOverrides(store.state);

  it('sets, merges, clears, resets and undoes overrides', async () => {
    const { store } = await openStore();
    try {
      const before = structuredClone(store.state.extensions);
      store.dispatch('game-trailer/recording.set-overrides', { fps: 30 });
      store.dispatch('game-trailer/recording.set-overrides', { codec: 'av1', hdr: true });
      expect(overrides(store)).toEqual({ fps: 30, codec: 'av1', hdr: true });

      store.dispatch('game-trailer/recording.set-overrides', { hdr: null });
      expect(overrides(store)).toEqual({ fps: 30, codec: 'av1' });

      store.undo();
      expect(overrides(store)).toEqual({ fps: 30, codec: 'av1', hdr: true });
      store.redo();
      expect(overrides(store)).toEqual({ fps: 30, codec: 'av1' });

      store.dispatch('game-trailer/recording.reset-overrides', {});
      expect(overrides(store)).toEqual({});
      expect(store.state.extensions).toEqual(before);
      store.undo();
      expect(overrides(store)).toEqual({ fps: 30, codec: 'av1' });
      expect(parseProject(store.state).ok).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('rejects invalid values and keeps other pack data', async () => {
    const { store } = await openStore();
    try {
      expect(() =>
        store.dispatch('game-trailer/recording.set-overrides', { fps: 0 } as never),
      ).toThrow();
      expect(() =>
        store.dispatch('game-trailer/recording.set-overrides', { bogus: 1 } as never),
      ).toThrow();
      expect(overrides(store)).toEqual({});
      store.dispatch('game-trailer/recording.set-overrides', { fps: 24 });
      expect(store.state.extensions[PACK_ID]).toEqual({ recording: { fps: 24 } });
    } finally {
      await store.close();
    }
  });

  it('persists across a reopen', async () => {
    const { dir, open, store } = await openStore();
    store.dispatch('game-trailer/recording.set-overrides', {
      resolution: { width: 2560, height: 1440 },
      container: 'mp4',
    });
    await store.close();
    const again = await ProjectStore.open(dir, open);
    try {
      expect(overrides(again)).toEqual({
        resolution: { width: 2560, height: 1440 },
        container: 'mp4',
      });
      expect(resolveRecordingSettings(again.state).settings.container).toBe('mp4');
    } finally {
      await again.close();
    }
  });
});
