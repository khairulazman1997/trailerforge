import type { LlmPreview } from '@trailerforge/service/client';

/**
 * "What will be sent, and to whom", shown before anything leaves the app. It reads the same
 * route and the same project data the request will use, so it cannot drift from what happens.
 */
export function Disclosure({ preview }: { preview: LlmPreview | null }) {
  if (!preview) return <p role="status">Checking which AI provider will be used…</p>;
  if (!preview.available || !preview.provider) {
    return (
      <p className="error" role="alert">
        No AI provider is available: {preview.reason}. Set <code>ANTHROPIC_API_KEY</code> or install
        Claude Code, then try again.
      </p>
    );
  }
  const { provider, willSend: w } = preview;
  const nothing = w.brief.length === 0 && w.knowledge.length === 0;
  return (
    <section className="disclosure" aria-label="What will be sent" data-testid="disclosure">
      <p>
        <strong>{provider.name}</strong>
        {preview.model ? ` · ${preview.model}` : ''}
        {preview.effort ? ` · ${preview.effort} effort` : ''}
        {preview.fellBack ? ' (your first choice is unavailable, so a fallback is used)' : ''}
        {' — '}
        {provider.kind === 'interactive' ? (
          <span className="stays">
            you copy this request into a chat yourself and paste the reply back; nothing is sent
            automatically
          </span>
        ) : provider.sendsDataOffDevice ? (
          <strong className="leaves">this leaves your computer</strong>
        ) : (
          <span className="stays">this stays on your computer</span>
        )}
        .
      </p>
      <ul>
        <li>
          Brief: {w.brief.length ? w.brief.join(', ') : 'nothing filled in yet'}
          {w.assumptions > 0
            ? ` (+ ${w.assumptions} assumption${w.assumptions === 1 ? '' : 's'})`
            : ''}
        </li>
        <li>
          Game facts: {w.knowledge.length} (names, kinds and short descriptions)
          {w.knowledgeExcluded > 0 ? `; ${w.knowledgeExcluded} you excluded are not sent` : ''}
          {w.knowledge.length > 0 && (
            <details>
              <summary>Show the names</summary>
              <p>{w.knowledge.map((k) => k.name).join(', ')}</p>
            </details>
          )}
        </li>
      </ul>
      <p className="hint">
        Source code, footage and files that look like secrets are never sent.
        {nothing ? ' With nothing filled in the result will be generic.' : ''}
      </p>
    </section>
  );
}
