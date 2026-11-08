import { useEffect, useState } from 'react';
import type { EffectRequestPreview } from '@trailerforge/service/client';
import { useStore } from '../app-context.js';
import { giveConsent, hasConsent } from '../consent.js';
import { parseSeconds, requestLines, requestProblem } from '../effectcraft-view.js';
import { BrowseButton } from './BrowseButton.js';
import { ConfirmDialog } from './Dialog.js';
import { useBlobUrl } from './useBlobUrl.js';

type Still = { index: number; at: number; sha256: string };

/** What the dialog opens with: empty, or an idea from "Suggest an effect". */
export interface EffectDraft {
  words?: string;
  seconds?: number;
  landAt?: number;
  slotId?: string;
}

/**
 * "Describe an effect": the words, the length and the hit point, optionally an example animation
 * or a reference clip; the AI that would be asked and exactly what it would be sent, before
 * anything is sent. Stills of a reference clip go only if shown first and agreed to.
 */
export function EffectDialog({
  id,
  open,
  onClose,
  slotId,
  initial = {},
}: {
  id: string;
  open: boolean;
  onClose: () => void;
  slotId?: string;
  /** Read once: the dialog is mounted per opening. */
  initial?: EffectDraft;
}) {
  const store = useStore();
  const [words, setWords] = useState(initial.words ?? '');
  const [seconds, setSeconds] = useState(String(initial.seconds ?? 3));
  const [landAt, setLandAt] = useState(initial.landAt !== undefined ? String(initial.landAt) : '');
  const [example, setExample] = useState('');
  const [reference, setReference] = useState('');
  const [stills, setStills] = useState<Still[] | null>(null);
  const [sendStills, setSendStills] = useState(false);
  const [preview, setPreview] = useState<EffectRequestPreview | null>(null);

  const problem = requestProblem({ words, seconds, landAt, hasSource: !!example.trim() || !!reference.trim() }); // prettier-ignore
  const len = parseSeconds(seconds);
  const land = parseSeconds(landAt);

  useEffect(() => {
    if (!open || problem || len === null) return;
    let live = true;
    const t = setTimeout(() => {
      void store
        .effectcraftCall((c) =>
          c.effectRequestPreview(id, {
            words,
            seconds: len,
            ...(land !== null ? { landAt: land } : {}),
          }),
        ) // prettier-ignore
        .then((p) => live && setPreview(p ?? null));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [store, id, open, words, len, land, problem]);

  const provider = preview?.provider;
  const consentNeeded = !!provider?.sendsDataOffDevice && !hasConsent(provider.id);
  const stillsOk = !!stills && !!preview?.stills.possible;

  const showStills = async () => {
    const r = await store.effectcraftCall((c) => c.referenceStills(id, reference.trim()));
    if (r) setStills(r.stills);
  };
  const reset = () => {
    setStills(null);
    setSendStills(false);
  };

  return (
    <ConfirmDialog
      open={open}
      title="Describe an effect"
      confirmLabel="Write the effect"
      confirmDisabled={!!problem || !provider || (sendStills && !stillsOk)}
      {...(consentNeeded && provider
        ? { acknowledge: `I understand this information is sent to ${provider.name}.` }
        : {})}
      onCancel={onClose}
      onConfirm={async () => {
        if (problem || len === null || !provider) return;
        if (provider.sendsDataOffDevice) giveConsent(provider.id);
        await store.startTask(id, {
          kind: 'effectcraft-author',
          options: {
            words: words.trim(),
            seconds: len,
            ...(land !== null ? { landAt: land } : {}),
            ...(example.trim() ? { example: { file: example.trim() } } : {}),
            ...(reference.trim()
              ? {
                  reference: {
                    file: reference.trim(),
                    ...(sendStills && stills
                      ? { stills: { consent: true as const, sha256: stills.map((s) => s.sha256) } }
                      : {}),
                  },
                }
              : {}),
            ...(slotId ? { slotId } : {}),
          },
        });
        onClose();
      }}
    >
      <div className="stack">
        <p>
          The AI writes the effect as EffectCraft commands; you see a preview and decide. Nothing
          changes in your project until you accept it, and you can undo that.
        </p>
        <label>
          What should it look like?
          <textarea
            value={words}
            rows={3}
            maxLength={2000}
            onChange={(e) => setWords(e.target.value)}
            placeholder="The title slams in with orange sparks on the hit"
          />
        </label>
        <div className="row">
          <label>
            Length (seconds)
            <input
              value={seconds}
              inputMode="decimal"
              onChange={(e) => setSeconds(e.target.value)}
            />
          </label>
          <label>
            The hit lands at (seconds, optional)
            <input value={landAt} inputMode="decimal" onChange={(e) => setLandAt(e.target.value)} />
          </label>
        </div>
        <label>
          Start from an example (a Lottie .json, optional)
          <span className="row">
            <input
              value={example}
              onChange={(e) => setExample(e.target.value)}
              placeholder="C:\Effects\sting.json"
            />{' '}
            {/* prettier-ignore */}
            <BrowseButton file label="Choose file…" onPick={setExample} />
          </span>
        </label>
        <label>
          Match the style of a reference clip (optional; never your game footage)
          <span className="row">
            <input
              value={reference}
              onChange={(e) => {
                setReference(e.target.value);
                reset();
              }}
              placeholder="C:\References\title-sting.mp4"
            />
            <BrowseButton
              file
              label="Choose file…"
              onPick={(p) => {
                setReference(p);
                reset();
              }}
            />
          </span>
        </label>
        {reference.trim() && (
          <p className="hint">
            Only measurements of the clip go to the AI: its length, where things appear, flash or
            fade, its main colours and how things move. The clip itself stays here.
          </p>
        )}
        {problem && (
          <p className="hint" role="status">
            {problem}
          </p>
        )}
        {!problem && !preview && <p role="status">Checking which AI will be used…</p>}
        {preview && !provider && (
          <p className="error" role="alert">
            No AI is available: {preview.reason}. Set <code>ANTHROPIC_API_KEY</code>, or ask Claude
            Code to write the effect with its <code>effectcraft_author</code> tool.
          </p>
        )}
        {preview && provider && (
          <section
            className="disclosure"
            aria-label="What will be sent"
            data-testid="effect-disclosure"
          >
            {' '}
            {/* prettier-ignore */}
            <p>
              <strong>{provider.name}</strong>
              {preview.model ? ` · ${preview.model}` : ''}
              {' — '}
              {provider.sendsDataOffDevice ? (
                <strong className="leaves">this leaves your computer</strong>
              ) : (
                <span className="stays">this stays on your computer</span>
              )}
              .
            </p>
            <p>It is sent, as text:</p>
            <ul data-testid="effect-sent">
              {requestLines(preview.wire).map((l) => (
                <li key={l}>{l}</li>
              ))}
              {!!example.trim() && (
                <li>The structure of your example: its layers and their words.</li>
              )}
              {!!reference.trim() && <li>Measurements of the reference clip.</li>}
            </ul>
            {preview.excluded > 0 && (
              <p className="hint">
                {preview.excluded} game fact{preview.excluded === 1 ? '' : 's'} you excluded{' '}
                {preview.excluded === 1 ? 'is' : 'are'} left out.
              </p>
            )}
            <details>
              <summary>Show the exact text</summary>
              <pre className="wire" tabIndex={0}>
                {JSON.stringify(preview.wire, null, 2)}
              </pre>
            </details>
            {reference.trim() && (
              <div className="stills">
                <p>Pictures from the clip are not sent unless you look at them first and agree.</p>
                {!stills ? (
                  <button type="button" onClick={() => void showStills()}>
                    Show the 8 pictures that would be sent
                  </button>
                ) : (
                  <>
                    <ul className="still-grid" aria-label="Pictures that would be sent">
                      {stills.map((s) => (
                        <li key={s.sha256}>
                          <StillImage id={id} file={reference.trim()} still={s} />
                        </li>
                      ))}
                    </ul>
                    {preview.stills.possible ? (
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={sendStills}
                          onChange={(e) => setSendStills(e.target.checked)}
                        />
                        Also send these 8 pictures to {provider.name}
                      </label>
                    ) : (
                      <p className="hint">{preview.stills.why}; only the measurements are sent.</p>
                    )}
                  </>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </ConfirmDialog>
  );
}

function StillImage({ id, file, still }: { id: string; file: string; still: Still }) {
  const store = useStore();
  const url = useBlobUrl(
    () => store.effectcraftCall((c) => c.referenceStill(id, file, still.index)),
    `${id}|${file}|${still.sha256}`,
  );
  return url ? (
    <img src={url} alt={`Still at ${still.at.toFixed(2)} seconds`} width={96} />
  ) : (
    <span className="hint">…</span>
  );
}
