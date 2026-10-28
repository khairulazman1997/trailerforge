import { useRef } from 'react';
import { cropAround, cropStyle, focusFromPoint } from '../variants-view.js';
import { Thumb } from './Thumb.js';

/**
 * Where a vertical or square version looks: a frame of the shot with the part it shows outlined.
 * Click the frame, or use the two sliders (keyboard and screen readers), to set the focus point;
 * "Automatic" goes back to following the subject.
 */
export function FocusEditor({
  assetId,
  name,
  ready,
  source,
  target,
  value,
  disabled,
  onChange,
}: {
  assetId: string;
  name: string;
  /** The preview picture exists. */
  ready: boolean;
  source: { width: number; height: number };
  target: { width: number; height: number };
  /** The point set by hand, or null for automatic. */
  value: { x: number; y: number } | null;
  disabled?: boolean;
  /** null goes back to automatic. */
  onChange: (point: { x: number; y: number } | null) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const point = value ?? { x: 0.5, y: 0.5 };
  const rect = cropAround(source, target, point);
  const set = (p: { x: number; y: number }) => !disabled && onChange(p);
  return (
    <div className="focus-editor">
      <div
        ref={frame}
        className="focus-frame"
        style={{ aspectRatio: `${source.width} / ${source.height}` }}
        onClick={(e) => {
          const b = frame.current?.getBoundingClientRect();
          if (b) set(focusFromPoint(e.clientX, e.clientY, b));
        }}
      >
        <Thumb assetId={assetId} name={name} ready={ready} />
        <span className="focus-crop" style={cropStyle(rect)} aria-hidden="true" />
        {value && (
          <span
            className="focus-dot"
            style={{ left: `${value.x * 100}%`, top: `${value.y * 100}%` }}
            aria-hidden="true"
          />
        )}
      </div>
      <div className="focus-controls">
        <label>
          Across ({Math.round(point.x * 100)}%)
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(point.x * 100)}
            disabled={disabled}
            onChange={(e) => set({ x: Number(e.target.value) / 100, y: point.y })}
          />
        </label>
        <label>
          Down ({Math.round(point.y * 100)}%)
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(point.y * 100)}
            disabled={disabled}
            onChange={(e) => set({ x: point.x, y: Number(e.target.value) / 100 })}
          />
        </label>
        <button type="button" disabled={disabled || value === null} onClick={() => onChange(null)}>
          Automatic
        </button>
        <p className="muted">
          {value
            ? 'The crop is centred on the point you chose.'
            : 'Automatic: the crop follows what moves in the shot.'}
        </p>
      </div>
    </div>
  );
}
