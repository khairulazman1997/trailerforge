import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreCommands, ProjectStore } from '@trailerforge/core';
import { knowledgeCommands, mergeKnowledge } from '@trailerforge/knowledge';
import { collectIds, KnowledgeEntity, Project } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import {
  ALL_GROUPS_TAG,
  buildCaptureHints,
  buildCapturePlan,
  DEBUG_COMMAND_TAG,
  SAVE_FILE_TAG,
} from './index.js';

const ent = (id: string, kind: KnowledgeEntity['kind'], name: string, extra = {}) =>
  KnowledgeEntity.parse({ id, kind, name, ...extra });

function fixture() {
  const p = Project.parse(sampleProject());
  p.knowledge.push(
    ent('ent_dbg', 'other', 'Spawn boss', {
      description: 'console: spawn AshWarden --phase 2 (Cinder Forest)',
      tags: [DEBUG_COMMAND_TAG],
      origin: 'user',
    }),
    ent('ent_god', 'other', 'God mode', {
      description: 'console: god',
      tags: [DEBUG_COMMAND_TAG, ALL_GROUPS_TAG],
      origin: 'user',
    }),
    ent('ent_save', 'other', 'Pre-boss save', {
      description: '%APPDATA%/Ember/saves/forest_boss.sav',
      tags: [SAVE_FILE_TAG],
      origin: 'user',
    }),
    ent('ent_other_dbg', 'other', 'Castle teleport', {
      description: 'console: tp castle',
      tags: [DEBUG_COMMAND_TAG],
      origin: 'user',
    }),
  );
  return p;
}
const plan = (p: Project) => buildCapturePlan(p.storyboard!, p.knowledge);
const names = (hs: { name: string }[]) => hs.map((h) => h.name);

describe('buildCaptureHints', () => {
  it('shows levels, featured entities, debug commands and save files per group', () => {
    const p = fixture();
    const hints = buildCaptureHints(plan(p), p.knowledge);
    const boss = hints.find((h) => names(h.featured).includes('The Ash Warden'))!;
    expect(names(boss.levels)).toEqual(['Cinder Forest']);
    expect(names(boss.featured)).toEqual(['The Ash Warden']);
    expect(names(boss.debugCommands)).toEqual(['God mode', 'Spawn boss']);
    expect(names(boss.saveFiles)).toEqual(['Pre-boss save']);
    expect(boss.featured[0]).toMatchObject({
      kind: 'boss',
      sourcePaths: ['Assets/Data/Bosses/AshWarden.asset'],
    });
    // Every group gets an entry, in plan order; unrelated commands never appear.
    expect(hints.map((h) => h.groupKey)).toEqual(plan(p).groups.map((g) => g.key));
    expect(hints.flatMap((h) => names(h.debugCommands))).not.toContain('Castle teleport');
  });

  it('matches a level to the group location by name', () => {
    const p = fixture();
    p.knowledge.find((e) => e.id === 'ent_forest')!.name = 'Forest';
    const g = plan(p).groups.find((x) => x.location === 'Forest' && x.entity === null)!;
    const h = buildCaptureHints({ groups: [g] }, p.knowledge)[0]!;
    expect(names(h.levels)).toEqual(['Forest']);
    expect(names(h.debugCommands)).toEqual(['God mode', 'Spawn boss']);
  });

  it('leaves out save files that mention nothing in the group', () => {
    const p = fixture();
    const save = p.knowledge.find((e) => e.id === 'ent_save')!;
    save.description = 'C:/saves/castle_start.sav';
    expect(buildCaptureHints(plan(p), p.knowledge).flatMap((h) => names(h.saveFiles))).toEqual([]);
    save.description = 'Cinder Forest, before the boss';
    expect(buildCaptureHints(plan(p), p.knowledge).flatMap((h) => names(h.saveFiles))).toContain(
      'Pre-boss save',
    );
  });

  it('is deterministic whatever the knowledge order', () => {
    const p = fixture();
    const a = buildCaptureHints(plan(p), p.knowledge);
    const b = buildCaptureHints(plan(p), [...p.knowledge].reverse());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('keeps excluded entities out of anything meant for a model', () => {
    const p = fixture();
    for (const id of ['ent_warden', 'ent_forest', 'ent_dbg', 'ent_save']) {
      p.knowledge.find((e) => e.id === id)!.excludedFromLlm = true;
    }
    const local = JSON.stringify(buildCaptureHints(plan(p), p.knowledge));
    const safe = JSON.stringify(buildCaptureHints(plan(p), p.knowledge, { forLlm: true }));
    for (const secret of [
      'Ash Warden',
      'Cinder Forest',
      'Spawn boss',
      'Pre-boss save',
      'AshWarden.asset',
      'forest_boss.sav',
    ]) {
      expect(local, `local shows ${secret}`).toContain(secret);
      expect(safe, `llm hides ${secret}`).not.toContain(secret);
    }
    expect(safe).toContain('God mode');
  });
});

describe('edits survive a re-scan', () => {
  it('shows user-edited text after the scanner finds the same entity again', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'tforge-hint-')), 'P.tforge');
    const registry = coreCommands();
    for (const c of knowledgeCommands) registry.register(c);
    const store = await ProjectStore.create(dir, fixture(), { commands: registry, autosaveMs: 0 });
    try {
      // The user edits the extracted boss (making it theirs) and tags a level-load command.
      store.dispatch('core/knowledge.update-entity', {
        id: 'ent_warden',
        patch: { description: 'Use the arena checkpoint' },
      } as never);
      expect(store.state.knowledge.find((e) => e.id === 'ent_warden')!.origin).toBe('user');

      const merged = mergeKnowledge(
        store.state.knowledge,
        'src_repo',
        [
          {
            kind: 'boss',
            name: 'The Ash Warden',
            description: 'rescanned text',
            sourcePaths: ['Assets/Data/Bosses/AshWarden.asset'],
            confidence: 0.9,
          },
        ],
        { taken: collectIds(store.state), referenced: new Set(['ent_warden', 'ent_forest']) },
      );
      const p = { ...store.state, knowledge: merged.knowledge } as Project;
      const hints = buildCaptureHints(plan(p), p.knowledge);
      const boss = hints.flatMap((h) => h.featured).find((f) => f.entityId === 'ent_warden')!;
      expect(boss.detail).toBe('Use the arena checkpoint');
      expect(boss.origin).toBe('user');
      expect(hints.flatMap((h) => names(h.debugCommands))).toContain('Spawn boss');
    } finally {
      await store.close();
    }
  });
});
