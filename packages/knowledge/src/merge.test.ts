import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { coreCommands, ProjectStore } from '@trailerforge/core';
import type { ExtractedEntity, KnowledgeExtractor, LlmProvider } from '@trailerforge/plugin-api';
import { parseProject, Project, type KnowledgeEntity } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { knowledgeCommands } from './commands.js';
import { deepScan, DeepScanConsentError } from './deep-scan.js';
import { genericExtractor } from './generic.js';
import { DEEP_SCAN_TAG, mergeKnowledge, STALE_TAG } from './merge.js';
import { detectExtractors, scanSource } from './source-scan.js';

const ent = (
  kind: ExtractedEntity['kind'],
  name: string,
  extra: Partial<ExtractedEntity> = {},
): ExtractedEntity => ({
  kind,
  name,
  description: '',
  sourcePaths: ['a.md'],
  confidence: 0.6,
  ...extra,
});

const stored = (
  id: string,
  name: string,
  extra: Partial<KnowledgeEntity> = {},
): KnowledgeEntity => ({
  id,
  kind: 'boss',
  name,
  description: 'old',
  sourceId: 'src',
  sourcePaths: ['a.md'],
  confidence: 0.6,
  origin: 'extracted',
  excludedFromLlm: false,
  tags: [],
  extensions: {},
  ...extra,
});

const run = (existing: KnowledgeEntity[], incoming: ExtractedEntity[], extra = {}) =>
  mergeKnowledge(existing, 'src', incoming, {
    taken: new Set(existing.map((e) => e.id)),
    referenced: new Set(),
    ...extra,
  });

describe('mergeKnowledge', () => {
  it('adds new entities and is a no-op when nothing changed', () => {
    const first = run([], [ent('boss', 'The Ash Warden', { description: 'two phases' })]);
    expect(first.added).toHaveLength(1);
    expect(first.knowledge[0]).toMatchObject({
      origin: 'extracted',
      sourceId: 'src',
      id: 'ent_the_ash_warden',
    });
    const second = run(first.knowledge, [
      ent('boss', 'the ash warden', { description: 'two phases' }),
    ]);
    expect([second.added, second.updated, second.removed, second.stale]).toEqual([[], [], [], []]);
    expect(second.knowledge).toEqual(first.knowledge);
  });

  it('refreshes extracted entities but keeps id, exclusion, tags and extensions', () => {
    const e = stored('ent_a', 'Ash', {
      excludedFromLlm: true,
      tags: ['final'],
      extensions: { x: 1 },
    });
    const r = run(
      [e],
      [ent('boss', 'Ash', { description: 'new', confidence: 0.9, sourcePaths: ['b.md'] })],
    );
    expect(r.updated).toEqual(['ent_a']);
    expect(r.knowledge[0]).toMatchObject({
      id: 'ent_a',
      description: 'new',
      confidence: 0.9,
      sourcePaths: ['b.md'],
      excludedFromLlm: true,
      tags: ['final'],
      extensions: { x: 1 },
    });
  });

  it('keeps the old description when the new scan has none', () => {
    expect(run([stored('ent_a', 'Ash')], [ent('boss', 'Ash')]).knowledge[0]?.description).toBe(
      'old',
    );
  });

  it('never touches user entities, and does not duplicate them', () => {
    const mine = stored('ent_mine', 'Ash', {
      origin: 'user',
      description: 'my words',
      confidence: 1,
    });
    const r = run([mine], [ent('boss', 'Ash', { description: 'scanner words' })]);
    expect(r.knowledge).toEqual([mine]);
    expect([r.added, r.updated]).toEqual([[], []]);
    // …and a user entity is never deleted by a scan that no longer finds it.
    expect(run([mine], []).knowledge).toEqual([mine]);
  });

  it('deletes vanished extracted entities unless referenced or excluded', () => {
    const gone = stored('ent_gone', 'Gone');
    const used = stored('ent_used', 'Used');
    const hidden = stored('ent_hidden', 'Hidden', { excludedFromLlm: true });
    const r = run([gone, used, hidden], [], { referenced: new Set(['ent_used']) });
    expect(r.removed).toEqual(['ent_gone']);
    expect(r.stale).toEqual(['ent_used', 'ent_hidden']);
    expect(r.knowledge.map((e) => [e.id, e.tags])).toEqual([
      ['ent_used', [STALE_TAG]],
      ['ent_hidden', [STALE_TAG]],
    ]);
    // Found again later: the stale tag clears and the exclusion is still there.
    const back = run(r.knowledge, [ent('boss', 'Hidden')]);
    expect(back.knowledge.find((e) => e.id === 'ent_hidden')).toMatchObject({
      tags: [],
      excludedFromLlm: true,
    });
  });

  it('leaves other sources alone and does not duplicate their entities', () => {
    const other = stored('ent_o', 'Ash', { sourceId: 'other' });
    const r = run([other], [ent('boss', 'Ash', { description: 'x' })]);
    expect(r.knowledge).toEqual([other]);
    expect(run([other], []).knowledge).toEqual([other]);
  });

  it('keeps deep-scan and standard results apart', () => {
    const std = stored('ent_std', 'Std');
    const deep = stored('ent_deep', 'Deep', { tags: [DEEP_SCAN_TAG] });
    expect(run([std, deep], [], { scope: 'standard' }).removed).toEqual(['ent_std']);
    expect(run([std, deep], [], { scope: 'deep' }).removed).toEqual(['ent_deep']);
    const added = run([], [ent('boss', 'New')], { scope: 'deep' });
    expect(added.knowledge[0]?.tags).toEqual([DEEP_SCAN_TAG]);
  });

  it('mints ids that do not collide with anything in the project', () => {
    const taken = new Set(['ent_ash']);
    const r = mergeKnowledge([], 'src', [ent('boss', 'Ash')], { taken, referenced: new Set() });
    expect(r.knowledge[0]?.id).toBe('ent_ash_2');
  });
});

