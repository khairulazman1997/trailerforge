import type { Brand, BrandFontResolution, Timeline } from '@trailerforge/schema';
import type { Measure } from './text.js';
import { brandTokens, buildScene, safeBox, type GraphicTemplate, type Scene } from './template.js';

/**
 * The scenes a timeline's graphics draw: one per graphic item (its template and params) and one
 * per caption (its `styleId` overlay template, else `core/caption`), sized to the timeline's
 * resolution with the project's brand. The renderer and the preview both start from this, so a
 * version draws the same cards and captions wherever it is rendered.
 */

export const DEFAULT_CAPTION_TEMPLATE = 'core/caption';

export interface TimelineScene {
  itemId: string;
  trackId: string;
  kind: 'graphic' | 'caption';
  /** Placement on the timeline, flicks. */
  start: number;
  duration: number;
  templateId: string;
  scene: Scene;
}

export interface TimelineScenesInput {
  timeline: Timeline;
  templates: { get(id: string): GraphicTemplate<unknown> | undefined };
  brand: Brand | null | undefined;
  fonts?: BrandFontResolution;
  logoPresent?: boolean;
  measure?: Measure;
}

export function timelineScenes(input: TimelineScenesInput): {
  scenes: TimelineScene[];
  warnings: string[];
} {
  const { timeline } = input;
  const size = timeline.resolution;
  const brand = brandTokens(input.brand, input.fonts, size, input.logoPresent ?? true);
  const safe = safeBox(size);
  const scenes: TimelineScene[] = [];
  const warnings: string[] = [];
  for (const track of timeline.tracks)
    for (const item of track.items) {
      if (item.kind !== 'graphic' && item.kind !== 'caption') continue;
      let templateId: string;
      let params: unknown;
      if (item.kind === 'graphic') {
        templateId = item.templateId;
        params = item.params;
      } else {
        const style = item.styleId ? input.templates.get(item.styleId) : undefined;
        templateId = style?.kind === 'overlay' ? style.id : DEFAULT_CAPTION_TEMPLATE;
        params = { text: item.text };
      }
      const template = input.templates.get(templateId);
      if (!template) {
        warnings.push(
          `"${item.label || item.id}" uses the template "${templateId}", which is not installed`,
        );
        continue;
      }
      try {
        const scene = buildScene(template, {
          params,
          brand,
          size,
          duration: item.duration,
          safe,
          ...(input.measure ? { measure: input.measure } : {}),
        });
        scenes.push({
          itemId: item.id,
          trackId: track.id,
          kind: item.kind,
          start: item.start,
          duration: item.duration,
          templateId,
          scene,
        });
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : String(err));
      }
    }
  scenes.sort((a, b) => a.start - b.start || (a.itemId < b.itemId ? -1 : 1));
  return { scenes, warnings };
}
