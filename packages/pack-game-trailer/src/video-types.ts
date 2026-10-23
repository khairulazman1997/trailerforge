import type { BriefRequirement, VideoTypeDef } from '@trailerforge/plugin-api';
import { CALLS_TO_ACTION, GAME_PLATFORMS, GENRES, TONES } from './brief-ext.js';

const ext = (field: string) => `brief.extensions.game-trailer.${field}`;

const r = {
  title: {
    field: 'brief.title',
    label: 'Game name',
    help: 'As it should appear on the title card',
  },
  release: {
    field: 'brief.keyDates[label=Release].date',
    label: 'Release date',
    anyOf: [ext('releaseWindow')],
    input: 'date',
    help: 'An exact date, or a window like "Q2 2027" if it is not announced yet',
  },
  platforms: {
    field: ext('gamePlatforms'),
    label: 'Platforms',
    input: 'multi-choice',
    minItems: 1,
    choices: [...GAME_PLATFORMS],
  },
  genre: { field: ext('genre'), label: 'Genre', input: 'choice', choices: [...GENRES] },
  tone: {
    field: 'brief.tone',
    label: 'Tone',
    input: 'multi-choice',
    minItems: 1,
    choices: [...TONES],
  },
  cta: {
    field: 'brief.callToAction',
    label: 'Call to action',
    input: 'choice',
    choices: [...CALLS_TO_ACTION],
  },
  formats: {
    field: 'formatTargets',
    label: 'Output formats and length',
    input: 'multi-choice',
    minItems: 1,
    help: 'Pick at least one deliverable, e.g. YouTube 16:9 60 s or TikTok 9:16 30 s',
  },
  audience: {
    field: 'brief.audience',
    label: 'Target audience',
    required: false,
    input: 'long-text',
  },
  quotes: {
    field: 'brief.pressQuotes',
    label: 'Press quotes or accolades',
    required: false,
    input: 'list',
    weight: 0.5,
  },
  store: {
    field: 'brief.links',
    label: 'Store page link',
    required: false,
    input: 'list',
    weight: 0.5,
  },
  rating: {
    field: ext('ageRating'),
    label: 'Age rating',
    required: false,
    help: 'Needed for console storefronts in most regions',
    weight: 0.5,
  },
} satisfies Record<string, BriefRequirement>;

const sellingPoints = (minItems: number, label = 'Key selling points'): BriefRequirement => ({
  field: 'brief.keySellingPoints',
  label,
  input: 'list',
  minItems,
  help: 'Short, concrete hooks: mechanics, features, what makes it different',
});

export const releaseTrailer: VideoTypeDef = {
  id: 'game-trailer/release-trailer',
  name: 'Release trailer',
  description: 'Launch-day trailer: strongest gameplay, accolades, date and platforms, buy CTA.',
  defaultTemplateId: 'game-trailer/tpl-release',
  typicalDuration: { min: 60, max: 120 },
  requirements: [
    r.title,
    r.release,
    r.platforms,
    r.genre,
    sellingPoints(3),
    r.tone,
    r.cta,
    r.formats,
    r.audience,
    r.quotes,
    r.store,
    r.rating,
  ],
};

export const announcementTrailer: VideoTypeDef = {
  id: 'game-trailer/announcement-trailer',
  name: 'Announcement / reveal trailer',
  description: 'First look: world, tone and one clear hook; usually ends on a wishlist CTA.',
  defaultTemplateId: 'game-trailer/tpl-announcement',
  typicalDuration: { min: 30, max: 90 },
  requirements: [
    r.title,
    r.genre,
    sellingPoints(2, 'What makes it special'),
    r.tone,
    r.cta,
    r.formats,
    { ...r.platforms, required: false },
    { ...r.release, required: false, label: 'Release date or window' },
    r.audience,
  ],
};

export const gameplayTrailer: VideoTypeDef = {
  id: 'game-trailer/gameplay-trailer',
  name: 'Gameplay trailer',
  description: 'Shows how the game plays: core loop, systems and progression, minimal cinematics.',
  defaultTemplateId: 'game-trailer/tpl-gameplay',
  typicalDuration: { min: 60, max: 180 },
  requirements: [
    r.title,
    r.genre,
    sellingPoints(3, 'Mechanics and systems to show'),
    r.tone,
    r.formats,
    { ...r.platforms, required: false },
    { ...r.cta, required: false },
    { ...r.release, required: false },
    r.audience,
  ],
};

export const videoTypes = [releaseTrailer, announcementTrailer, gameplayTrailer];
