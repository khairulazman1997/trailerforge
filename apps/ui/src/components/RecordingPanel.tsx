import { useEffect, useRef, useState } from 'react';
import { PendingCheckbox, PendingSelect } from './Pending.js';
import type {
  RecordingField,
  RecordingPatch,
  ResolvedRecording,
} from '@trailerforge/pack-game-trailer/browser';
import {
  parsePositive,
  parseResolution,
  resolutionKey,
  resolutionLabel,
  RESOLUTIONS,
  SETTING_LABELS,
} from '../capture-view.js';

/** A number typed in place: committed on Enter or blur, reverted when it is not valid. */
function NumberField({
  label,
  value,
  integer,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  integer?: boolean;
  disabled: boolean;
  onCommit: (n: number) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(String(value));
  const [bad, setBad] = useState(false);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(String(value));
  }, [value]);
  const commit = () => {
    editing.current = false;
    const n = parsePositive(draft, { integer: !!integer });
    if (n === null) {
      setBad(true);
      setDraft(String(value));
    } else {
      setBad(false);
      if (n !== value) onCommit(n);
    }
  };
  return (
    <>
      <input
        type="text"
        inputMode="decimal"
        className="cap-number"
        aria-label={label}
        aria-invalid={bad || undefined}
        disabled={disabled}
        value={draft}
        onFocus={() => (editing.current = true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(String(value));
            e.currentTarget.blur();
          }
        }}
      />
      {bad && (
        <span role="alert" className="error">
          {integer ? 'Use a whole number above 0.' : 'Use a number above 0.'}
        </span>
      )}
    </>
  );
}

const CODECS = ['h264', 'hevc', 'av1'] as const;
const CONTAINERS = ['mkv', 'mp4', 'mov'] as const;
const HUDS = [
  ['off', 'Off'],
  ['on', 'On'],
  ['per-shot', 'Per shot (follow each item)'],
] as const;

export function RecordingPanel({
  rec,
  disabled,
  onPatch,
  onReset,
}: {
  rec: ResolvedRecording;
  disabled: boolean;
  onPatch: (patch: RecordingPatch) => Promise<unknown>;
  onReset: () => Promise<unknown>;
}) {
  const s = rec.settings;
  const overridden = (Object.keys(rec.sources) as RecordingField[]).filter(
    (k) => rec.sources[k] === 'override',
  );
  const row = (field: RecordingField, control: React.ReactNode) => (
    <div className="cap-setting" data-setting={field}>
      <dt>{SETTING_LABELS[field]}</dt>
      <dd>
        {control}
        <span className={`chip ${rec.sources[field] === 'override' ? 'assumed' : ''}`}>
          {rec.sources[field] === 'override' ? 'Your override' : 'Derived'}
        </span>
        {rec.sources[field] === 'override' && (
          <button
            type="button"
            className="ghost"
            disabled={disabled}
            aria-label={`Reset ${SETTING_LABELS[field]} to the derived value`}
            onClick={() => onPatch({ [field]: null })}
          >
            Reset
          </button>
        )}
      </dd>
    </div>
  );
  const known = RESOLUTIONS.some((r) => resolutionKey(r) === resolutionKey(s.resolution));
  return (
    <section className="card" aria-labelledby="cap-settings-h">
      <div className="row">
        <h2 id="cap-settings-h">Recording settings</h2>
        <span className="spacer" />
        <button type="button" disabled={disabled || overridden.length === 0} onClick={onReset}>
          Reset all overrides
        </button>
      </div>
      <p className="muted">
        Worked out from the platforms in the brief, the video type, the shots&rsquo; HUD needs and
        the output formats{rec.primaryPlatform ? ` (capturing for ${rec.primaryPlatform})` : ''}.
        Change any value to override it.
      </p>
      <dl className="cap-settings">
        {row(
          'resolution',
          <PendingSelect
            label="Resolution"
            disabled={disabled}
            value={resolutionKey(s.resolution)}
            options={[
              ...(known
                ? []
                : [{ value: resolutionKey(s.resolution), label: resolutionLabel(s.resolution) }]),
              ...RESOLUTIONS.map((r) => ({ value: resolutionKey(r), label: resolutionLabel(r) })),
            ]}
            onChange={(key) => {
              const r = parseResolution(key);
              return r ? onPatch({ resolution: r }) : Promise.resolve();
            }}
          />,
        )}
        {row(
          'fps',
          <NumberField
            label="Frame rate (fps)"
            value={s.fps}
            integer
            disabled={disabled}
            onCommit={(fps) => onPatch({ fps })}
          />,
        )}
        {row(
          'bitrateMbps',
          <NumberField
            label="Bitrate (Mbps)"
            value={s.bitrateMbps}
            disabled={disabled}
            onCommit={(bitrateMbps) => onPatch({ bitrateMbps })}
          />,
        )}
        {row(
          'codec',
          <PendingSelect
            label="Codec"
            disabled={disabled}
            value={s.codec}
            options={CODECS.map((c) => ({ value: c, label: c.toUpperCase() }))}
            onChange={(codec) => onPatch({ codec })}
          />,
        )}
        {row(
          'container',
          <PendingSelect
            label="Container"
            disabled={disabled}
            value={s.container}
            options={CONTAINERS.map((c) => ({ value: c, label: c.toUpperCase() }))}
            onChange={(container) => onPatch({ container })}
          />,
        )}
        {row(
          'hud',
          <PendingSelect
            label="HUD"
            disabled={disabled}
            value={s.hud}
            options={HUDS.map(([value, label]) => ({ value, label }))}
            onChange={(hud) => onPatch({ hud })}
          />,
        )}
        {row(
          'hdr',
          <PendingCheckbox
            label="Record HDR"
            checked={s.hdr}
            disabled={disabled}
            onChange={(hdr) => onPatch({ hdr })}
          />,
        )}
      </dl>
      {rec.advice.length > 0 && (
        <ul className="cap-advice" aria-label="Recording warnings">
          {rec.advice.map((a, i) => (
            <li key={`${a.code}-${i}`} className={a.severity}>
              <strong>{a.severity === 'warn' ? 'Watch out:' : 'Note:'}</strong> {a.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
