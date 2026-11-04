/**
 * The short-form formats a TikTok concept can use. Each id names a storyboard template that
 * task 10.3 builds (`game-trailer/tiktok-<name>`); concepts only choose among these.
 */
export interface TikTokFormat {
  id: string;
  name: string;
  /** One line for the prompt and the pickers. */
  description: string;
  /** Whether the format is built around the developer's voice. */
  voiceLed: boolean;
}

export const TIKTOK_FORMATS: readonly TikTokFormat[] = [
  {
    id: 'game-trailer/tiktok-montage',
    name: 'Hook + gameplay montage',
    description:
      'A one-second hook line, then fast gameplay cuts on the beat, ending on the wishlist call.',
    voiceLed: false,
  },
  {
    id: 'game-trailer/tiktok-voiceover',
    name: 'Dev voiceover',
    description:
      'The developer talks over gameplay, images and clips: a devlog, a story or one clear point.',
    voiceLed: true,
  },
  {
    id: 'game-trailer/tiktok-list',
    name: '"3 things" list',
    description:
      'Three quick facts or features, each one a short clip with a number and a caption.',
    voiceLed: false,
  },
  {
    id: 'game-trailer/tiktok-progress',
    name: 'Before / after',
    description:
      'How something looked or played before and after: art, animation, a mechanic, a boss.',
    voiceLed: false,
  },
  {
    id: 'game-trailer/tiktok-pov',
    name: 'POV / challenge',
    description:
      'The viewer is the player: a dare, a tricky moment or "can you beat this?" with a payoff.',
    voiceLed: false,
  },
  {
    id: 'game-trailer/tiktok-wishlist',
    name: 'Wishlist reveal',
    description:
      'A teaser that holds back one thing and reveals it at the end with the call to action.',
    voiceLed: false,
  },
] as const;

export const TIKTOK_FORMAT_IDS = TIKTOK_FORMATS.map((f) => f.id) as [string, ...string[]];

export function tiktokFormat(id: string): TikTokFormat | undefined {
  return TIKTOK_FORMATS.find((f) => f.id === id);
}
