import { useEffect, useState } from 'react';
import type { EffectSuggestFactsView } from '@trailerforge/service/client';
import { useStore } from '../app-context.js';
import { giveConsent } from '../consent.js';
import { ConfirmDialog } from './Dialog.js';
import { needsConsent, usePreview } from './GenerateDialogs.js';

/**
 * "Suggest an effect": which AI is asked and exactly what it is sent (a text description of the
 * cut), then a task whose result is up to three ideas. Nothing is stored; picking an idea opens
 * "Describe an effect" filled in. Mounted only while open.
 */
export function SuggestEffectDialog({
  id,
  onStarted,
  onClose,
}: {
  id: string;
  onStarted: (taskId: string) => void;
  onClose: () => void;
}) {
  const store = useStore();
  const preview = usePreview(id, 'effectcraft.suggest', true);
  const [facts, setFacts] = useState<EffectSuggestFactsView | null>(null);
  useEffect(() => {
    let live = true;
    void store
      .effectcraftCall((c) => c.effectSuggestFacts(id))
      .then((f) => live && f && setFacts(f));
    return () => {
      live = false;
    };
  }, [store, id]);
  const provider = preview?.provider;
  const consentNeeded = needsConsent(preview);

  return (
    <ConfirmDialog
      open
      title="Suggest an effect"
      confirmLabel="Suggest effects"
      confirmDisabled={!preview?.available || !facts}
      {...(consentNeeded && provider
        ? { acknowledge: `I understand this information is sent to ${provider.name}.` }
        : {})}
      onCancel={onClose}
      onConfirm={async () => {
        if (!preview?.available) return;
        if (provider?.sendsDataOffDevice) giveConsent(provider.id);
        const t = await store.startTask(id, { kind: 'effectcraft-suggest' });
        if (t) onStarted(t.id);
        onClose();
      }}
    >
      <div className="stack">
        <p>
          The AI reads a text description of your cut and suggests up to three custom effects. Pick
          one to fill in "Describe an effect"; nothing is written or added until you go on from
          there.
        </p>
        {!preview ? (
          <p role="status">Checking which AI provider will be used…</p>
        ) : !preview.available || !provider ? (
          <p className="error" role="alert">
            No AI provider is available: {preview.reason}. Set <code>ANTHROPIC_API_KEY</code>,
            install Claude Code or Ollama, then try again.
          </p>
        ) : (
          <section
            className="disclosure"
            aria-label="What will be sent"
            data-testid="suggest-disclosure"
          >
            <p>
              <strong>{provider.name}</strong>
              {preview.model ? ` · ${preview.model}` : ''}
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
                <ul data-testid="suggest-sent">
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
