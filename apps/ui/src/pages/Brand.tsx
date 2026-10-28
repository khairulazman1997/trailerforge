import { useEffect, useState } from 'react';
import { defaultBrand, type BrandColors } from '@trailerforge/schema';
import { useAppState, useStore } from '../app-context.js';
import { BrowseButton } from '../components/BrowseButton.js';
import { ConfirmDialog } from '../components/Dialog.js';
import {
  COLOR_FIELDS,
  SCALE_FIELDS,
  contrastRows,
  fromPercent,
  normalizeHex,
  toPercent,
} from '../brand-view.js';
import { busyTask } from '../store.js';
import { usePending } from '../use-pending.js';

/** The game's look for trailer graphics: colours, a logo, fonts and text sizes. */
export function BrandPage({ id }: { id: string }) {
  const store = useStore();
  const version = useAppState((s) => s.projects[id]!.version);
  const busy = useAppState((s) => busyTask(s, id));
  const snap = useAppState((s) => s.brands[id]?.view);
  const [reset, setReset] = useState(false);
  const disabled = !!busy;
  useEffect(() => {
    void store.refreshBrand(id);
  }, [store, id, version]);

  const brand = snap?.brand ?? defaultBrand();
  const run = (type: string, payload: unknown) => store.command(id, type, payload);
  const rows = contrastRows(brand.colors);

  return (
    <>
      <h1>Brand</h1>
      <p>
        Titles, captions and name labels in your trailer use these colours, fonts and sizes. Nothing
        is uploaded; files you choose are copied into this project.
      </p>
      {snap && snap.warnings.length > 0 && (
        <ul className="brand-warnings" role="status" aria-label="Problems with the brand kit">
          {snap.warnings.map((w) => (
            <li key={w} className="warn-text">
              {w}
            </li>
          ))}
        </ul>
      )}

      <section aria-labelledby="brand-colors">
        <h2 id="brand-colors">Colours</h2>
        <div className="brand-colors">
          {COLOR_FIELDS.map(({ key, label }) => (
            <ColorField
              key={`${key}:${brand.colors[key]}`}
              label={label}
              value={brand.colors[key]}
              disabled={disabled}
              onChange={(hex) => run('core/brand.set-colors', { patch: { [key]: hex } })}
            />
          ))}
        </div>
        <table className="brand-contrast">
          <caption>Is it readable? (WCAG AA)</caption>
          <thead>
            <tr>
              <th scope="col">Pair</th>
              <th scope="col">Contrast</th>
              <th scope="col">Needs</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <th scope="row">{r.label}</th>
                <td>{r.ratio}:1</td>
                <td>{r.required}:1</td>
                <td>
                  <span className={`chip ${r.pass ? 'ok' : 'warn'}`}>
                    {r.pass ? 'Good' : 'Too low'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="brand-logo">
        <h2 id="brand-logo">Logo</h2>
        <p>
          {brand.logo
            ? `Using ${brand.logo.name}.`
            : 'No logo yet. Logo cards show the game’s name instead.'}
        </p>
        <FileImport
          label="Logo file (SVG or PNG)"
          hint="Scripts and links to the internet in an SVG are refused."
          disabled={disabled}
          onImport={(path) => store.importBrandFile(id, { kind: 'logo', path })}
        />
        {brand.logo && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void run('core/brand.set-logo', { file: null })}
          >
            Remove the logo
          </button>
        )}
      </section>

      <section aria-labelledby="brand-fonts">
        <h2 id="brand-fonts">Fonts</h2>
        {(['heading', 'body'] as const).map((role) => {
          const set = brand.fonts.find((f) => f.role === role);
          return (
            <div key={role} className="brand-font">
              <h3>{role === 'heading' ? 'Headings and titles' : 'Body text and captions'}</h3>
              <p>
                {set ? `${snap?.fonts[role] ?? set.family}` : `${snap?.fonts[role] ?? 'Inter'}`}
                {!set && ' (no font of yours set)'}
              </p>
              <FileImport
                label={`${role === 'heading' ? 'Heading' : 'Body'} font file (TTF or OTF)`}
                hint="WOFF2 fonts cannot be drawn yet; use the TTF or OTF version."
                disabled={disabled}
                onImport={(path) =>
                  store.importBrandFile(id, { kind: 'font', path, role, bold: role === 'heading' })
                }
              />
              {set && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void run('core/brand.set-font', { role, font: null })}
                >
                  Go back to the shipped font
                </button>
              )}
            </div>
          );
        })}
      </section>

      <section aria-labelledby="brand-scale">
        <h2 id="brand-scale">Text sizes</h2>
        <p>As a percentage of the frame’s shorter side, so they look the same in every shape.</p>
        <div className="brand-scale">
          {SCALE_FIELDS.map(({ key, label }) => (
            <PercentField
              key={`${key}:${brand.typeScale[key]}`}
              label={label}
              value={brand.typeScale[key]}
              disabled={disabled}
              onChange={(share) => run('core/brand.set-scale', { patch: { [key]: share } })}
            />
          ))}
        </div>
      </section>

      {snap?.brand && (
        <p>
          <button type="button" disabled={disabled} onClick={() => setReset(true)}>
            Clear the brand kit
          </button>
        </p>
      )}
      <ConfirmDialog
        open={reset}
        title="Clear the brand kit?"
        confirmLabel="Clear"
        tone="danger"
        onCancel={() => setReset(false)}
        onConfirm={async () => {
          await run('core/brand.reset', {});
          setReset(false);
        }}
      >
        <p>
          Colours, logo, fonts and sizes go back to the defaults. The files stay in the project.
          Undo goes back.
        </p>
      </ConfirmDialog>
    </>
  );
}

