import { TemplateRegistry, type GraphicTemplate } from '../template.js';
import { cardTemplates } from './cards.js';
import { overlayTemplates } from './overlays.js';

export * from './cards.js';
export * from './overlays.js';

/** Every built-in graphics template. */
export const builtinTemplates: readonly GraphicTemplate<unknown>[] = [
  ...cardTemplates,
  ...overlayTemplates,
];

/** A registry holding the built-in templates (the engine's core plugin registers the same ones). */
export function builtinRegistry(): TemplateRegistry {
  const reg = new TemplateRegistry();
  for (const t of builtinTemplates) reg.register(t);
  return reg;
}
