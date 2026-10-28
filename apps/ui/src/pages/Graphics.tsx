import { useEffect, useMemo, useState } from 'react';
import type { CardSlot, Overlay, ShotSlot } from '@trailerforge/schema';
import { useAppState, useStore } from '../app-context.js';
import { GraphicPreview } from '../components/GraphicPreview.js';
import { Link, projectPath } from '../router.js';
import { busyTask, type Catalog } from '../store.js';
import { fieldsOf, previewFrame, type Field } from '../graphics-view.js';

type Template = Catalog['templates'][number];
type Value = string | number | boolean;

interface Item {
  key: string;
  kind: 'card' | 'overlay';
  slotId: string;
  overlayId?: string;
  title: string;
  templateId: string;
  text: string;
  params: Record<string, unknown>;
  /** How long it is on screen, seconds. */
  seconds: number;
  locked: boolean;
}

/** Title cards and on-screen text of the storyboard, with their templates and a live preview. */
export function GraphicsPage({ id }: { id: string }) {
  const store = useStore();
  const view = useAppState((s) => s.projects[id])!;
  const catalog = useAppState((s) => s.catalog);
  const busy = useAppState((s) => busyTask(s, id));
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    void store.loadCatalog();
  }, [store]);

  const sb = view.project.storyboard;
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const section of sb?.sections ?? [])
      for (const slot of section.slots) {
        if (slot.kind === 'card') {
          const c = slot as CardSlot;
          out.push({
            key: `card:${c.id}`,
            kind: 'card',
            slotId: c.id,
            title: c.title || c.cardKind,
            templateId: c.templateId,
            text: c.text,
            params: c.params,
            seconds: c.duration.ideal,
            locked: section.locked,
          });
        } else
          for (const o of (slot as ShotSlot).overlays)
            out.push({
              key: `ov:${slot.id}:${o.id}`,
              kind: 'overlay',
              slotId: slot.id,
              overlayId: o.id,
              title: o.text ? `“${o.text}”` : o.templateId,
              templateId: o.templateId,
              text: o.text ?? '',
              params: o.params,
              seconds: Math.max(0.5, o.duration ?? slot.duration.ideal - o.offset),
              locked: section.locked,
            });
      }
    return out;
  }, [sb]);
  const item = items.find((x) => x.key === selected) ?? items[0];

  if (!sb) {
    return (
      <>
        <h1>Graphics</h1>
        <p>
          Cards and on-screen text come from the storyboard.{' '}
          <Link to={projectPath(id, 'storyboard')}>Write it</Link> first.
        </p>
      </>
    );
  }
  return (
    <>
      <h1>Graphics</h1>
      <p>
        Pick a look for each title card and piece of on-screen text, and see it with your brand kit
        as you type. The preview is drawn by the same code that makes the final frames.
      </p>
      {items.length === 0 ? (
        <p>The storyboard has no cards or on-screen text yet.</p>
      ) : (
        <div className="gfx-layout">
          <nav aria-label="Cards and on-screen text">
            <ul className="gfx-list">
              {(['card', 'overlay'] as const).map((kind) => (
                <li key={kind}>
                  <h2>{kind === 'card' ? 'Cards' : 'On-screen text'}</h2>
                  <ul className="gfx-list">
                    {items
                      .filter((x) => x.kind === kind)
                      .map((x) => (
                        <li key={x.key}>
                          <button
                            type="button"
                            aria-pressed={item?.key === x.key}
                            onClick={() => setSelected(x.key)}
                          >
                            {x.title}
                          </button>
                        </li>
                      ))}
                  </ul>
                </li>
              ))}
            </ul>
          </nav>
          {item && (
            <Editor
              // Drafts start over when the stored values change (a command went through).
              key={`${item.key}:${item.templateId}:${item.text}:${JSON.stringify(item.params)}`}
              id={id}
              item={item}
              catalog={catalog}
              disabled={!!busy || item.locked}
            />
          )}
        </div>
      )}
    </>
  );
}

