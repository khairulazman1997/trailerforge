import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { extractorContext, mergeKnowledge, scanRepo } from '@trailerforge/knowledge';
import { collectIds, Project } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import {
  ALL_GROUPS_TAG,
  buildCaptureHints,
  buildCapturePlan,
  DEBUG_COMMAND_TAG,
  SAVE_FILE_TAG,
} from './index.js';
import { isGameScript, stripComments } from './unity-csharp.js';
import { unityExtractor } from './unity.js';

const SECRET = 'sk_live_TOPSECRET123';

const FILES: Record<string, string> = {
  'ProjectSettings/ProjectSettings.asset':
    '%YAML 1.1\n--- !u!129 &1\nPlayerSettings:\n  companyName: Ember Studio\n  productName: Ember Knight\n',
  // IngameDebugConsole attributes and runtime registration.
  'Assets/Scripts/Debug/BossCheats.cs': `using IngameDebugConsole;
public class BossCheats : MonoBehaviour {
  private const string ApiKey = "${SECRET}";
  const string Url = "http://example.com"; // [ConsoleMethod("in_comment", "x")]
  [ConsoleMethod("spawn_boss", "Spawns ${SECRET} boss")]
  public static void SpawnBoss(int phase, bool hard = false) { }
  // [ConsoleMethod("old_cmd", "gone")] public static void Old() { }
  /* [ConsoleMethod("dead_cmd", "")]
     public static void Dead() { } */
  void Awake() { DebugLogConsole.AddCommand<float>("set_time", "Sets time", SetTime); }
  static void SetTime(float t) { }
}`,
  // Quantum Console: named, unnamed (member name), on a property.
  'Assets/Scripts/Cheats.cs': `using QFSW.QC;
namespace Ember {
  public static class Cheats {
    [Command] public static void GodMode() { }
    [Command("tp")]
    [Preserve]
    private static void Teleport(Vector3 position, string label) { }
    [Command] public static int Gold { get; set; }
    static void Indexer() { var x = table[Command]; }
  }
}`,
  // Mirror networking [Command] RPCs are not console commands.
  'Assets/Scripts/Net/PlayerNet.cs': `using Mirror;
public class PlayerNet : NetworkBehaviour { [Command] void CmdFire() { } [Command] void Shoot() { } }`,
  // Third-party plugin folders carry their own built-in commands.
  'Assets/Plugins/IngameDebugConsole/Scripts/Builtins.cs':
    '[ConsoleMethod("help", "Lists commands")] public static void Help() { }',
  'Assets/Editor/Tools.cs': '[Command("editor_only")] static void E() { }',
  // Saves.
  'Assets/Scripts/Save/SaveSystem.cs': `public class SaveSystem {
  string Slot(int i) => Path.Combine(Application.persistentDataPath, "slot1.sav");
  string Settings() => Application.persistentDataPath + "/settings.json";
  string NotASave = "C:/abs/path/file.sav";
  string Backup() => Application.persistentDataPath + "\\\\backup.dat";
  void Prefs() { PlayerPrefs.SetInt("unlocked", 1); }
}`,
  'Assets/Scripts/Save/EasySave.cs': 'void Save() { ES3.Save("gold", 10); }',
  'Assets/Scripts/Save/Commented.cs': '// var p = Application.persistentDataPath + "/ghost.sav";',
};

async function extract(files = FILES) {
  const dir = await mkdtemp(join(tmpdir(), 'tforge-cs-'));
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), c);
  }
  const scan = await scanRepo(dir);
  return unityExtractor.extract(extractorContext(scan, new AbortController().signal));
}

const tagged = (es: Awaited<ReturnType<typeof extract>>, tag: string) =>
  es.filter((e) => e.tags?.includes(tag));

