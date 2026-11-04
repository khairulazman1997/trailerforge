import type { Resolution } from '@trailerforge/schema';
import { safeBox, type SafeInsets, type Scene } from './template.js';
import type { Box } from './text.js';

/**
 * Where short-form apps draw their own interface over a vertical video: the top bar, the
 * buttons down the right, the caption and description at the bottom. Text and logos of a TikTok
 * stay out of these areas. Fractions of the frame, generous on purpose (the apps move things).
 */
export const PLATFORMS = ['tiktok', 'shorts', 'reels'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_NAMES: Record<Platform, string> = {
  tiktok: 'TikTok',
  shorts: 'YouTube Shorts',
  reels: 'Instagram Reels',
};

export const PLATFORM_SAFE: Record<Platform, SafeInsets> = {
  tiktok: { top: 0.1, right: 0.15, bottom: 0.25, left: 0.06 },
  shorts: { top: 0.08, right: 0.14, bottom: 0.22, left: 0.06 },
  reels: { top: 0.08, right: 0.12, bottom: 0.2, left: 0.06 },
};

export const platformSafeBox = (size: Resolution, p: Platform): Box =>
  safeBox(size, PLATFORM_SAFE[p]);

/**
 * Text in a scene that the platform's interface would cover, as sentences naming the part
 * (for the Quality Gate check `core/platform-safe-area`).
 */
export function platformIssues(scene: Scene, p: Platform): string[] {
  const box = platformSafeBox(scene.size, p);
  const out: string[] = [];
  for (const l of scene.layers) {
    if (l.kind !== 'text') continue;
    const b = l.layout.bounds;
    const parts: string[] = [];
    if (b.y + b.h > box.y + box.h + 0.5) parts.push('the caption area at the bottom');
    if (b.x + b.w > box.x + box.w + 0.5) parts.push('the buttons on the right');
    if (b.y < box.y - 0.5) parts.push('the bar at the top');
    if (b.x < box.x - 0.5) parts.push('the left edge');
    if (parts.length)
      out.push(`text "${l.text}" sits where ${PLATFORM_NAMES[p]}'s interface covers it (${parts.join(', ')})`); // prettier-ignore
  }
  return [...new Set(out)];
}
