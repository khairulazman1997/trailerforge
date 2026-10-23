import type { ProjectInput } from './project.js';
import { PROJECT_SCHEMA_VERSION } from './project.js';
import { rate, secondsToFlicks } from './time.js';

const T0 = '2026-10-23T10:00:00.000Z';
const s = secondsToFlicks;

/**
 * A small but complete release-trailer project touching every schema area. Returns a fresh
 * object each call so tests can mutate it freely.
 */
export function sampleProject(): ProjectInput {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: 'proj_sample',
    name: 'Ember Knight — Release Trailer',
    createdAt: T0,
    updatedAt: T0,
    domainPackId: 'game-trailer',
    platformTargets: ['core/youtube', 'core/tiktok'],
    brief: {
      videoTypeId: 'game-trailer/release-trailer',
      title: 'Ember Knight',
      freeText: 'Fast soulslike with a parry-focused combat loop.',
      tone: ['intense', 'heroic'],
      keySellingPoints: ['Parry-driven combat', 'Hand-drawn bosses', 'Co-op'],
      keyDates: [{ label: 'Release', date: '2027-02-14' }],
      callToAction: 'Wishlist now on Steam',
      links: [{ label: 'Steam', url: 'https://store.steampowered.com/app/0000000' }],
      extensions: { 'game-trailer': { genre: 'action RPG', gamePlatforms: ['PC', 'PS5'] } },
    },
    formatTargets: [
      {
        id: 'fmt_yt',
        name: 'YouTube 16:9',
        aspect: '16:9',
        resolution: { width: 1920, height: 1080 },
        frameRate: rate(60),
        targetDuration: 60,
        platformIds: ['core/youtube'],
      },
      {
        id: 'fmt_tt',
        name: 'TikTok 9:16',
        aspect: '9:16',
        resolution: { width: 1080, height: 1920 },
        frameRate: rate(30),
        targetDuration: 30,
        platformIds: ['core/tiktok'],
      },
    ],
    storyboard: {
      id: 'sb_main',
      meta: {
        videoTypeId: 'game-trailer/release-trailer',
        tone: ['intense'],
        targetDuration: 60,
        masterResolution: { width: 1920, height: 1080 },
      },
      sections: [
        {
          id: 'sec_hook',
          name: 'Hook',
          role: 'hook',
          slots: [
            {
              id: 'shot_parry',
              kind: 'shot',
              title: 'Perfect parry',
              purpose: 'Show the core mechanic in the first 3 seconds',
              duration: { min: 1.5, ideal: 2, max: 3 },
              captureInstruction: 'Boss phase 2: land a parry then a finisher. No HUD.',
              location: 'Forest',
              hud: 'off',
              transitionOut: { transitionId: 'core/flash', duration: 0.1 },
            },
          ],
        },
        {
          id: 'sec_escalation',
          name: 'Escalation',
          role: 'escalation',
          slots: [
            {
              id: 'shot_boss',
              kind: 'shot',
              title: 'Boss reveal',
              duration: { min: 2, ideal: 2.5, max: 4 },
              location: 'Forest',
              overlays: [{ id: 'ov_name', templateId: 'core/lower-third', text: 'The Ash Warden' }],
            },
          ],
        },
        {
          id: 'sec_end',
          name: 'End slate',
          role: 'end-slate',
          locked: true,
          slots: [
            {
              id: 'card_end',
              kind: 'card',
              cardKind: 'cta',
              templateId: 'core/end-slate',
              text: 'Wishlist now — Feb 14',
              duration: { min: 3, ideal: 3, max: 5 },
            },
          ],
        },
      ],
      voLines: [
        {
          id: 'vo_1',
          text: 'Every blow can be answered.',
          direction: 'low, controlled',
          targetDuration: 2,
          linkedSlotIds: ['shot_parry'],
        },
      ],
      music: {
        trackAssetId: 'asset_music',
        direction: 'Orchestral hybrid, builds to a drop at the boss reveal',
        bpm: { min: 120, max: 140 },
        structure: [
          { id: 'mus_build', label: 'build', sectionIds: ['sec_hook', 'sec_escalation'] },
        ],
        hitPoints: [{ id: 'hit_boss', kind: 'drop', slotId: 'shot_boss' }],
        sfxCues: [{ id: 'sfx_whoosh', kind: 'whoosh', slotId: 'shot_boss', position: 'before' }],
      },
      variants: [
        {
          id: 'var_tt',
          formatTargetId: 'fmt_tt',
          rulesetId: 'core/vertical-short',
          overrides: { shot_boss: { cropCenter: { x: 0.6, y: 0.5 } } },
        },
      ],
    },
    timelines: [
      {
        id: 'tl_master',
        name: 'Master 16:9',
        formatTargetId: 'fmt_yt',
        frameRate: rate(60),
        resolution: { width: 1920, height: 1080 },
        tracks: [
          {
            id: 'trk_v1',
            kind: 'video',
            items: [
              {
                id: 'it_parry',
                kind: 'clip',
                assetId: 'asset_forest',
                slotId: 'shot_parry',
                start: 0,
                duration: s(2),
                sourceIn: s(12.5),
                decisionId: 'dec_parry',
              },
              {
                id: 'it_boss',
                kind: 'placeholder',
                slotId: 'shot_boss',
                start: s(2),
                duration: s(2.5),
                reason: 'missing-footage',
              },
              {
                id: 'it_end',
                kind: 'graphic',
                slotId: 'card_end',
                templateId: 'core/end-slate',
                start: s(4.5),
                duration: s(3),
                params: { text: 'Wishlist now — Feb 14' },
              },
            ],
            transitions: [
              {
                id: 'tr_flash',
                transitionId: 'core/flash',
                fromItemId: 'it_parry',
                toItemId: 'it_boss',
                duration: s(0.1),
              },
            ],
          },
          {
            id: 'trk_a1',
            kind: 'audio',
            items: [
              {
                id: 'it_music',
                kind: 'clip',
                assetId: 'asset_music',
                start: 0,
                duration: s(7.5),
                sourceIn: 0,
                gainDb: {
                  keyframes: [
                    { at: 0, value: -6 },
                    { at: s(7), value: -6 },
                    { at: s(7.5), value: -60, easing: 'ease-in' },
                  ],
                },
              },
            ],
          },
        ],
        markers: [{ id: 'mk_drop', at: s(2), kind: 'downbeat', label: 'drop' }],
      },
    ],
    assets: [
      { assetId: 'asset_forest', role: 'footage', addedAt: T0 },
      { assetId: 'asset_music', role: 'music', addedAt: T0 },
    ],
    plugins: [{ id: 'game-trailer', version: '0.0.0' }],
  };
}