async function openStore() {
  const dir = join(await mkdtemp(join(tmpdir(), 'tforge-know-')), 'P.tforge');
  const registry = coreCommands();
  for (const c of knowledgeCommands) registry.register(c);
  return ProjectStore.create(dir, Project.parse(sampleProject()), {
    commands: registry,
    autosaveMs: 0,
  });
}

const HASH = 'a'.repeat(64);
const scanPayload = (entities: ExtractedEntity[], scope: 'standard' | 'deep' = 'standard') => ({
  sourceId: 'src_repo',
  scope,
  entities,
  digestHash: HASH,
  scannedAt: '2026-10-23T12:00:00Z',
});

describe('knowledge commands', () => {
  it('apply-scan keeps the project valid when a referenced entity vanishes', async () => {
    const store = await openStore();
    try {
      // sample: ent_warden (extracted from src_repo, used by a slot) and ent_forest (user).
      const s = store.dispatch(
        'core/knowledge.apply-scan',
        scanPayload([ent('level', 'Glass Caverns')]),
      );
      expect(parseProject(s).ok).toBe(true);
      expect(s.knowledge.find((e) => e.id === 'ent_warden')?.tags).toContain(STALE_TAG);
      expect(s.knowledge.some((e) => e.id === 'ent_forest')).toBe(true);
      expect(s.knowledge.some((e) => e.name === 'Glass Caverns' && e.sourceId === 'src_repo')).toBe(
        true,
      );
      expect(s.sources[0]).toMatchObject({
        lastScannedAt: '2026-10-23T12:00:00Z',
        digestHash: HASH,
      });
      expect(() =>
        store.dispatch('core/knowledge.apply-scan', { ...scanPayload([]), sourceId: 'nope' }),
      ).toThrow();
    } finally {
      await store.close();
    }
  });

  it('editing an extracted entity protects it from later scans; undo restores it', async () => {
    const store = await openStore();
    try {
      store.dispatch('core/knowledge.update-entity', {
        id: 'ent_warden',
        patch: { description: 'My notes' },
      });
      expect(store.state.knowledge.find((e) => e.id === 'ent_warden')).toMatchObject({
        origin: 'user',
        description: 'My notes',
        sourceId: 'src_repo',
      });
      const s = store.dispatch(
        'core/knowledge.apply-scan',
        scanPayload([ent('boss', 'The Ash Warden', { description: 'scanner text' })]),
      );
      expect(s.knowledge.find((e) => e.id === 'ent_warden')?.description).toBe('My notes');
      expect(s.knowledge.filter((e) => e.name === 'The Ash Warden')).toHaveLength(1);
      store.undo();
      store.undo();
      expect(store.state.knowledge.find((e) => e.id === 'ent_warden')?.origin).toBe('extracted');
    } finally {
      await store.close();
    }
  });

  it('adds, excludes and removes entities, but not ones the storyboard uses', async () => {
    const store = await openStore();
    try {
      store.dispatch('core/knowledge.add-entity', {
        id: 'ent_new',
        kind: 'item',
        name: 'Ember Blade',
      });
      expect(() =>
        store.dispatch('core/knowledge.add-entity', {
          id: 'ent_dup',
          kind: 'item',
          name: 'ember blade',
        }),
      ).toThrow(/already exists/);
      expect(() =>
        store.dispatch('core/knowledge.add-entity', {
          id: 'ent_warden',
          kind: 'item',
          name: 'Other',
        }),
      ).toThrow(/already used/);
      store.dispatch('core/knowledge.set-excluded', { id: 'ent_new', excluded: true });
      expect(store.state.knowledge.find((e) => e.id === 'ent_new')?.excludedFromLlm).toBe(true);
      store.dispatch('core/knowledge.remove-entity', { id: 'ent_new' });
      expect(store.state.knowledge.some((e) => e.id === 'ent_new')).toBe(false);
      expect(() => store.dispatch('core/knowledge.remove-entity', { id: 'ent_warden' })).toThrow(
        /storyboard/,
      );
    } finally {
      await store.close();
    }
  });

  it("removing a source keeps what the storyboard uses, as the user's own", async () => {
    const store = await openStore();
    try {
      const s = store.dispatch('core/knowledge.remove-source', { id: 'src_repo' });
      expect(s.sources).toEqual([]);
      expect(s.knowledge.find((e) => e.id === 'ent_warden')).toMatchObject({ origin: 'user' });
      expect(s.knowledge.find((e) => e.id === 'ent_warden')).not.toHaveProperty('sourceId');
      expect(parseProject(s).ok).toBe(true);
    } finally {
      await store.close();
    }
  });
});

