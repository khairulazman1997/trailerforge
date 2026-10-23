import type { z } from 'zod';
import type { FormatTarget } from '@trailerforge/schema';

type FormatInput = z.input<typeof FormatTarget>;

/** Common deliverables offered by the "Output formats and length" question. */
export const FORMAT_PRESETS: FormatInput[] = [
  {
    id: 'fmt_youtube_60',
    name: 'YouTube 16:9 · 60 s',
    aspect: '16:9',
    resolution: { width: 1920, height: 1080 },
    frameRate: { num: 60, den: 1 },
    targetDuration: 60,
    platformIds: ['core/youtube'],
  },
  {
    id: 'fmt_youtube_90',
    name: 'YouTube 16:9 · 90 s',
    aspect: '16:9',
    resolution: { width: 1920, height: 1080 },
    frameRate: { num: 60, den: 1 },
    targetDuration: 90,
    platformIds: ['core/youtube'],
  },
  {
    id: 'fmt_steam_60',
    name: 'Steam page 16:9 · 60 s',
    aspect: '16:9',
    resolution: { width: 1920, height: 1080 },
    frameRate: { num: 60, den: 1 },
    targetDuration: 60,
  },
  {
    id: 'fmt_vertical_30',
    name: 'TikTok / Reels / Shorts 9:16 · 30 s',
    aspect: '9:16',
    resolution: { width: 1080, height: 1920 },
    frameRate: { num: 30, den: 1 },
    targetDuration: 30,
    platformIds: ['core/tiktok'],
  },
  {
    id: 'fmt_vertical_15',
    name: 'TikTok / Reels / Shorts 9:16 · 15 s',
    aspect: '9:16',
    resolution: { width: 1080, height: 1920 },
    frameRate: { num: 30, den: 1 },
    targetDuration: 15,
    platformIds: ['core/tiktok'],
  },
  {
    id: 'fmt_square_30',
    name: 'Square 1:1 · 30 s',
    aspect: '1:1',
    resolution: { width: 1080, height: 1080 },
    frameRate: { num: 30, den: 1 },
    targetDuration: 30,
  },
  {
    id: 'fmt_feed_30',
    name: 'Feed 4:5 · 30 s',
    aspect: '4:5',
    resolution: { width: 1080, height: 1350 },
    frameRate: { num: 30, den: 1 },
    targetDuration: 30,
  },
];
