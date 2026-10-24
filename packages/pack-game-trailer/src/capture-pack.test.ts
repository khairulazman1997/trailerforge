import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import {
  ALL_GROUPS_TAG,
  buildCapturePack,
  CapturePack,
  capturePackJson,
  DEBUG_COMMAND_TAG,
  PACK_ID,
  renderCapturePack,
  renderCapturePackHtml,
  renderCapturePackMarkdown,
  SAVE_FILE_TAG,
  tipsInputs,
  writeCapturePack,
} from './index.js';
import { writeFile, mkdir } from 'node:fs/promises';

const GOLDEN = new URL('./__golden__/', import.meta.url);
const UPDATE = process.env['UPDATE_GOLDEN'] === '1';

/** Sample project with recorded/skipped shots, hints, stored tips and markup-hostile text. */
function goldenProject(): Project {
  const p = Project.parse(sampleProject());
  const hook = p.storyboard!.sections[0]!;
  const parry = hook.slots[0]!;
  if (parry.kind !== 'shot') throw new Error('expected a shot');
  parry.extensions[PACK_ID] = {
    capture: { notes: 'Use <take 2> & "quotes" | pipe *star* [link](x)', takes: 3 },
  };
  parry.alternates = ['Parry the _first_ strike instead'];
  const boss = p.storyboard!.sections[1]!.slots[0]!;
  if (boss.kind !== 'shot') throw new Error('expected a shot');
  boss.status = 'recorded';
  boss.captureInstruction = 'Wait for the intro cinematic, then walk into the arena.';
  hook.slots.push({
    ...structuredClone(parry),
    id: 'shot_skip',
    title: 'Cut scene',
    extensions: { [PACK_ID]: { capture: { skipped: true } } },
  });
  const ent = (id: string, name: string, description: string, tags: string[]) => ({
    ...p.knowledge[0]!,
    id,
    kind: 'other' as const,
    name,
    description,
    tags,
    sourcePaths: [],
    origin: 'extracted' as const,
  });
  p.knowledge.find((e) => e.id === 'ent_forest')!.excludedFromLlm = true;
  p.knowledge.push(
    ent('ent_dbg', 'spawn_boss', 'Debug console command: `spawn_boss <phase>`', [
      DEBUG_COMMAND_TAG,
      ALL_GROUPS_TAG,
    ]),
    ent('ent_dbg2', 'warp_forest', 'Debug console command: `warp forest` (Cinder Forest)', [
      DEBUG_COMMAND_TAG,
    ]),
    ent('ent_save', 'slot1.sav', 'Windows: %USERPROFILE%\\AppData\\LocalLow\\Ember\\slot1.sav', [
      SAVE_FILE_TAG,
      ALL_GROUPS_TAG,
    ]),
  );
  const first = tipsInputs(p).groups[0]!;
  p.extensions[PACK_ID] = {
    captureTips: {
      [first.group.key]: {
        tips: ['Start from the checkpoint to save loading time.'],
        risks: ['An autosave popup can ruin a take.'],
        inputsHash: first.hash,
        generatedAt: '2026-10-24T12:00:00.000Z',
        edited: false,
      },
    },
  };
  return p;
}

async function golden(name: string, actual: string) {
  const url = new URL(name, GOLDEN);
  if (UPDATE) {
    await mkdir(GOLDEN, { recursive: true });
    await writeFile(url, actual);
    return;
  }
  const expected = await readFile(url, 'utf8').catch(() => null);
  expect(expected, `missing golden ${name}; run with UPDATE_GOLDEN=1`).not.toBeNull();
  expect(actual).toBe(expected);
}

