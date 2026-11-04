import {
  createChatHandoffProvider,
  createMockProvider,
  LlmClient,
  LlmConsentError,
  RoutesConfig,
} from '@trailerforge/llm';
import type { LlmProvider } from '@trailerforge/plugin-api';
import { Project } from '@trailerforge/schema';
import { sampleProject, sampleShortProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import {
  generateConcepts,
  TIKTOK_FORMAT_IDS,
  tiktokFormat,
  vetConcepts,
  type RawConceptInput,
} from './index.js';

function clientFor(provider: LlmProvider, approveSend?: () => boolean) {
  return new LlmClient({
    providers: (id) => (id === provider.id ? provider : undefined),
    routes: RoutesConfig.parse({ default: { provider: provider.id }, fallbacks: [] }),
    ...(approveSend ? { approveSend } : {}),
  });
}

const raw = (o: Partial<RawConceptInput> = {}): RawConceptInput => ({
  title: 'Parry the Ash Warden',
  hook: 'A boss swing stops dead on a perfect parry.',
  formatId: 'game-trailer/tiktok-montage',
  pitch: 'The parry is what sets Ember Knight apart.',
  shotList: ['A perfect parry on the Ash Warden', 'The key art'],
  voiceover: [],
  targetSeconds: 20,
  entityIds: ['ent_warden'],
  ...o,
});

const project = () => Project.parse(sampleProject());
const excluding = (id: string) => {
  const p = project();
  p.knowledge.find((e) => e.id === id)!.excludedFromLlm = true;
  return p;
};

describe('formats', () => {
  it('six formats with unique ids that 10.3 will build templates for', () => {
    expect(TIKTOK_FORMAT_IDS).toHaveLength(6);
    expect(new Set(TIKTOK_FORMAT_IDS).size).toBe(6);
    expect(tiktokFormat('game-trailer/tiktok-voiceover')?.voiceLed).toBe(true);
    expect(tiktokFormat('game-trailer/nope')).toBeUndefined();
  });
});

describe('vetConcepts', () => {
  it('accepts a good concept, trimmed and without id or time, with the source it was given', () => {
    const r = vetConcepts(project(), [raw({ title: '  Parry  ', shotList: [' a ', ''] })], {
      source: 'claude-code',
      strictEntities: true,
    });
    expect(r.rejected).toEqual([]);
    expect(r.concepts).toEqual([
      {
        source: 'claude-code',
        title: 'Parry',
        hook: 'A boss swing stops dead on a perfect parry.',
        formatId: 'game-trailer/tiktok-montage',
        pitch: 'The parry is what sets Ember Knight apart.',
        shotList: ['a'],
        voiceover: [],
        targetSeconds: 20,
        entityIds: ['ent_warden'],
      },
    ]);
  });

  it('rejects, with reasons to act on: unknown format, bad shape, over-long or empty text', () => {
    const r = vetConcepts(
      project(),
      [
        raw({ formatId: 'game-trailer/tiktok-dance' }),
        { title: 'No hook' },
        raw({ hook: '   ' }),
        raw({ targetSeconds: 400 }),
        raw({ shotList: Array(13).fill('x') }),
      ],
      { source: 'claude-code', strictEntities: true },
    );
    expect(r.concepts).toEqual([]);
    expect(r.rejected.map((x) => x.index)).toEqual([0, 1, 2, 3, 4]);
    expect(r.rejected[0]!.reasons[0]).toMatch(/unknown format "game-trailer\/tiktok-dance"; use one of game-trailer\/tiktok-montage/); // prettier-ignore
    expect(r.rejected[1]).toMatchObject({ title: 'No hook' });
    expect(r.rejected[1]!.reasons.join()).toMatch(/hook/);
  });

  it('strict mode rejects facts that are not in the knowledge; lenient mode drops them with a warning', () => {
    const bad = raw({ entityIds: ['ent_warden', 'ent_made_up'] });
    const strict = vetConcepts(project(), [bad], { source: 'claude-code', strictEntities: true });
    expect(strict.rejected[0]!.reasons[0]).toMatch(/not in the game knowledge: ent_made_up/);
    const lenient = vetConcepts(project(), [bad], { source: 'app', strictEntities: false });
    expect(lenient.concepts[0]!.entityIds).toEqual(['ent_warden']);
    expect(lenient.warnings[0]).toMatch(/ent_made_up/);
  });

  it('refuses facts excluded from AI use, by id and by name in the text', () => {
    const p = excluding('ent_warden');
    const byId = vetConcepts(p, [raw()], { source: 'claude-code', strictEntities: true });
    expect(byId.rejected[0]!.reasons.join()).toMatch(/not in the game knowledge: ent_warden/);
    const byName = vetConcepts(p, [raw({ entityIds: [], pitch: 'Fight the Ash Warden!' })], {
      source: 'claude-code',
      strictEntities: true,
    });
    expect(byName.rejected[0]!.reasons).toEqual([
      'mentions something excluded from AI use in the game knowledge',
    ]);
  });

  it('skips titles that exist already (waiting concepts, shorts) or repeat in the batch', () => {
    const p = Project.parse(sampleShortProject());
    const r = vetConcepts(
      p,
      [raw({ title: 'parry OR die!' }), raw({ title: 'Parry or die' }), raw({ title: 'Fresh' }), raw({ title: 'fresh' })], // prettier-ignore
      { source: 'app', strictEntities: false },
    );
    expect(r.concepts.map((c) => c.title)).toEqual(['Fresh']);
    expect(r.rejected.map((x) => x.reasons[0])).toEqual([
      'a concept with this title already exists',
      'a concept with this title already exists',
      'a concept with this title already exists',
    ]);
  });
});

describe('generateConcepts', () => {
  const reply = (concepts: RawConceptInput[]) => ({ concepts });

  it('asks for the right number, sends the ideas, formats and facts, and returns vetted concepts', async () => {
    const mock = createMockProvider({
      'tiktok.concepts': reply([
        raw(),
        raw({ title: 'Dev talks parry', formatId: 'game-trailer/tiktok-voiceover', voiceover: ['This boss has one tell.'] }), // prettier-ignore
      ]),
    });
    const r = await generateConcepts({ llm: clientFor(mock) }, project(), {
      ideas: ['  show the boss in 3 s ', ''],
      count: 2,
    });
    expect(r.concepts.map((c) => [c.source, c.title])).toEqual([
      ['app', 'Parry the Ash Warden'],
      ['app', 'Dev talks parry'],
    ]);
    expect(r.provider).toBe('core/mock');
    const prompt = mock.calls[0]!.prompt;
    expect(prompt).toContain('Suggest 2 different concepts');
    expect(prompt).toContain('- show the boss in 3 s');
    expect(prompt).toContain('game-trailer/tiktok-voiceover: Dev voiceover');
    expect(prompt).toContain('ent_warden: boss: The Ash Warden');
    expect(prompt).toContain('Ember Knight');
  });

  it('lists the concepts that exist, clamps the count and takes no ideas', async () => {
    const mock = createMockProvider({ 'tiktok.concepts': reply([]) });
    await generateConcepts({ llm: clientFor(mock) }, Project.parse(sampleShortProject()), { count: 99 }); // prettier-ignore
    const prompt = mock.calls[0]!.prompt;
    expect(prompt).toContain('Suggest 10 different');
    expect(prompt).toContain('- Parry or die');
    expect(prompt).toContain('(none; choose the strongest angles)');
  });

  it('never sends knowledge excluded from AI use, not even in the developer’s ideas', async () => {
    const mock = createMockProvider({ 'tiktok.concepts': reply([]) });
    await generateConcepts({ llm: clientFor(mock) }, excluding('ent_warden'), {
      ideas: ['Show the Ash Warden boss fight'],
    });
    const prompt = mock.calls[0]!.prompt;
    expect(prompt).not.toMatch(/Ash Warden|ent_warden/);
    expect(prompt).toContain('Show [redacted] boss fight');
    expect(prompt).toContain('ent_forest: level: Cinder Forest');
  });

  it('drops what the model writes that mentions an excluded fact or repeats a title', async () => {
    const mock = createMockProvider({
      'tiktok.concepts': reply([raw({ entityIds: [], title: 'Leaky', pitch: 'The Ash Warden!' }), raw({ title: 'Fine', entityIds: [], shotList: ['A parry'] })]), // prettier-ignore
    });
    const r = await generateConcepts({ llm: clientFor(mock) }, excluding('ent_warden'));
    expect(r.concepts.map((c) => c.title)).toEqual(['Fine']);
    expect(r.rejected.map((x) => x.title)).toEqual(['Leaky']);
  });

  it('a model reply with a format outside the built-in set is repaired or fails as a whole', async () => {
    const mock = createMockProvider({
      'tiktok.concepts': [reply([raw({ formatId: 'game-trailer/tiktok-dance' })]), reply([raw()])],
    });
    const r = await generateConcepts({ llm: clientFor(mock) }, project());
    expect(r.concepts).toHaveLength(1);
    expect(mock.calls).toHaveLength(2);
  });

  it('asks before sending when the provider is off-device, and sends nothing on a no', async () => {
    const mock = createMockProvider({ 'tiktok.concepts': reply([raw()]) });
    const offDevice = { ...mock, sendsDataOffDevice: true };
    await expect(
      generateConcepts({ llm: clientFor(offDevice, () => false) }, project()),
    ).rejects.toBeInstanceOf(LlmConsentError);
    expect(mock.calls).toHaveLength(0);
  });

  it('works through chat handoff', async () => {
    const handoff = createChatHandoffProvider({
      request: async () => JSON.stringify({ concepts: [raw()] }),
    });
    const r = await generateConcepts({ llm: clientFor(handoff) }, project());
    expect(r.concepts).toHaveLength(1);
  });

  it('stops when cancelled', async () => {
    const mock = createMockProvider({ 'tiktok.concepts': reply([raw()]) });
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      generateConcepts({ llm: clientFor(mock) }, project(), { signal: ctl.signal }),
    ).rejects.toThrow();
    expect(mock.calls).toHaveLength(0);
  });
});