describe('stripComments', () => {
  it('blanks comments, keeps strings, newlines and length', () => {
    const src = 'a = "x // y"; // gone\nb = @"c:\\""/* not */"""; /* gone\n too */ c = \'/\';';
    const out = stripComments(src);
    expect(out).toHaveLength(src.length);
    expect(out).toContain('"x // y"');
    expect(out).not.toContain('gone');
    expect(out).toContain("'/'");
    expect(out.split('\n')).toHaveLength(src.split('\n').length);
  });

  it('is linear on pathological input', () => {
    const big = '/*'.repeat(200_000) + '"'.repeat(200_000);
    const t0 = performance.now();
    stripComments(big);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('Unity C# extraction', () => {
  it('finds debug commands from attributes and registration, with usage', async () => {
    const found = await extract();
    const cmds = tagged(found, DEBUG_COMMAND_TAG);
    expect(cmds.map((e) => e.name).sort()).toEqual([
      'GodMode',
      'Gold',
      'set_time',
      'spawn_boss',
      'tp',
    ]);
    for (const c of cmds) {
      expect(c.kind).toBe('other');
      expect(c.tags).toEqual([DEBUG_COMMAND_TAG, ALL_GROUPS_TAG]);
    }
    const spawn = cmds.find((e) => e.name === 'spawn_boss')!;
    expect(spawn.description).toBe(
      'Debug console command: `spawn_boss <phase> <hard>` (BossCheats.SpawnBoss)',
    );
    expect(spawn.sourcePaths).toEqual(['Assets/Scripts/Debug/BossCheats.cs']);
    expect(cmds.find((e) => e.name === 'tp')!.description).toContain('`tp <position> <label>`');
  });

  it('skips commented-out code, networking RPCs, plugins, editor scripts and indexers', async () => {
    const names = (await extract()).map((e) => e.name);
    for (const n of [
      'in_comment',
      'old_cmd',
      'dead_cmd',
      'CmdFire',
      'Shoot',
      'help',
      'editor_only',
      'Command',
    ]) {
      expect(names, n).not.toContain(n);
    }
    expect(isGameScript('Assets/ThirdParty/X/A.cs')).toBe(false);
    expect(isGameScript('Assets/Scripts/A.cs')).toBe(true);
    expect(isGameScript('Packages/x/A.cs')).toBe(false);
  });

  it('finds save files with their Windows location', async () => {
    const saves = tagged(await extract(), SAVE_FILE_TAG);
    const by = Object.fromEntries(saves.map((e) => [e.name, e.description]));
    expect(Object.keys(by).sort()).toEqual([
      'PlayerPrefs (registry)',
      'SaveFile.es3',
      'backup.dat',
      'settings.json',
      'slot1.sav',
    ]);
    expect(by['slot1.sav']).toBe(
      'Windows: %USERPROFILE%\\AppData\\LocalLow\\Ember Studio\\Ember Knight\\slot1.sav',
    );
    expect(by['PlayerPrefs (registry)']).toBe(
      'Windows: HKEY_CURRENT_USER\\Software\\Ember Studio\\Ember Knight',
    );
    expect(saves.every((e) => e.tags?.includes(ALL_GROUPS_TAG))).toBe(true);
  });

  it('falls back to a placeholder folder without ProjectSettings', async () => {
    const saves = tagged(
      await extract({ 'Assets/S.cs': 'var d = Application.persistentDataPath;' }),
      SAVE_FILE_TAG,
    );
    expect(saves).toEqual([
      expect.objectContaining({
        name: 'Save folder',
        description: 'Windows: <persistentDataPath>',
      }),
    ]);
  });

  it('never copies string contents or secrets into the output', async () => {
    const out = JSON.stringify(await extract());
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('Spawns');
    expect(out).not.toContain('Sets time');
    expect(out).not.toContain('example.com');
    expect(out).not.toContain('C:/abs');
  });

  it('is deterministic', async () => {
    expect(JSON.stringify(await extract())).toBe(JSON.stringify(await extract()));
  });
});

describe('scan → knowledge → capture hints', () => {
  it('shows detected commands and saves in every group and keeps user edits on re-scan', async () => {
    const p = Project.parse(sampleProject());
    const found = await extract();
    const opts = () => ({ taken: collectIds(p), referenced: new Set<string>() });
    p.knowledge = mergeKnowledge(p.knowledge, 'src_repo', found, opts()).knowledge;

    const hints = buildCaptureHints(buildCapturePlan(p.storyboard!, p.knowledge), p.knowledge);
    expect(hints.length).toBeGreaterThan(0);
    for (const h of hints) {
      expect(h.debugCommands.map((c) => c.name)).toContain('spawn_boss');
      expect(h.saveFiles.map((c) => c.name)).toContain('slot1.sav');
    }

    // The user edits one command (making it theirs) and adds a tag to another extracted one.
    const spawn = p.knowledge.find((e) => e.name === 'spawn_boss')!;
    spawn.description = 'spawn_boss 2 — use in the arena';
    spawn.origin = 'user';
    const tp = p.knowledge.find((e) => e.name === 'tp')!;
    tp.tags = [...tp.tags, 'favourite'];
    const count = p.knowledge.length;

    const again = mergeKnowledge(p.knowledge, 'src_repo', await extract(), opts());
    expect(again.knowledge).toHaveLength(count);
    expect(again.added).toEqual([]);
    expect(again.updated).toEqual([]);
    const after = (n: string) => again.knowledge.find((e) => e.name === n)!;
    expect(after('spawn_boss').description).toBe('spawn_boss 2 — use in the arena');
    expect(after('tp').tags).toEqual([DEBUG_COMMAND_TAG, ALL_GROUPS_TAG, 'favourite']);
  });
});
