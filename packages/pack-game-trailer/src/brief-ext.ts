import { z } from 'zod';

export const PACK_ID = 'game-trailer';

export const GAME_PLATFORMS = [
  'PC (Steam)',
  'PC (Epic)',
  'PlayStation 5',
  'Xbox Series X|S',
  'Nintendo Switch 2',
  'Nintendo Switch',
  'iOS',
  'Android',
  'macOS',
  'Steam Deck',
] as const;

export const GENRES = [
  'Action',
  'Action RPG',
  'Soulslike',
  'Shooter',
  'Platformer',
  'Metroidvania',
  'Roguelike',
  'Strategy',
  'City builder',
  'Simulation',
  'Cozy / Life sim',
  'Puzzle',
  'Horror',
  'Adventure',
  'Racing',
  'Sports',
  'Fighting',
] as const;

export const TONES = [
  'Epic',
  'Intense',
  'Dark',
  'Mysterious',
  'Emotional',
  'Whimsical',
  'Cozy',
  'Funny',
  'Retro',
  'Stylish',
] as const;

export const CALLS_TO_ACTION = [
  'Wishlist on Steam',
  'Buy now',
  'Pre-order now',
  'Play free now',
  'Join the playtest',
] as const;

/**
 * Game-specific brief fields, stored at `brief.extensions["game-trailer"]`. Values are free
 * strings (the lists above are suggestions) so unusual platforms or genres still fit.
 */
export const GameBriefExt = z.strictObject({
  genre: z.string().min(1).optional(),
  gamePlatforms: z.array(z.string().min(1)).default([]),
  /** When there is no exact date yet, e.g. "Q2 2027" or "Early Access 2027". */
  releaseWindow: z.string().min(1).optional(),
  /** Age rating, e.g. "ESRB T", "PEGI 16"; official badge art comes from the rating board's kit. */
  ageRating: z.string().min(1).optional(),
  steamAppId: z.string().regex(/^\d+$/, 'Steam app ids are numeric').optional(),
  multiplayer: z.enum(['single-player', 'co-op', 'pvp', 'mmo']).optional(),
  artStyle: z.string().optional(),
});
export type GameBriefExt = z.infer<typeof GameBriefExt>;