describe('capture pack', () => {
  it('matches the golden files', async () => {
    const pack = buildCapturePack(goldenProject());
    await golden('capture-pack.md', renderCapturePackMarkdown(pack));
    await golden('capture-pack.html', renderCapturePackHtml(pack));
    await golden('capture-pack.json', capturePackJson(pack));
  });

  it('is deterministic, whatever order the knowledge is in', () => {
    const a = goldenProject();
    const b = goldenProject();
    b.knowledge.reverse();
    for (const f of ['md', 'html', 'json'] as const) {
      expect(renderCapturePack(buildCapturePack(b), f)).toBe(
        renderCapturePack(buildCapturePack(a), f),
      );
    }
  });

  it('builds JSON that validates and round-trips', () => {
    const pack = buildCapturePack(goldenProject());
    const text = capturePackJson(pack);
    expect(CapturePack.parse(JSON.parse(text))).toEqual(pack);
    expect(pack).toMatchObject({
      format: 'trailerforge.capture-pack',
      version: 1,
      progress: { total: 2, done: 1 },
      skipped: [{ slotId: 'shot_skip', title: 'Cut scene' }],
    });
    // Everywhere-setup is listed once, not repeated in each group.
    expect(pack.setup.debugCommands.map((h) => h.name)).toEqual(['spawn_boss']);
    // Both groups are in the Forest, so the Forest-specific command shows in each.
    expect(pack.groups.flatMap((g) => g.hints.debugCommands.map((h) => h.name))).toEqual([
      'warp_forest',
      'warp_forest',
    ]);
    expect(pack.groups[1]!.tips).toMatchObject({ status: 'fresh' });
  });

  it('escapes hostile text in both formats', () => {
    const pack = buildCapturePack(goldenProject());
    const md = renderCapturePackMarkdown(pack);
    const page = renderCapturePackHtml(pack);
    expect(md).toContain('Use \\<take 2\\> & "quotes" \\| pipe \\*star\\* \\[link\\](x)');
    expect(md).toContain('`spawn_boss <phase>`'); // code spans stay literal
    expect(page).toContain('<code>spawn_boss &lt;phase&gt;</code>');
    expect(md).not.toContain('<take 2>');
    expect(page).toContain('Use &lt;take 2&gt; &amp; &quot;quotes&quot; | pipe *star* [link](x)');

    const evil = goldenProject();
    evil.name = '</title><script>alert(1)</script>';
    const html = renderCapturePackHtml(buildCapturePack(evil));
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('produces an offline page: no scripts, links, images or external references', () => {
    const html = renderCapturePackHtml(buildCapturePack(goldenProject()));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('@media print');
    expect(html).not.toMatch(
      /<script|<link|<img|<iframe|<form|<input|src=|href=|url\(|@import|https?:\/\//i,
    );
  });

  it('contains no absolute paths or source paths', () => {
    const p = goldenProject();
    p.knowledge[0]!.sourcePaths = ['C:/Users/me/Game/Assets/Secret.asset'];
    const pack = buildCapturePack(p);
    for (const f of ['md', 'html', 'json'] as const) {
      expect(renderCapturePack(pack, f), f).not.toMatch(/Secret\.asset|C:\/Users|\/home\//);
    }
    for (const f of ['md', 'html'] as const) {
      expect(renderCapturePack(pack, f), f).not.toMatch(/ent_/); // entity ids stay internal
    }
  });

  it('can leave out everything about excluded entities, even inside other text', () => {
    const p = goldenProject();
    const full = buildCapturePack(p);
    expect(JSON.stringify(full)).toContain('Cinder Forest');

    const shared = buildCapturePack(p, { omitExcluded: true });
    for (const f of ['md', 'html', 'json'] as const) {
      const text = renderCapturePack(shared, f);
      expect(text, f).not.toMatch(/cinder forest|ent_forest/i);
    }
    // warp_forest's own description mentioned the excluded level.
    expect(renderCapturePackMarkdown(shared)).toContain('(omitted)');
    expect(shared.groups.map((g) => g.key)).toEqual(['group-1', 'group-2']);
    expect(CapturePack.parse(JSON.parse(capturePackJson(shared)))).toEqual(shared);
    // Without any excluded entity the option changes nothing.
    p.knowledge.find((e) => e.id === 'ent_forest')!.excludedFromLlm = false;
    expect(buildCapturePack(p, { omitExcluded: true })).toEqual(buildCapturePack(p));
  });

  it('omits short excluded names without breaking settings, statuses or ids', () => {
    const p = goldenProject();
    p.knowledge.push(
      {
        ...p.knowledge[0]!,
        id: 'ent_off',
        kind: 'item',
        name: 'Off',
        excludedFromLlm: true,
        sourcePaths: [],
      },
      {
        ...p.knowledge[0]!,
        id: 'ent_mkv',
        kind: 'item',
        name: 'mkv',
        excludedFromLlm: true,
        sourcePaths: [],
      },
    );
    p.storyboard!.sections[0]!.slots[0]!.title = 'Take off the helmet';
    const shared = buildCapturePack(p, { omitExcluded: true });
    expect(shared.recording.settings.container).toBe('mkv');
    expect(
      shared.groups.flatMap((g) => g.items).find((i) => i.slotId === 'shot_parry'),
    ).toMatchObject({
      hud: 'off',
      title: 'Take (omitted) the helmet',
    });
    expect(CapturePack.parse(JSON.parse(capturePackJson(shared)))).toEqual(shared);
  });

  it('handles an empty storyboard and refuses a missing one', () => {
    const p = goldenProject();
    p.storyboard!.sections = [];
    const pack = buildCapturePack(p);
    expect(renderCapturePackMarkdown(pack)).toContain('Nothing to record.');
    expect(renderCapturePackHtml(pack)).toContain('Nothing to record.');
    p.storyboard = null;
    expect(() => buildCapturePack(p)).toThrow(/no storyboard/);
  });
});

describe('writeCapturePack', () => {
  it('writes the files under exports/capture, atomically and repeatably', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tforge-pack-'));
    const pack = buildCapturePack(goldenProject());
    const written = await writeCapturePack(dir, pack);
    expect(written).toEqual([
      'exports/capture/capture-pack.html',
      'exports/capture/capture-pack.json',
      'exports/capture/capture-pack.md',
    ]);
    for (const rel of written) {
      const text = await readFile(join(dir, rel), 'utf8');
      expect(text).toBe(
        renderCapturePack(
          pack,
          rel.endsWith('.md') ? 'md' : rel.endsWith('.html') ? 'html' : 'json',
        ),
      );
      expect(text).not.toContain(dir);
    }
    await writeCapturePack(dir, pack, ['md']);
    expect((await readdir(join(dir, 'exports', 'capture'))).sort()).toEqual([
      'capture-pack.html',
      'capture-pack.json',
      'capture-pack.md',
    ]);
    expect(await writeCapturePack(dir, pack, ['json', 'json'])).toEqual([
      'exports/capture/capture-pack.json',
    ]);
  });
});
