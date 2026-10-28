import { hashText, inlineImages } from '../graphics-view.js';

/**
 * One frame of a graphic. The SVG comes from the same package the final render uses; the hash is
 * a fingerprint of that frame, which tests compare with the engine's own frame.
 */
export function GraphicPreview({
  svg,
  label,
  images,
}: {
  svg: string;
  label: string;
  /** The project's own images (the logo) by their `media/<hash>.<ext>` path, as data URIs. */
  images?: Readonly<Record<string, string>>;
}) {
  return (
    <div
      className="gfx-frame"
      role="img"
      aria-label={label}
      data-testid="gfx-preview"
      data-frame-hash={hashText(svg)}
      dangerouslySetInnerHTML={{ __html: images ? inlineImages(svg, images) : svg }}
    />
  );
}
