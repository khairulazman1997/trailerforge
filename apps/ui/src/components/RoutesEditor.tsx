import { useState } from 'react';
import type { RoutesView } from '@trailerforge/service/client';
import type { ProviderStatus } from '../store.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

interface RouteDraft {
  provider: string;
  model: string;
  effort: '' | Effort;
}
interface Draft {
  def: RouteDraft | null;
  tasks: Record<string, RouteDraft | null>;
  fallbacks: string[];
}

const TASK_LABEL: Record<string, string> = {
  'brief.parse': 'Read a free-text brief',
  'brief.suggest': 'Suggest for me',
  'storyboard.generate': 'Generate the storyboard',
  'storyboard.regenerate-section': 'Rewrite one section',
  'vo.script': 'Voice-over script',
  'capture.tips': 'Capture tips',
  'cut.rank-takes': 'Take ranking',
  'reference.template': 'Template from a reference video',
  'critique.run': 'AI critique',
};

const toDraft = (r?: {
  provider: string;
  model?: string | undefined;
  effort?: string | undefined;
}): RouteDraft | null =>
  r
    ? { provider: r.provider, model: r.model ?? '', effort: (r.effort as Effort | undefined) ?? '' }
    : null;

function fromView(view: RoutesView): Draft {
  const tasks = new Set([...view.tasks, ...Object.keys(view.config.routes)]);
  return {
    def: toDraft(view.config.default),
    tasks: Object.fromEntries([...tasks].map((t) => [t, toDraft(view.config.routes[t])])),
    fallbacks: [...view.config.fallbacks],
  };
}

const routeOut = (r: RouteDraft) => ({
  provider: r.provider,
  ...(r.model.trim() ? { model: r.model.trim() } : {}),
  ...(r.effort ? { effort: r.effort } : {}),
});

/** The config the server expects. */
export function toConfig(d: Draft) {
  return {
    routes: Object.fromEntries(
      Object.entries(d.tasks).flatMap(([t, r]) => (r ? [[t, routeOut(r)]] : [])),
    ),
    ...(d.def ? { default: routeOut(d.def) } : {}),
    fallbacks: d.fallbacks,
  };
}

/**
 * Which AI provider, model and effort each kind of request uses. Edits are a draft until saved;
 * saving takes effect immediately, with no restart.
 */
export function RoutesEditor({
  view,
  providers,
  onSave,
  onReset,
}: {
  view: RoutesView;
  providers: ProviderStatus[];
  onSave: (config: unknown) => Promise<boolean>;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => fromView(view));
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(toConfig(draft)) !== JSON.stringify(toConfig(fromView(view)));
  const name = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
  const providerOptions = (
    <>
      {view.providers.map((id) => {
        const p = providers.find((x) => x.id === id);
        return (
          <option key={id} value={id}>
            {name(id)}
            {p && !p.available.ok ? ' (unavailable)' : ''}
          </option>
        );
      })}
    </>
  );

  const setRoute = (task: string | 'default', patch: Partial<RouteDraft> | null) =>
    setDraft((d) => {
      const base = task === 'default' ? d.def : d.tasks[task];
      const next =
        patch === null
          ? null
          : {
              ...(base ?? { provider: view.providers[0]!, model: '', effort: '' as const }),
              ...patch,
            };
      return task === 'default'
        ? { ...d, def: next }
        : { ...d, tasks: { ...d.tasks, [task]: next } };
    });

  const row = (
    task: string | 'default',
    label: string,
    route: RouteDraft | null,
    optional: boolean,
  ) => (
    <tr key={task}>
      <th scope="row">
        {label}
        {task !== 'default' && <small> {task}</small>}
      </th>
      <td>
        <select
          aria-label={`Provider for ${label}`}
          value={route?.provider ?? ''}
          onChange={(e) => setRoute(task, e.target.value ? { provider: e.target.value } : null)}
        >
          {optional && <option value="">Use the default</option>}
          {providerOptions}
        </select>
      </td>
      <td>
        <input
          aria-label={`Model for ${label}`}
          list="model-suggestions"
          value={route?.model ?? ''}
          disabled={!route}
          placeholder={route ? "provider's default" : ''}
          onChange={(e) => setRoute(task, { model: e.target.value })}
        />
      </td>
      <td>
        <select
          aria-label={`Effort for ${label}`}
          value={route?.effort ?? ''}
          disabled={!route}
          onChange={(e) => setRoute(task, { effort: e.target.value as RouteDraft['effort'] })}
        >
          <option value="">Default</option>
          {EFFORTS.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </td>
    </tr>
  );

  const unused = view.providers.filter((id) => !draft.fallbacks.includes(id));
  const moveFallback = (i: number, delta: -1 | 1) =>
    setDraft((d) => {
      const f = [...d.fallbacks];
      [f[i], f[i + delta]] = [f[i + delta]!, f[i]!];
      return { ...d, fallbacks: f };
    });

  return (
    <div className="stack">
      <datalist id="model-suggestions">
        {view.models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <table className="routes">
        <thead>
          <tr>
            <th scope="col">Request</th>
            <th scope="col">Provider</th>
            <th scope="col">Model</th>
            <th scope="col">Effort</th>
          </tr>
        </thead>
        <tbody>
          {row('default', 'Default for everything else', draft.def, false)}
          {Object.entries(draft.tasks).map(([t, r]) => row(t, TASK_LABEL[t] ?? t, r, true))}
        </tbody>
      </table>

      <div>
        <span className="field-label">If a provider is unavailable, try these in order</span>
        <ol className="fallbacks" aria-label="Fallback providers">
          {draft.fallbacks.map((id, i) => (
            <li key={id}>
              <span>{name(id)}</span>
              <button
                type="button"
                className="ghost"
                disabled={i === 0}
                aria-label={`Move ${name(id)} up`}
                onClick={() => moveFallback(i, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="ghost"
                disabled={i === draft.fallbacks.length - 1}
                aria-label={`Move ${name(id)} down`}
                onClick={() => moveFallback(i, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="ghost"
                aria-label={`Remove ${name(id)} from fallbacks`}
                onClick={() =>
                  setDraft((d) => ({ ...d, fallbacks: d.fallbacks.filter((x) => x !== id) }))
                }
              >
                ×
              </button>
            </li>
          ))}
        </ol>
        {unused.length > 0 && (
          <select
            aria-label="Add a fallback provider"
            value=""
            onChange={(e) =>
              e.target.value &&
              setDraft((d) => ({ ...d, fallbacks: [...d.fallbacks, e.target.value] }))
            }
          >
            <option value="">Add a fallback…</option>
            {unused.map((id) => (
              <option key={id} value={id}>
                {name(id)}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={!dirty || saving}
          onClick={() => {
            setSaving(true);
            void onSave(toConfig(draft)).finally(() => setSaving(false));
          }}
        >
          {saving ? 'Saving…' : 'Save routes'}
        </button>
        <button type="button" disabled={!dirty} onClick={() => setDraft(fromView(view))}>
          Discard changes
        </button>
        <span className="spacer" />
        {view.custom && (
          <button type="button" className="danger" onClick={onReset}>
            Reset to defaults
          </button>
        )}
      </div>
    </div>
  );
}
