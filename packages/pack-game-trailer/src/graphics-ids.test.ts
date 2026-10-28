import { builtinRegistry } from '@trailerforge/graphics';
import { Storyboard } from '@trailerforge/schema';
import { describe, expect, it } from 'vitest';
import { storyboardTemplates } from './templates.js';

describe('storyboard templates and the built-in graphics templates', () => {
  it('only use graphics templates that are installed, for the right kind of use', () => {
    const reg = builtinRegistry();
    for (const t of storyboardTemplates) {
      const sb = Storyboard.parse(t.build({ targetDuration: 60 }));
      for (const section of sb.sections)
        for (const slot of section.slots) {
          if (slot.kind === 'card') {
            expect(reg.get(slot.templateId)?.kind, `${t.id} ${slot.id}: ${slot.templateId}`).toBe(
              'card',
            );
            expect(reg.get(`core/${slot.cardKind}-card`), slot.cardKind).toBeDefined();
          } else {
            for (const o of slot.overlays)
              expect(reg.get(o.templateId)?.kind, `${t.id} ${slot.id}: ${o.templateId}`).toBe(
                'overlay',
              );
          }
        }
    }
  });
});
