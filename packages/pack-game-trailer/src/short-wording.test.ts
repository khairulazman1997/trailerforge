import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { Project, type Short } from '@trailerforge/schema';
import { sampleShortProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { fillShortWording, rebuildShortStoryboard, type GeneratedWording } from './index.js';

const client = (reply: unknown) => {
  const mock = createMockProvider({ 'tiktok.wording': reply as never });
  const llm = new LlmClient({
    providers: (id) => (id === 'core/mock' ? mock : undefined),
    routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
  });
  return { mock, llm };
};

function setup(mutate: (p: Project) => void = () => {}) {
  const p = Project.parse(sampleShortProject());
  mutate(p);
  const base = p.shorts[0]!;
  const concept = { ...base.concept, formatId: 'game-trailer/tiktok-voiceover' };
  const built = rebuildShortStoryboard({ short: { ...base, concept, storyboard: null } });
  const short: Short = { ...base, concept, storyboard: built.storyboard };
  return { p, short, ids: built.rebuilt };
}
const slotsOf = (sb: Short['storyboard']) => sb!.sections.flatMap((s) => s.slots);

describe('fillShortWording', () => {
  it('rewrites the words of the listed slots and nothing else', async () => {
    const { p, short, ids } = setup();
    const reply: GeneratedWording = {
      slots: [
        { key: 'slot-1', title: '  The parry  ', captureInstruction: 'Parry the Ash Warden at its tell.', captionText: 'One tell. One chance.' }, // prettier-ignore
        { key: 'slot-3', title: 'Key art', captureInstruction: 'Show the key art.' },
        { key: 'slot-99', title: 'No such slot' },
      ],
    };
    const { llm, mock } = client(reply);
    const r = await fillShortWording({ llm }, p, short, { slotIds: ids });
    const after = slotsOf(r.storyboard);
    const before = slotsOf(short.storyboard);
    expect(r.changed).toEqual([before[0]!.id, before[2]!.id]);
    expect(after[0]).toMatchObject({ title: 'The parry', captureInstruction: 'Parry the Ash Warden at its tell.' }); // prettier-ignore
    expect(after[0]!.kind === 'shot' && after[0]!.overlays[0]!.text).toBe('One tell. One chance.');
    // Structure, ids, durations and every other slot are untouched; wording is not a hand edit.
    expect(after.map((x) => [x.id, x.duration])).toEqual(before.map((x) => [x.id, x.duration]));
    expect(after[1]).toEqual(before[1]);
    expect(after[0]!.extensions).toEqual({});
    expect(mock.calls[0]!.prompt).toContain('"key": "slot-1"');
    expect(mock.calls[0]!.prompt).toContain('A boss swing stops dead');
  });

  it('sends only the slots asked for, and only by key (no ids)', async () => {
    const { p, short, ids } = setup();
    const { llm, mock } = client({ slots: [] });
    const r = await fillShortWording({ llm }, p, short, { slotIds: ids.slice(0, 2) });
    expect(r.storyboard).toBe(short.storyboard);
    const prompt = mock.calls[0]!.prompt;
    expect(prompt).toContain('slot-2');
    expect(prompt).not.toContain('slot-3');
    expect(prompt).not.toContain(ids[0]);
    const none = await fillShortWording({ llm }, p, short, { slotIds: [] });
    expect(none.changed).toEqual([]);
    expect(mock.calls).toHaveLength(1);
  });

  it('ignores fields that do not fit the slot, run too long, or mention excluded knowledge', async () => {
    const { p, short, ids } = setup((pr) => {
      pr.knowledge.find((e) => e.id === 'ent_warden')!.excludedFromLlm = true;
    });
    const cards = slotsOf(short.storyboard).filter((x) => x.kind === 'card');
    const cardIdx = slotsOf(short.storyboard).findIndex((x) => x.kind === 'card') + 1;
    const { llm, mock } = client({
      slots: [
        { key: 'slot-1', title: 'x'.repeat(60), captureInstruction: 'Film the Ash Warden.', text: 'wrong kind' }, // prettier-ignore
        { key: 'slot-2', title: 'Fine title', captionText: 'one two three four five six seven eight nine' }, // prettier-ignore
        { key: `slot-${cardIdx}`, text: 'Wishlist Ember Knight', title: 'cards have no title' },
      ],
    });
    const r = await fillShortWording({ llm }, p, short, { slotIds: ids });
    expect(cards).toHaveLength(1);
    expect(r.ignored.map((i) => [i.field, i.reason])).toEqual([
      ['title', 'too long'],
      ['captureInstruction', 'mentions knowledge excluded from AI use'],
      ['text', 'a shot has no text'],
      ['captionText', 'too long'],
      ['title', 'a card has no title'],
    ]);
    const after = slotsOf(r.storyboard);
    expect(after[1]!.title).toBe('Fine title');
    const card = after.find((x) => x.kind === 'card');
    expect(card?.kind === 'card' && card.text).toBe('Wishlist Ember Knight');
    expect(mock.calls[0]!.prompt).not.toMatch(/Ash Warden|ent_warden/);
  });

  it('leaves list numbers alone and keeps a hand-set caption out of the prompt when it is a number', async () => {
    const base = Project.parse(sampleShortProject());
    const concept = { ...base.shorts[0]!.concept, formatId: 'game-trailer/tiktok-list' };
    const built = rebuildShortStoryboard({
      short: { ...base.shorts[0]!, concept, storyboard: null },
    });
    const short: Short = { ...base.shorts[0]!, concept, storyboard: built.storyboard };
    const item = slotsOf(short.storyboard).findIndex((x) => x.id.endsWith('_item1'));
    const { llm, mock } = client({
      slots: [{ key: `slot-${item + 1}`, captionText: 'ninety-nine' }],
    });
    const r = await fillShortWording({ llm }, base, short, { slotIds: built.rebuilt });
    expect(r.changed).toEqual([]);
    expect(mock.calls[0]!.prompt).not.toContain('"caption": "1"');
    const s = slotsOf(r.storyboard)[item]!;
    expect(s.kind === 'shot' && s.overlays[0]!.text).toBe('1');
  });

  it('needs a template, and stops when cancelled', async () => {
    const { p, short } = setup();
    const { llm, mock } = client({ slots: [] });
    await expect(fillShortWording({ llm }, p, { ...short, storyboard: null }, { slotIds: [] })).rejects.toThrow(/no template/); // prettier-ignore
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      fillShortWording({ llm }, p, short, { slotIds: [slotsOf(short.storyboard)[0]!.id], signal: ctl.signal }), // prettier-ignore
    ).rejects.toThrow();
    expect(mock.calls).toHaveLength(0);
  });
});
