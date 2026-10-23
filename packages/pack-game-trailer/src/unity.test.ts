import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { extractorContext, scanRepo } from '@trailerforge/knowledge';
import { beforeAll, describe, expect, it } from 'vitest';
import { humanize, unityExtractor } from './unity.js';

const SECRET = 'UNITY-CLOUD-SECRET';

const so = (name: string, extra: string) =>
  `%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!114 &11400000\nMonoBehaviour:\n  m_ObjectHideFlags: 0\n  m_Script: {fileID: 11500000, guid: abc, type: 3}\n  m_Name: ${name}\n${extra}`;

const FILES: Record<string, string> = {
  'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.0.30f1\n',
  'ProjectSettings/ProjectSettings.asset':
    '%YAML 1.1\n--- !u!129 &1\nPlayerSettings:\n  companyName: Ember Studio\n  productName: Ember Knight\n  bundleVersion: 0.1\n',
  'ProjectSettings/EditorBuildSettings.asset':
    'EditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Boot.unity\n    guid: a\n  - enabled: 1\n    path: Assets/Scenes/CinderForest.unity\n    guid: b\n  - enabled: 0\n    path: Assets/Scenes/Hidden_Level.unity\n    guid: c\n  - enabled: 1\n    path: Assets/Scenes/glass_caverns.unity\n    guid: d\n',
  'ProjectSettings/UnityConnectSettings.asset': `UnityConnectSettings:\n  m_ProjectId: ${SECRET}\n`,
  'Assets/Scenes/CinderForest.unity': '%YAML 1.1\n',
  'Assets/Data/Bosses/AshWarden.asset': so(
    'AshWarden',
    '  displayName: The Ash Warden\n  description: "Second-act boss, two phases \\u2014 fire and ash"\n  health: 900\n',
  ),
  'Assets/Data/Bosses/Cinder_Queen.asset': so('Cinder_Queen', '  health: 700\n'),
  'Assets/Data/Abilities/PerfectParry.asset': so(
    'PerfectParry',
    "  description: 'Deflect any blow'\n",
  ),
  'Assets/Data/Items/EmberBladeData.asset': so('EmberBladeData', '  displayName: Ember Blade\n'),
  'Assets/Data/Settings/AudioSettings.asset': so('AudioSettings', '  volume: 1\n'),
  'Assets/Data/Bosses/NotAScriptableObject.asset':
    '%YAML 1.1\n--- !u!21 &2100000\nMaterial:\n  m_Name: Mat\n',
  'Assets/Prefabs/Enemies/AshHusk.prefab': '%YAML 1.1\n',
  'Assets/Prefabs/Enemies/AshHusk.prefab.meta': 'fileFormatVersion: 2\n',
  'Assets/Prefabs/Props/Barrel.prefab': '%YAML 1.1\n',
  'Assets/Prefabs/Characters/EmberKnight.prefab': '%YAML 1.1\n',
  'Library/ignored.asset': so('X', ''),
  'Packages/com.unity.x/Bosses/Fake.asset': so('Fake', ''),
};

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-unity-'));
  for (const [p, c] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), c);
  }
});

async function extract(files: Record<string, string> | null = null) {
  const dir = files ? await mkdtemp(join(tmpdir(), 'tforge-unity2-')) : root;
  if (files) {
    for (const [p, c] of Object.entries(files)) {
      await mkdir(dirname(join(dir, p)), { recursive: true });
      await writeFile(join(dir, p), c);
    }
  }
  const scan = await scanRepo(dir);
  const ctx = extractorContext(scan, new AbortController().signal);
  return { scan, ctx, found: await unityExtractor.extract(ctx) };
}

describe('Unity extractor', () => {
  it('detects Unity projects', async () => {
    const { ctx } = await extract();
    expect(await unityExtractor.detect(ctx)).toBeGreaterThan(0.9);
    expect(await unityExtractor.detect({ root: '/x', files: ['README.md'] })).toBe(0);
    expect(await unityExtractor.detect({ root: '/x', files: ['Assets/A.unity'] })).toBe(0.6);
  });

  it('reads the title, shipped scenes, ScriptableObjects and prefabs', async () => {
    const { found } = await extract();
    const by = (kind: string) =>
      found
        .filter((e) => e.kind === kind)
        .map((e) => e.name)
        .sort();
    expect(found.find((e) => e.kind === 'title')).toMatchObject({
      name: 'Ember Knight',
      description: 'By Ember Studio',
      confidence: 0.9,
    });
    // Boot is plumbing and Hidden_Level is disabled in the build.
    expect(by('level')).toEqual(['Cinder Forest', 'Glass Caverns']);
    expect(by('boss')).toEqual(['Cinder Queen', 'The Ash Warden']);
    expect(by('ability')).toEqual(['Perfect Parry']);
    expect(by('item')).toEqual(['Ember Blade']);
    expect(by('enemy')).toEqual(['Ash Husk']);
    expect(by('character')).toEqual(['Ember Knight']);
    expect(
      found.some((e) => ['Barrel', 'Audio', 'Mat', 'Fake'].some((n) => e.name.includes(n))),
    ).toBe(false);

    const warden = found.find((e) => e.name === 'The Ash Warden')!;
    expect(warden.description).toBe('Second-act boss, two phases — fire and ash');
    expect(warden.sourcePaths).toEqual(['Assets/Data/Bosses/AshWarden.asset']);
    expect(warden.confidence).toBe(0.85);
    expect(found.find((e) => e.name === 'Cinder Queen')?.confidence).toBe(0.65);
    expect(found.find((e) => e.name === 'Perfect Parry')?.description).toBe('Deflect any blow');
  });

  it('never reads the Unity Cloud settings file', async () => {
    const { scan, found } = await extract();
    expect(scan.skipped).toContainEqual({
      path: 'ProjectSettings/UnityConnectSettings.asset',
      reason: 'secret',
    });
    expect(JSON.stringify(found)).not.toContain(SECRET);
  });

  it('falls back to all scenes, with lower confidence, when there is no build list', async () => {
    const { found } = await extract({
      'ProjectSettings/ProjectSettings.asset': 'PlayerSettings:\n  productName: Tiny\n',
      'Assets/Scenes/Meadow.unity': '%YAML 1.1\n',
      'Assets/Scenes/Splash.unity': '%YAML 1.1\n',
    });
    expect(found.filter((e) => e.kind === 'level')).toMatchObject([
      { name: 'Meadow', confidence: 0.45 },
    ]);
  });

  it('yields nothing but the title for binary-serialized projects', async () => {
    const { found } = await extract({
      'ProjectSettings/ProjectSettings.asset': 'PlayerSettings:\n  productName: Binary Game\n',
      'Assets/Data/Bosses/Boss.asset': 'UnityFS\u0000\u0000binary',
    });
    expect(found.map((e) => e.name)).toEqual(['Binary Game']);
  });

  it('humanizes asset names', () => {
    expect(humanize('AshWarden')).toBe('Ash Warden');
    expect(humanize('ash_warden')).toBe('Ash Warden');
    expect(humanize('SO_EmberBladeData')).toBe('Ember Blade');
    expect(humanize('HUDManager')).toBe('HUD Manager');
    expect(humanize('Data')).toBe('Data');
  });
});
