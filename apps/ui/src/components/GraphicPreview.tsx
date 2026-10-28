import { hashText } from '../graphics-view.js';

/**
 * One frame of a graphic. The SVG comes from the same package the final render uses; the hash is
 * a fingerprint of that frame, which tests compare with the engine's own frame.
 */
export function GraphicPreview({ svg, label }: { svg: string; label: string }) {
  return (
    <div
      className="gfx-frame"
      role="img"
      aria-label={label}
      data-testid="gfx-preview"
      data-frame-hash={hashText(svg)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