function Editor({
  id,
  item,
  catalog,
  disabled,
}: {
  id: string;
  item: Item;
  catalog: Catalog | null;
  disabled: boolean;
}) {
  const store = useStore();
  const view = useAppState((s) => s.projects[id])!;
  const project = view.project;
  const [text, setText] = useState(item.text);
  const [params, setParams] = useState<Record<string, unknown>>(item.params);
  const [at, setAt] = useState(Math.min(1.5, item.seconds / 2));
  const [playing, setPlaying] = useState(false);
  const [shape, setShape] = useState(project.formatTargets[0]?.id ?? '');
  const size = project.formatTargets.find((f) => f.id === shape)?.resolution ?? {
    width: 1920,
    height: 1080,
  };

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(
      () => setAt((a) => (a + 0.05 >= item.seconds ? (setPlaying(false), item.seconds) : a + 0.05)),
      50,
    );
    return () => clearInterval(t);
  }, [playing, item.seconds]);

  const templates = (catalog?.templates ?? []).filter((t) => t.kind === item.kind);
  const template: Template | undefined = (catalog?.templates ?? []).find(
    (t) => t.id === item.templateId,
  );
  const fields = fieldsOf(template?.params).filter((f) => f.name !== 'text');
  const hasText = fieldsOf(template?.params).some((f) => f.name === 'text');

  const slot = project
    .storyboard!.sections.flatMap((s) => s.slots)
    .find((s) => s.id === item.slotId)!;
  const update = (patch: unknown) =>
    store.command(id, 'core/storyboard.update-slot', { slotId: item.slotId, patch });
  const setOverlay = (change: Partial<Overlay> | Record<string, unknown>) =>
    update({
      overlays: (slot as ShotSlot).overlays.map((o) =>
        o.id === item.overlayId ? { ...o, ...change } : o,
      ),
    });
  const commit = (change: {
    templateId?: string;
    text?: string;
    params?: Record<string, unknown>;
  }) => (item.kind === 'card' ? update(change) : setOverlay(change));

  const merged = { ...params, ...(hasText ? { text } : {}) };
  const preview = previewFrame({
    templateId: item.templateId,
    params: merged,
    brand: project.brand,
    size,
    seconds: item.seconds,
    at,
  });
  const cleaned = (p: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(p).filter(([, v]) => v !== '' && v !== undefined));

  return (
    <section aria-label={`Editing ${item.title}`}>
      <h2>{item.title}</h2>
      {item.locked && (
        <p className="warn-text">
          This section is locked. Unlock it on the Storyboard tab to change this.
        </p>
      )}
      <div className="gfx-fields">
        <label>
          Template
          <select
            value={item.templateId}
            disabled={disabled || !catalog}
            onChange={(e) => void commit({ templateId: e.target.value, params: {} })}
          >
            {!templates.some((t) => t.id === item.templateId) && (
              <option value={item.templateId}>{item.templateId} (not installed)</option>
            )}
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {hasText && (
          <label>
            Text
            <input
              value={text}
              disabled={disabled}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => text !== item.text && void commit({ text })}
            />
          </label>
        )}
        {fields.map((f) => (
          <FieldInput
            key={f.name}
            f={f}
            value={params[f.name] as Value | undefined}
            disabled={disabled}
            onDraft={(v) => setParams((p) => ({ ...p, [f.name]: v }))}
            onCommit={(v) => void commit({ params: cleaned({ ...params, [f.name]: v }) })}
          />
        ))}
      </div>

      <div className="gfx-scrub">
        <button
          type="button"
          onClick={() => (at >= item.seconds && setAt(0), setPlaying(!playing))}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <label>
          Time ({Math.round(at * 100) / 100} s of {Math.round(item.seconds * 10) / 10} s)
          <input
            type="range"
            min={0}
            max={item.seconds}
            step={0.05}
            value={at}
            onChange={(e) => (setPlaying(false), setAt(Number(e.target.value)))}
          />
        </label>
        {project.formatTargets.length > 1 && (
          <label>
            Shape
            <select value={shape} onChange={(e) => setShape(e.target.value)}>
              {project.formatTargets.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {'error' in preview ? (
        <p role="alert" className="warn-text">
          {preview.error}
        </p>
      ) : (
        <>
          <GraphicPreview
            svg={preview.svg}
            label={`Preview of ${item.title} at ${Math.round(at * 100) / 100} seconds`}
          />
          {preview.warnings.length > 0 && (
            <ul aria-label="Problems with this graphic">
              {preview.warnings.map((w) => (
                <li key={w} className="warn-text">
                  {w}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {project.brand?.logo && (
        <p className="muted">
          Your logo and brand fonts are drawn in the final render; this preview leaves the logo out
          and uses Inter.
        </p>
      )}
    </section>
  );
}

function FieldInput({
  f,
  value,
  disabled,
  onDraft,
  onCommit,
}: {
  f: Field;
  value: Value | undefined;
  disabled: boolean;
  onDraft: (v: Value) => void;
  onCommit: (v: Value) => void;
}) {
  const shown = value ?? f.default ?? '';
  if (f.kind === 'boolean')
    return (
      <label>
        <span>
          <input
            type="checkbox"
            checked={shown === true}
            disabled={disabled}
            onChange={(e) => (onDraft(e.target.checked), onCommit(e.target.checked))}
          />{' '}
          {f.label}
        </span>
      </label>
    );
  if (f.kind === 'choice')
    return (
      <label>
        {f.label}
        <select
          value={String(shown)}
          disabled={disabled}
          onChange={(e) => (onDraft(e.target.value), onCommit(e.target.value))}
        >
          {f.choices!.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <label>
      {f.label}
      <input
        type={f.kind === 'number' ? 'number' : 'text'}
        step={f.kind === 'number' ? 'any' : undefined}
        min={f.min}
        max={f.max}
        maxLength={f.maxLength}
        value={String(shown)}
        disabled={disabled}
        onChange={(e) =>
          onDraft(
            f.kind === 'number'
              ? e.target.value === ''
                ? ''
                : Number(e.target.value)
              : e.target.value,
          )
        }
        onBlur={() => value !== undefined && onCommit(value)}
      />
    </label>
  );
}