async function writeTree(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'tforge-src-'));
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), c);
  }
  return root;
}

describe('scanSource', () => {
  it('runs the listed extractors, isolates failures, and reports them', async () => {
    const root = await writeTree({
      'README.md': '# Ember Knight\n\nA game.\n',
      '.env': 'SECRET=1',
    });
    const broken: KnowledgeExtractor = {
      id: 'x/broken',
      name: 'broken',
      detect: async () => 0,
      extract: async () => {
        throw new Error('boom');
      },
    };
    const r = await scanSource(
      {
        path: root,
        include: [],
        exclude: [],
        extractorIds: ['core/generic', 'x/broken', 'x/missing'],
      },
      (id) => [genericExtractor, broken].find((x) => x.id === id),
    );
    expect(r.entities.map((e) => e.name)).toEqual(['Ember Knight']);
    expect(r.problems).toEqual([
      { extractorId: 'x/broken', message: 'boom' },
      { extractorId: 'x/missing', message: 'extractor is not installed' },
    ]);
    expect(r.scan.skipped).toContainEqual({ path: '.env', reason: 'secret' });
    expect(await detectExtractors(r.scan, [genericExtractor, broken])).toEqual(['core/generic']);
  });
});

describe('deepScan', () => {
  const scanOf = async (files: Record<string, string>) => {
    const root = await writeTree(files);
    const { scanRepo } = await import('./scan.js');
    return scanRepo(root);
  };
  const reply = {
    entities: [
      {
        kind: 'boss',
        name: 'Ash Warden',
        description: 'Two-phase boss',
        paths: ['Assets/Boss.cs', 'Invented/Path.cs'],
      },
    ],
  };

  it('refuses without explicit consent, before copying or calling anything', async () => {
    const scan = await scanOf({ 'README.md': '# G' });
    let called = false;
    const makeProvider = () => {
      called = true;
      return {} as LlmProvider;
    };
    for (const consent of [false, undefined, 'yes', 1]) {
      await expect(
        deepScan({ scan, consent: consent as boolean, makeProvider }),
      ).rejects.toBeInstanceOf(DeepScanConsentError);
    }
    expect(called).toBe(false);
  });

  it('shows the model only scanner-accepted files, then cleans up and sanitizes the answer', async () => {
    const scan = await scanOf({
      'README.md': '# G',
      'Assets/Boss.cs': 'class Boss {}',
      '.env': 'SECRET=1',
      'keys/release.pem': 'SECRET',
      'Art/logo.png': 'png',
    });
    let sandbox = '';
    let seen: string[] = [];
    const makeProvider = (cwd: string): LlmProvider => ({
      id: 'x/fake',
      name: 'fake',
      kind: 'mock',
      sendsDataOffDevice: false,
      available: async () => ({ ok: true }),
      async generate(req) {
        sandbox = cwd;
        seen = (await readdir(cwd, { recursive: true, withFileTypes: true }))
          .filter((e) => e.isFile())
          .map((e) =>
            join(e.parentPath, e.name)
              .slice(cwd.length + 1)
              .split('\\')
              .join('/'),
          )
          .sort();
        expect(req.prompt).toMatch(/Read, Grep, Glob/);
        return { value: reply as never, model: 'fake' };
      },
    });
    const r = await deepScan({ scan, consent: true, gameName: 'Ember Knight', makeProvider });
    expect(seen).toEqual(['Assets/Boss.cs', 'README.md']);
    expect(r.filesShared).toBe(2);
    expect(r.entities).toEqual([
      {
        kind: 'boss',
        name: 'Ash Warden',
        description: 'Two-phase boss',
        sourcePaths: ['Assets/Boss.cs'],
        confidence: 0.6,
      },
    ]);
    await expect(readdir(sandbox)).rejects.toThrow(); // temp copy deleted
  });

  it.skipIf(process.platform === 'win32')(
    'runs the Claude Code CLI in the sandbox with read-only tools',
    async () => {
      const scan = await scanOf({ 'README.md': '# G', '.env': 'SECRET=1' });
      const dir = await mkdtemp(join(tmpdir(), 'tforge-fake-'));
      const out = join(dir, 'out.json');
      const bin = join(dir, 'claude');
      await writeFile(
        bin,
        `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), files: fs.readdirSync('.') }));
process.stdin.resume().on('data', () => {}).on('end', () => {
  process.stdout.write(JSON.stringify({ result: '', structured_output: { entities: [{ kind: 'title', name: 'G', paths: ['README.md'] }] }, usage: { input_tokens: 1, output_tokens: 1 } }));
});
`,
      );
      await chmod(bin, 0o755);
      process.env.FAKE_OUT = out;
      try {
        const r = await deepScan({ scan, consent: true, claudeBin: bin });
        expect(r.entities.map((e) => e.name)).toEqual(['G']);
        const seen = JSON.parse(await readFile(out, 'utf8')) as {
          argv: string[];
          cwd: string;
          files: string[];
        };
        expect(seen.argv[seen.argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
        expect(seen.argv.join(' ')).not.toMatch(/Bash|Write|Edit|WebFetch/);
        expect(seen.cwd).toMatch(/tforge-deepscan-/);
        expect(seen.cwd.startsWith(scan.root)).toBe(false);
        expect(seen.files).toEqual(['README.md']);
      } finally {
        delete process.env.FAKE_OUT;
      }
    },
  );
});
