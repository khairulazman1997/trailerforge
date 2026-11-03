import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { releaseTemplate } from '@trailerforge/pack-game-trailer';
import { Project } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { effectBriefOf } from './convert.js';
import { generateStoryboard } from './generate.js';
import { generationSchemas } from './output.js';

/** M8 8.4c: EffectCraft templates and effect briefs in storyboard generation. */

const NOW = () => new Date('2026-11-03T10:00:00Z');
const MOTION = {
  templates: [
    { id: 'effectcraft/title-reveal', name: 'Title reveal', cardKinds: ['title'] },
    { id: 'effectcraft/logo-sting', name: 'Logo sting', cardKinds: ['logo'] },
  ],
  briefs: true,
};
const shot = (title: string, extra: object = {}) => ({ kind: 'shot', title, seconds: 2, ...extra });
const card = (cardKind: string, extra: object = {}) => ({ kind: 'card', cardKind, title: cardKind, text: 'ASHFALL', seconds: 2, ...extra }); // prettier-ignore
const brief = (text: string) => ({
  effectBrief: { text, why: 'A moment worth a bespoke graphic' },
});

/** Nine slots: the model asks for six motion picks (too many), two of them misplaced. */
const reply = {
  rationale: 'Builds to the title.',
  sections: [
    { name: 'Hook', role: 'hook', slots: [shot('Parry', brief('Sparks burst from the parry')), shot('Dodge'), shot('Combo', { template: { id: 'effectcraft/title-reveal', why: 'not a card' } })] },
    { name: 'Escalation', role: 'escalation', slots: [shot('Forest'), shot('Warden', brief('The boss name slams in')), shot('Fire'), shot('Fall', brief('Embers rise'))] },
    { name: 'End', role: 'end-slate', slots: [card('title', { template: { id: 'effectcraft/title-reveal', why: 'Big reveal' } }), card('date', { template: { id: 'effectcraft/logo-sting', why: 'wrong kind' } })] },
  ],
  music: { direction: 'Hybrid orchestral' },
}; // prettier-ignore

function fresh() {
  const p = sampleProject();
  p.storyboard = null;
  for (const t of p.timelines ?? [])
    for (const k of t.tracks ?? []) for (const i of k.items ?? []) delete i.slotId;
  return Project.parse(p);
}
function setup(r: unknown) {
  const mock = createMockProvider({ 'storyboard.generate': r });
  const llm = new LlmClient({
    providers: (id) => (id === 'core/mock' ? mock : undefined),
    routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
  });
  return { mock, deps: { llm, now: NOW } };
}

describe('motion graphics in the generator', () => {
  it('the schema offers only installed templates, and nothing at all without EffectCraft', () => {
    const base = { transitions: [], effects: [], sounds: [] };
    const doc = (slot: object) => ({ rationale: 'x', sections: [{ name: 'A', slots: [slot] }] });
    const withEc = generationSchemas({ ...base, graphics: MOTION.templates, effectBriefs: true }).GeneratedStoryboard; // prettier-ignore
    const without = generationSchemas(base).GeneratedStoryboard;
    expect(withEc.safeParse(doc(card('title', { template: { id: 'effectcraft/title-reveal', why: 'w' } }))).success).toBe(true); // prettier-ignore
    expect(withEc.safeParse(doc(card('title', { template: { id: 'effectcraft/kinetic-text', why: 'w' } }))).success).toBe(false); // prettier-ignore
    expect(withEc.safeParse(doc(shot('S', brief('x')))).success).toBe(true);
    expect(without.safeParse(doc(card('title', { template: { id: 'effectcraft/title-reveal', why: 'w' } }))).success).toBe(false); // prettier-ignore
    expect(without.safeParse(doc(shot('S', brief('x')))).success).toBe(false);
  });

  it('templates go on fitting cards, briefs on slots, within the 1/3 cap, each with a decision', async () => {
    const { deps, mock } = setup(reply);
    const r = await generateStoryboard({ ...deps, motion: MOTION }, fresh(), { template: releaseTemplate, targetDuration: 30 }); // prettier-ignore
    expect(mock.calls[0]!.prompt).toMatch(/Motion-graphics card templates \(template\.id.*effectcraft\/title-reveal \(Title reveal; for title cards\)/); // prettier-ignore
    expect(mock.calls[0]!.prompt).toMatch(/Custom effect \(effectBrief\)/);
    const slots = r.storyboard.sections.flatMap((s) => s.slots);
    const by = (t: string) => slots.find((s) => s.title === t)!;
    // Cap: 9 slots → 3 with picks: Parry (brief), Combo (misplaced template, dropped), Warden (brief).
    expect(effectBriefOf(by('Parry'))).toEqual({ text: 'Sparks burst from the parry', why: 'A moment worth a bespoke graphic' }); // prettier-ignore
    expect(effectBriefOf(by('Warden'))?.text).toBe('The boss name slams in');
    expect(effectBriefOf(by('Fall'))).toBeUndefined();
    const title = by('title');
    expect(title.kind === 'card' && title.templateId).toBe('core/title-card'); // over the cap
    expect(r.warnings.join('\n')).toMatch(
      /"Combo": effectcraft\/title-reveal cannot draw this shot; left out/,
    );
    expect(r.warnings.join('\n')).toMatch(/kept to 3 of 9/);
    const suggest = r.decisions.filter((d) => d.step === 'core/storyboard-suggest');
    expect(suggest.map((d) => (d.reasons as { what: string }).what).sort()).toEqual(['effect-brief', 'effect-brief']); // prettier-ignore
  });

  it('a template on its own card kind is used; another card kind is refused', async () => {
    const one = {
      ...reply,
      sections: [{ name: 'End', role: 'end-slate', slots: [shot('A'), shot('B'), shot('C'), card('title', { template: { id: 'effectcraft/title-reveal', why: 'Big reveal' } }), card('date', { template: { id: 'effectcraft/logo-sting', why: 'wrong kind' } }), shot('D')] }],
    }; // prettier-ignore
    const { deps } = setup(one);
    const r = await generateStoryboard({ ...deps, motion: MOTION }, fresh(), { template: releaseTemplate, targetDuration: 30 }); // prettier-ignore
    const cards = r.storyboard.sections.flatMap((s) => s.slots).filter((s) => s.kind === 'card');
    expect(cards.map((c) => c.kind === 'card' && c.templateId)).toEqual(['effectcraft/title-reveal', 'core/date-card']); // prettier-ignore
    expect(r.warnings.join('\n')).toMatch(/effectcraft\/logo-sting cannot draw this date card/);
  });

  it('without EffectCraft, generation is exactly what it was', async () => {
    const plain = { ...reply, sections: reply.sections.map((s) => ({ ...s, slots: s.slots.map(({ effectBrief: _b, template: _t, ...rest }: Record<string, unknown>) => rest) })) }; // prettier-ignore
    const a = setup(plain);
    const b = setup(plain);
    const ra = await generateStoryboard(a.deps, fresh(), {
      template: releaseTemplate,
      targetDuration: 30,
    });
    const rb = await generateStoryboard({ ...b.deps, motion: { templates: [], briefs: false } }, fresh(), { template: releaseTemplate, targetDuration: 30 }); // prettier-ignore
    expect(a.mock.calls[0]!.prompt).toBe(b.mock.calls[0]!.prompt);
    expect(a.mock.calls[0]!.prompt).not.toMatch(/effectBrief|Motion-graphics/);
    expect(rb.storyboard).toEqual(ra.storyboard);
  });
});
