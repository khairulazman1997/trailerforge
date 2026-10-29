import { useEffect, useState } from 'react';
import type { CritiqueFactsView } from '@trailerforge/service/client';
import { useStore } from '../app-context.js';
import { giveConsent } from '../consent.js';
import { ConfirmDialog } from './Dialog.js';
import { needsConsent, usePreview } from './GenerateDialogs.js';

/**
 * Asks before a critique is written: which provider, exactly what it will be sent (read from the
 * same data the request uses), and, for a service off this computer, an explicit yes.
 */
export function CritiqueDialog({
  id,
  variantId,
  versionName,
  open,
  onClose,
}: {
  id: string;
  variantId: string | null;
  versionName: string;
  open: boolean;
  onClose: () => void;
}) {
  const store = useStore();
  const preview = usePreview(id, 'critique.run', open);
  const [facts, setFacts] = useState<CritiqueFactsView | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void store.critiqueFacts(id, variantId).then((f) => live && setFacts(f));
    return () => {
      live = false;
      setFacts(null);
    };
  }, [store, id, variantId, open]);
  const consentNeeded = needsConsent(preview);
  const provider = preview?.provider;

  return (
    <ConfirmDialog
      open={open}
      title={`Ask for a critique of ${versionName}`}
      confirmLabel="Ask for a critique"
      confirmDisabled={!preview?.available || !facts}
      {...(consentNeeded && provider
        ? { acknowledge: `I understand this information is sent to ${provider.name}.` }
        : {})}
      onCancel={onClose}
      onConfirm={async () => {
        if (!preview?.available) return;
        if (provider?.sendsDataOffDevice) giveConsent(provider.id);
        await store.startTask(id, { kind: 'critique', options: { variantId } });
        onClose();
      }}
    >
      <div className="stack">
        <p>
          The AI reads a text description of this version and writes up to ten notes on the Review
          tab: what weakens it and what to try. Some come with a suggested change that you apply or
          dismiss yourself; nothing changes until you do. A new critique replaces the earlier open
          ones for this version; your own comments stay.
        </p>
        {!preview ? (
          <p role="status">Checking which AI provider will be used…</p>
        ) : !preview.available || !provider ? (
          <p className="error" role="alert">
            No AI provider is available: {preview.reason}. Set <code>ANTHROPIC_API_KEY</code>,
            install Claude Code or Ollama, then try again.
          </p>
        ) : (
          <section className="disclosure" aria-label="What will be sent" data-testid="disclosure">
            <p>
              <strong>{provider.name}</strong>
              {preview.model ? ` · ${preview.model}` : ''}
              {preview.effort ? ` · ${preview.effort} effort` : ''}
              {' — '}
              {provider.kind === 'interactive' ? (
                <span className="stays">
                  you copy this request into a chat yourself and paste the reply back; nothing is
                  sent automatically
                </span>
              ) : provider.sendsDataOffDevice ? (
                <strong className="leaves">this leaves your computer</strong>
              ) : (
                <span className="stays">this stays on your computer</span>
              )}
              .
            </p>
            {facts ? (
              <>
                <p>It is sent:</p>
                <ul data-testid="critique-sent">
                  {facts.summary.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                {facts.excluded > 0 && (
                  <p className="hint">
                    {facts.excluded} game fact{facts.excluded === 1 ? '' : 's'} you excluded{' '}
                    {facts.excluded === 1 ? 'is' : 'are'} left out.
                  </p>
                )}
                <details>
                  <summary>Show the exact text</summary>
                  <pre className="wire" tabIndex={0}>
                    {JSON.stringify(facts.wire, null, 2)}
                  </pre>
                </details>
              </>
            ) : (
              <p role="status">Preparing the description…</p>
            )}
          </section>
        )}
      </div>
    </ConfirmDialog>
  );
}