function ColorField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: BrandColors[keyof BrandColors];
  disabled: boolean;
  onChange: (hex: string) => Promise<unknown>;
}) {
  const [shown, change] = usePending(value);
  const [text, setText] = useState(value);
  const bad = normalizeHex(text) === null;
  return (
    <div className="brand-color">
      <label>
        {label} colour
        <input
          type="color"
          value={shown}
          disabled={disabled}
          onChange={(e) => void change(e.target.value, () => onChange(e.target.value))}
        />
      </label>
      <label>
        {label} as hex
        <input
          value={text}
          disabled={disabled}
          aria-invalid={bad}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const hex = normalizeHex(text);
            if (!hex) return setText(value);
            if (hex !== value) void change(hex, () => onChange(hex));
          }}
        />
      </label>
    </div>
  );
}

function PercentField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (share: number) => Promise<unknown>;
}) {
  const [text, setText] = useState(toPercent(value));
  const parsed = fromPercent(text);
  return (
    <label>
      {label} (%)
      <input
        inputMode="decimal"
        value={text}
        disabled={disabled}
        aria-invalid={parsed === null}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (parsed === null) return setText(toPercent(value));
          if (parsed !== value) void onChange(parsed);
        }}
      />
    </label>
  );
}

/** A path to a file on this computer (the desktop app can browse); the engine copies it in. */
function FileImport({
  label,
  hint,
  disabled,
  onImport,
}: {
  label: string;
  hint: string;
  disabled: boolean;
  onImport: (path: string) => Promise<boolean>;
}) {
  const [path, setPath] = useState('');
  const go = async (p: string) => {
    if (await onImport(p.trim())) setPath('');
  };
  return (
    <div className="brand-import">
      <label>
        {label}
        <input
          value={path}
          disabled={disabled}
          placeholder="Paste the file’s path"
          onChange={(e) => setPath(e.target.value)}
        />
      </label>
      <BrowseButton file label="Browse…" disabled={disabled} onPick={(p) => void go(p)} />
      <button type="button" disabled={disabled || !path.trim()} onClick={() => void go(path)}>
        Use this file
      </button>
      <small className="muted">{hint}</small>
    </div>
  );
}
