import type { VisionModelManifest } from './vision.js';

/**
 * The pinned vision model: exact URLs (at a fixed revision), sizes and sha256 of each file.
 * Written by `pnpm --filter @trailerforge/analysis pin:vision` (`scripts/pin-vision-model.mjs`) on a machine that can reach
 * Hugging Face; null until then, which keeps the feature switched off (nothing unverified is
 * ever downloaded).
 */
export const PINNED_VISION_MODEL: VisionModelManifest | null = null;
