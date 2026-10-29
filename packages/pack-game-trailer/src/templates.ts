import type { StoryboardTemplate } from '@trailerforge/plugin-api';
import type { CardSlot, Section, ShotSlot, Storyboard } from '@trailerforge/schema';
import type { z } from 'zod';

type StoryboardInput = z.input<typeof Storyboard>;
type SlotInput = z.input<typeof ShotSlot> | z.input<typeof CardSlot>;

interface SlotSpec {
  id: string;
  /** Relative share of the trailer's running time. */
  weight: number;
  /** Slot only appears when the target duration is at least this many seconds. */
  from?: number | undefined;
  /** Slots that appear only in longer cuts are `nice`, so they can be dropped for short variants. */
  priority?: 'must' | 'nice';
  build(duration: SlotInput['duration'], priority: 'must' | 'nice'): SlotInput;
}

interface SectionSpec {
  id: string;
  name: string;
  role: string;
  purpose: string;
  slots: SlotSpec[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

const shot = (
  id: string,
  title: string,
  purpose: string,
  capture: string,
  extra: Partial<z.input<typeof ShotSlot>> = {},
  weight = 1,
  from?: number,
): SlotSpec => ({
  id,
  weight,
  from,
  priority: from === undefined ? 'must' : 'nice',
  build: (duration, priority) => ({
    id,
    kind: 'shot',
    title,
    purpose,
    duration,
    priority,
    captureInstruction: capture,
    ...extra,
  }),
});

const card = (
  id: string,
  cardKind: z.input<typeof CardSlot>['cardKind'],
  templateId: string,
  title: string,
  purpose: string,
  weight: number,
  from?: number,
): SlotSpec => ({
  id,
  weight,
  from,
  priority: from === undefined ? 'must' : 'nice',
  build: (duration, priority) => ({
    id,
    kind: 'card',
    cardKind,
    templateId,
    title,
    purpose,
    duration,
    priority,
  }),
});

/**
 * Turn a section spec list into a storyboard whose slot `ideal` durations sum exactly to the
 * target. Weights are normalised over the slots that survive the `from` filter; rounding drift
 * lands on the last slot so the total is exact.
 */
function assemble(
  videoTypeId: string,
  templateId: string,
  specs: SectionSpec[],
  targetDuration: number,
  music: string,
): StoryboardInput {
  if (!(targetDuration > 0)) throw new RangeError('targetDuration must be positive');
  const active = specs
    .map((s) => ({
      ...s,
      slots: s.slots.filter((x) => x.from === undefined || targetDuration >= x.from),
    }))
    .filter((s) => s.slots.length > 0);
  const totalWeight = active.reduce((a, s) => a + s.slots.reduce((b, x) => b + x.weight, 0), 0);
  const flat = active.flatMap((s) => s.slots);
  const ideals = flat.map((x) => round1((x.weight / totalWeight) * targetDuration));
  const drift = round1(targetDuration - ideals.reduce((a, b) => a + b, 0));
  ideals[ideals.length - 1] = round1(ideals[ideals.length - 1]! + drift);

  let i = 0;
  const sections: z.input<typeof Section>[] = active.map((s) => ({
    id: s.id,
    name: s.name,
    role: s.role,
    purpose: s.purpose,
    slots: s.slots.map((x) => {
      const ideal = ideals[i++]!;
      return x.build(
        { min: round1(ideal * 0.7), ideal, max: round1(ideal * 1.4) },
        x.priority ?? 'must',
      );
    }),
  }));

  return {
    id: 'sb_main',
    meta: { videoTypeId, templateId, targetDuration },
    sections,
    music: { direction: music, structure: [], hitPoints: [], sfxCues: [] },
  };
}

const PACK = 'game-trailer';

const releaseSections: SectionSpec[] = [
  {
    id: 'sec_hook',
    name: 'Hook',
    role: 'hook',
    purpose: 'Win the first 3 seconds with the strongest, most readable moment',
    slots: [
      shot(
        'hook_shot',
        'Opening hook',
        'Strongest single moment, no context needed',
        'Capture the most spectacular, instantly readable beat of the game.',
        { hud: 'off' },
        1.5,
      ),
    ],
  },
  {
    id: 'sec_world',
    name: 'World and premise',
    role: 'setup',
    purpose: 'Establish setting, tone and what the player does',
    slots: [
      shot(
        'world_establishing',
        'Establishing vista',
        'Show the world at scale',
        'Slow camera over a signature location.',
        { hud: 'off', framing: 'wide' },
        2,
      ),
      shot(
        'world_premise',
        'Premise beat',
        'Who you are and what you face',
        'Show the protagonist facing the central threat.',
        {},
        2,
        45,
      ),
    ],
  },
  {
    id: 'sec_gameplay',
    name: 'Gameplay escalation',
    role: 'escalation',
    purpose: 'Show the core loop, then raise the stakes with variety',
    slots: [
      shot(
        'gameplay_core',
        'Core loop',
        'The mechanic the game is about',
        'Play the core mechanic cleanly in a readable situation.',
        {},
        3,
      ),
      shot(
        'gameplay_variety',
        'Variety montage',
        'Breadth of features',
        'Short clips of distinct systems, locations and enemies.',
        {},
        3,
      ),
      shot(
        'gameplay_boss',
        'Big encounter',
        'Spectacle and scale',
        'Record the most dramatic set-piece or boss fight.',
        {},
        3,
        60,
      ),
      shot(
        'gameplay_progression',
        'Progression and customisation',
        'Depth beyond the first hour',
        'Show upgrades, loadouts or builds.',
        {},
        2,
        75,
      ),
    ],
  },
  {
    id: 'sec_proof',
    name: 'Accolades',
    role: 'social-proof',
    purpose: 'Press quotes and awards that justify buying now',
    slots: [
      card(
        'proof_laurels',
        'laurels',
        'core/laurels-card',
        'Accolades',
        'Press quotes or awards',
        1.5,
        45,
      ),
    ],
  },
  {
    id: 'sec_climax',
    name: 'Climax',
    role: 'climax',
    purpose: 'Peak intensity on the music drop',
    slots: [
      shot(
        'climax_shot',
        'Peak moment',
        'Highest-energy sequence',
        'Fast, high-impact gameplay that pays off the build.',
        {},
        2.5,
      ),
    ],
  },
  {
    id: 'sec_end',
    name: 'End slate',
    role: 'end-slate',
    purpose: 'Name, date, platforms and a buy call to action',
    slots: [
      card(
        'end_title',
        'title',
        'core/title-card',
        'Title card',
        'Game name over the key art',
        1.5,
      ),
      card(
        'end_date',
        'date',
        'core/date-card',
        'Release date and platforms',
        'When and where',
        1.5,
      ),
      card(
        'end_cta',
        'cta',
        'core/cta-card',
        'Buy call to action',
        'Store link or wishlist button',
        1.5,
      ),
    ],
  },
];

const announcementSections: SectionSpec[] = [
  {
    id: 'sec_hook',
    name: 'Cold open',
    role: 'hook',
    purpose: 'Create intrigue without explaining everything',
    slots: [
      shot(
        'hook_shot',
        'Intriguing opening',
        'A single striking image or beat',
        'Capture a mysterious or striking moment in the world.',
        { hud: 'off' },
        2,
      ),
    ],
  },
  {
    id: 'sec_world',
    name: 'World reveal',
    role: 'setup',
    purpose: 'Sell the setting and tone',
    slots: [
      shot(
        'world_vista',
        'World vista',
        'Scale and atmosphere',
        'Slow camera over a signature location.',
        { hud: 'off', framing: 'wide' },
        3,
      ),
      shot(
        'world_character',
        'Character or creature',
        'Introduce who or what lives here',
        'Present the protagonist or a signature creature.',
        { hud: 'off' },
        2,
        45,
      ),
    ],
  },
  {
    id: 'sec_hook2',
    name: 'The hook',
    role: 'escalation',
    purpose: 'One clear thing that makes this game different',
    slots: [
      shot(
        'hook_mechanic',
        'Signature mechanic',
        'The differentiator',
        'Show the mechanic that sets the game apart.',
        {},
        3,
      ),
      shot(
        'hook_escalation',
        'Escalation',
        'Raise the stakes',
        'Intensify: bigger enemies, bigger spaces, faster action.',
        {},
        2,
        60,
      ),
    ],
  },
  {
    id: 'sec_reveal',
    name: 'Title reveal',
    role: 'title-reveal',
    purpose: 'Land the name on the music hit',
    slots: [card('reveal_title', 'title', 'core/title-card', 'Title reveal', 'Game name', 1.5)],
  },
  {
    id: 'sec_end',
    name: 'End slate',
    role: 'end-slate',
    purpose: 'Where to follow the game and any known window',
    slots: [
      card(
        'end_window',
        'date',
        'core/date-card',
        'Release window',
        'Window or "coming soon", with platforms',
        1,
        30,
      ),
      card('end_cta', 'cta', 'core/cta-card', 'Wishlist call to action', 'Wishlist now', 1.5),
    ],
  },
];

const gameplaySections: SectionSpec[] = [
  {
    id: 'sec_intro',
    name: 'Intro',
    role: 'hook',
    purpose: 'Show what the game is within seconds',
    slots: [
      card('intro_title', 'title', 'core/title-card', 'Title card', 'Game name', 1),
      shot(
        'intro_overview',
        'Moment-to-moment overview',
        'Orient the viewer in real play',
        'Record a clean few seconds of typical play.',
        {},
        2,
      ),
    ],
  },
  {
    id: 'sec_loop',
    name: 'Core loop',
    role: 'core-loop',
    purpose: 'Explain the main loop with real footage',
    slots: [
      shot(
        'loop_action',
        'Primary action',
        'The thing you do most',
        'Perform the main action repeatedly in a readable setting.',
        {},
        4,
      ),
      shot(
        'loop_reward',
        'Reward and feedback',
        'Why it feels good',
        'Show feedback, loot or progress after the action.',
        {},
        2,
      ),
    ],
  },
  {
    id: 'sec_systems',
    name: 'Systems and depth',
    role: 'systems',
    purpose: 'Show the breadth of mechanics',
    slots: [
      shot(
        'systems_one',
        'System A',
        'First supporting system',
        'Demonstrate a supporting mechanic, e.g. crafting, abilities or building.',
        {},
        3,
        45,
      ),
      shot(
        'systems_two',
        'System B',
        'Second supporting system',
        'Demonstrate another supporting mechanic.',
        {},
        3,
        45,
      ),
      shot(
        'systems_progression',
        'Progression',
        'Long-term growth',
        'Show upgrades, skill trees or builds.',
        {},
        3,
      ),
      shot(
        'systems_variety',
        'Variety',
        'Different locations and challenges',
        'Cover distinct environments and enemy types.',
        {},
        3,
        75,
      ),
    ],
  },
  {
    id: 'sec_climax',
    name: 'Showcase',
    role: 'climax',
    purpose: 'Finish with the most impressive gameplay',
    slots: [
      shot(
        'climax_shot',
        'Showcase sequence',
        'Highest-skill, highest-spectacle play',
        'Record the best combo, boss or set-piece.',
        {},
        3,
      ),
    ],
  },
  {
    id: 'sec_end',
    name: 'End slate',
    role: 'end-slate',
    purpose: 'Platforms and where to learn more',
    slots: [
      card('end_cta', 'cta', 'core/cta-card', 'Closing card', 'Platforms and store link', 1.5),
    ],
  },
];

const customSections: SectionSpec[] = [
  {
    id: 'sec_hook',
    name: 'Opening',
    role: 'hook',
    purpose: 'Grab attention and say what this video is about',
    slots: [
      shot(
        'hook_shot',
        'Opening shot',
        'The moment that sets up this video',
        'Capture the moment that best opens this video.',
      ),
    ],
  },
  {
    id: 'sec_body',
    name: 'Main part',
    role: 'body',
    purpose: 'What the video is for',
    slots: [
      shot(
        'body_1',
        'Main beat 1',
        'First thing to show',
        'Capture the first thing to show.',
        {},
        2,
      ),
      shot('body_2', 'Main beat 2', 'Second thing to show', 'Capture the second thing.', {}, 2),
      shot('body_3', 'Main beat 3', 'Third thing to show', 'Capture the third thing.', {}, 2, 30),
      shot('body_4', 'Main beat 4', 'More to show', 'Capture one more strong moment.', {}, 2, 60),
    ],
  },
  {
    id: 'sec_end',
    name: 'Ending',
    role: 'end-slate',
    purpose: 'Name the game and what to do next',
    slots: [card('end_title', 'title', 'core/title-card', 'Closing card', 'Game name', 1.5)],
  },
];

const make = (
  id: string,
  videoTypeId: string,
  name: string,
  description: string,
  specs: SectionSpec[],
  music: string,
  flexible = false,
): StoryboardTemplate => ({
  id,
  videoTypeId,
  name,
  description,
  ...(flexible ? { flexible } : {}),
  build: ({ targetDuration }) => assemble(videoTypeId, id, specs, targetDuration, music),
});

export const releaseTemplate = make(
  `${PACK}/tpl-release`,
  `${PACK}/release-trailer`,
  'Release trailer',
  'Hook, world, escalating gameplay, accolades, climax, then title, date and buy CTA.',
  releaseSections,
  'Cinematic build with a clear drop at the climax; short silence before the title card.',
);

export const announcementTemplate = make(
  `${PACK}/tpl-announcement`,
  `${PACK}/announcement-trailer`,
  'Announcement trailer',
  'Cold open, world reveal, one hook, title reveal on the hit, wishlist CTA.',
  announcementSections,
  'Atmospheric opening that builds to a single hit for the title reveal.',
);

export const gameplayTemplate = make(
  `${PACK}/tpl-gameplay`,
  `${PACK}/gameplay-trailer`,
  'Gameplay trailer',
  'Overview, core loop, supporting systems, showcase, closing card.',
  gameplaySections,
  'Steady rhythmic track; cut on the beat, stay out of the way of gameplay audio.',
);

export const customTemplate = make(
  `${PACK}/tpl-custom`,
  `${PACK}/custom`,
  'Something else',
  'A loose start (opening, main part, ending) that the model reshapes to the description.',
  customSections,
  'Music that suits the description; cut on the beat.',
  true,
);

export const storyboardTemplates = [
  releaseTemplate,
  announcementTemplate,
  gameplayTemplate,
  customTemplate,
];
