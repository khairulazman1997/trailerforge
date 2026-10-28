/** Renders frames into a cache folder, one after another, until the test SIGKILLs it. */
import { brandTokens, buildScene, builtinRegistry, safeBox } from '@trailerforge/graphics';
import { FLICKS_PER_SECOND, resolveBrandFonts } from '@trailerforge/schema';
import { FrameRenderer } from './renderer.js';

const [cacheDir] = process.argv.slice(2) as [string];
const HD = { width: 1920, height: 1080 };
const t = builtinRegistry().get('core/title-card')!;
const scene = buildScene(t, {
  params: { text: 'Ember Knight', subtitle: 'A dark fantasy action RPG' },
  brand: brandTokens(null, resolveBrandFonts(null, new Set()), HD, false),
  size: HD,
  duration: 3 * FLICKS_PER_SECOND,
  safe: safeBox(HD),
});
const r = await FrameRenderer.create({ cacheDir });
for (let k = 0; ; k = (k + 1) % 90) {
  await r.renderFrame(scene, Math.round((k * FLICKS_PER_SECOND) / 30));
  process.stdout.write(`rendered ${k}\n`);
}
