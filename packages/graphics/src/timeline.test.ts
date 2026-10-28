import { Project } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { builtinRegistry } from './builtin/index.js';
import { renderSvg } from './template.js';
import { timelineScenes } from './timeline.js';

const timeline = () => {
  const tl = Project.parse(sampleProject()).timelines[0]!;
  tl.tracks.push({
    id: 'trk_cap',
    kind: 'caption',
    name: 'Captions',
    muted: false,
    locked: false,
    transitions: [],
    items: [
      {
        id: 'cap_name',
        kind: 'caption',
        start: 2 * 705_600_000,
        duration: 705_600_000,
        text: 'The Ash Warden',
        styleId: 'core/lower-third',
        extensions: {},
      },
      {
        id: 'cap_plain',
        kind: 'caption',
        start: 3 * 705_600_000,
        duration: 705_600_000,
        text: 'Parry to counter',
        styleId: 'core/title-card', // a card, not an overlay: the plain caption is used
        extensions: {},
      },
    ],
  });
  return tl;
};

describe('timelineScenes', () => {
  it('builds a scene per card and caption, in time order, sized to the timeline', () => {
    const { scenes, warnings } = timelineScenes({
      timeline: timeline(),
      templates: builtinRegistry(),
      brand: null,
    });
    expect(warnings).toEqual([]);
    expect(scenes.map((s) => [s.itemId, s.templateId])).toEqual([
      ['cap_name', 'core/lower-third'],
      ['cap_plain', 'core/caption'],
      ['it_end', 'core/end-slate'],
    ]);
    for (const s of scenes) {
      expect(s.scene.size).toEqual({ width: 1920, height: 1080 });
      expect(s.scene.duration).toBe(s.duration);
    }
    expect(renderSvg(scenes[0]!.scene, 705_600_000 / 2)).toContain('The Ash Warden');
  });

  it('skips an item whose template is not installed, with a warning', () => {
    const tl = timeline();
    const end = tl.tracks[0]!.items.find((i) => i.id === 'it_end')!;
    if (end.kind === 'graphic') end.templateId = 'acme/gone';
    const { scenes, warnings } = timelineScenes({
      timeline: tl,
      templates: builtinRegistry(),
      brand: null,
    });
    expect(scenes.map((s) => s.itemId)).toEqual(['cap_name', 'cap_plain']);
    expect(warnings).toEqual([expect.stringMatching(/acme\/gone.*not installed/)]);
  });
});
