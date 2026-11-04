import { useEffect, useRef, useState, type DragEvent } from 'react';
import { tapTempo } from '@trailerforge/cut';
import { PLATFORM_NAMES, PLATFORM_SAFE } from '@trailerforge/graphics';
import { useAppState, useStore } from '../app-context.js';
import { Teleprompter } from '../components/Teleprompter.js';
import { BrowseButton } from '../components/BrowseButton.js';
import { giveConsent } from '../consent.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { needsConsent, usePreview } from '../components/GenerateDialogs.js';
import { desktop } from '../desktop.js';
import { Link, projectPath } from '../router.js';
import { busyTask } from '../store.js';
import { usePending } from '../use-pending.js';
import {
  acceptsLabel,
  cueTime,
  inputFor,
  progressLabel,
  shortCues,
  splitIdeas,
} from '../tiktok-view.js';

type Short = NonNullable<ReturnType<typeof useShorts>>['shorts'][number];

function useShorts(id: string) {
  return useAppState((s) => s.shorts[id]?.view);
}

/** Paths of dropped files, where the host can say (the desktop app); browsers hide them. */
function droppedPaths(e: DragEvent): string[] {
  const d = desktop();
  return [...e.dataTransfer.files]
    .map((f) => d?.pathForFile?.(f) ?? (f as File & { path?: string }).path ?? '')
    .filter(Boolean);
}

/** Short videos for TikTok, Shorts and Reels: concepts in, a filled template, a finished cut out. */
export function TikTokPage({ id }: { id: string }) {
  const store = useStore();
  const version = useAppState((s) => s.projects[id]!.version);
  const busy = useAppState((s) => busyTask(s, id));
  const view = useShorts(id);
  const [ideas, setIdeas] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [appAi, setAppAi] = useState(false);
  const [claude, setClaude] = useState(false);
  useEffect(() => {
    void store.refreshShorts(id);
  }, [store, id, version]);

  const disabled = !!busy;
  const shorts = view?.shorts ?? [];
  const current = shorts.find((s) => s.id === picked) ?? shorts[0];
  const concepts = view?.concepts ?? [];

  return (
    <>
      <h1>TikTok</h1>
      <p>
        Short vertical videos about the game. Start from an idea, pick a concept, fill the template
        with your recordings, images and voiceover, and TrailerForge cuts it. Review and export it
        on the Review and Export tabs, where it appears as its own version.
      </p>

      <section aria-labelledby="tt-ideas">
        <h2 id="tt-ideas">Concepts</h2>
        <label className="field">
          <span>Your ideas (one per line, optional)</span>
          <textarea
            rows={3}
            value={ideas}
            disabled={disabled}
            onChange={(e) => setIdeas(e.target.value)}
            placeholder="Show the parry timing&#10;Every boss in 30 seconds"
          />
        </label>
        <div className="row">
          <button type="button" disabled={disabled} onClick={() => setAppAi(true)}>
            Suggest concepts
          </button>
          <button type="button" disabled={disabled} onClick={() => setClaude(true)}>
            Ask Claude Code…
          </button>
        </div>
        {concepts.length === 0 ? (
          <p className="muted">No concepts waiting. Suggest some, or ask Claude Code.</p>
        ) : (
          <ul className="tt-concepts">
            {concepts.map((c) => (
              <li key={c.id} className="card">
                <h3>{c.title}</h3>
                <p>
                  <span className="chip">{c.source ?? 'user'}</span>{' '}
                  <span className="muted">
                    {c.formatId.replace('game-trailer/tiktok-', '')} · about {c.targetSeconds} s
                  </span>
                </p>
                <p>
                  <strong>Hook:</strong> {c.hook}
                </p>
                {c.pitch ? <p className="muted">{c.pitch}</p> : null}
                <div className="row">
                  <button
                    type="button"
                    className="primary"
                    disabled={disabled}
                    onClick={() =>
                      void store.createShort(id, { conceptId: c.id }).then((sid) => {
                        if (sid) setPicked(sid);
                      })
                    }
                  >
                    Make this TikTok
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`Remove concept ${c.title}`}
                    onClick={() =>
                      void store.command(id, 'core/concepts.remove', { conceptIds: [c.id] })
                    }
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="tt-list">
        <h2 id="tt-list">Your TikToks</h2>
        {shorts.length === 0 ? (
          <p className="muted">None yet. Make one from a concept above.</p>
        ) : (
          <div className="row" role="group" aria-label="Choose a TikTok">
            {shorts.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={s.id === current?.id}
                onClick={() => setPicked(s.id)}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
      </section>

      {current && <ShortEditor key={current.id} id={id} short={current} disabled={disabled} />}

      <AppConceptsDialog id={id} open={appAi} ideas={ideas} onClose={() => setAppAi(false)} />
      <ClaudeConceptsDialog id={id} open={claude} ideas={ideas} onClose={() => setClaude(false)} />
    </>
  );
}

function AppConceptsDialog({
  id,
  open,
  ideas,
  onClose,
}: {
  id: string;
  open: boolean;
  ideas: string;
  onClose: () => void;
}) {
  const store = useStore();
  const preview = usePreview(id, 'tiktok.concepts', open);
  const provider = preview?.provider;
  return (
    <ConfirmDialog
      open={open}
      title="Suggest concepts"
      confirmLabel="Suggest"
      confirmDisabled={!preview?.available}
      {...(needsConsent(preview) && provider
        ? { acknowledge: `I understand this information is sent to ${provider.name}.` }
        : {})}
      onCancel={onClose}
      onConfirm={async () => {
        if (!preview?.available) return;
        if (provider?.sendsDataOffDevice) giveConsent(provider.id);
        await store.startTask(id, {
          kind: 'tiktok-concepts',
          options: { ideas: splitIdeas(ideas) },
        });
        onClose();
      }}
    >
      <div className="stack">
        <p>
          The AI proposes TikTok concepts from your brief, the game facts you allow, and your ideas.
          They wait here until you pick one.
        </p>
        {!preview ? (
          <p role="status">Checking which AI provider will be used…</p>
        ) : !preview.available || !provider ? (
          <p className="error" role="alert">
            No AI provider is available: {preview.reason}.
          </p>
        ) : (
          <p data-testid="disclosure">
            Sent to <strong>{provider.name}</strong>
            {preview.model ? ` (${preview.model})` : ''}: the brief, the game facts not excluded
            from AI use, and your ideas. Never footage or game files.
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}

function ClaudeConceptsDialog({
  id,
  open,
  ideas,
  onClose,
}: {
  id: string;
  open: boolean;
  ideas: string;
  onClose: () => void;
}) {
  const store = useStore();
  const [preview, setPreview] = useState<Awaited<
    ReturnType<typeof store.claudeConceptsPreview>
  > | null>(null);
  const list = splitIdeas(ideas);
  const key = list.join('\n');
  useEffect(() => {
    if (!open) return;
    let live = true;
    void store.claudeConceptsPreview(id, splitIdeas(key)).then((p) => live && setPreview(p));
    return () => {
      live = false;
      setPreview(null);
    };
  }, [store, id, open, key]);
  return (
    <ConfirmDialog
      open={open}
      title="Ask Claude Code for concepts"
      confirmLabel="Run Claude Code"
      confirmDisabled={!preview}
      acknowledge="I understand Claude Code will read these project files (secrets excluded) in a read-only copy."
      onCancel={onClose}
      onConfirm={async () => {
        await store.startTask(id, {
          kind: 'claude-code-concepts',
          options: { allow: true, ideas: list },
        });
        onClose();
      }}
    >
      <div className="stack">
        {!preview ? (
          <p role="status">Preparing what would be shared…</p>
        ) : (
          <>
            <p className="warn-text">{preview.warning}</p>
            <p>
              {preview.files} file{preview.files === 1 ? '' : 's'} from <code>{preview.repo}</code>
              {preview.truncated ? ' (the list is cut short)' : ''}.
            </p>
            <details>
              <summary>The request Claude Code receives</summary>
              <pre className="tt-prompt">{preview.prompt}</pre>
            </details>
          </>
        )}
      </div>
    </ConfirmDialog>
  );
}

function ShortEditor({ id, short, disabled }: { id: string; short: Short; disabled: boolean }) {
  const store = useStore();
  const timelines = useAppState((s) => s.projects[id]!.project.timelines);
  const voice = useAppState((s) => s.shorts[id]?.view.voice);
  const [over, setOver] = useState<string | null>(null);
  const [safe, setSafe] = useState(true);
  const [prompter, setPrompter] = useState(false);
  const [paste, setPaste] = useState<Record<string, string>>({});
  const [enabled, setEnabledNow] = usePending(
    useAppState(
      (st) =>
        st.projects[id]!.project.shorts.find((x) => x.id === short.id)?.subtitles.enabled ??
        short.subtitles.enabled,
    ),
  );
  const cues = short.subtitles.enabled ? shortCues(timelines, short.id) : [];
  const run = (type: string, payload: Record<string, unknown>) =>
    store.command(id, type, { shortId: short.id, ...payload });

  const put = (
    target: { slotId?: string; voLineId?: string },
    accepts: readonly string[],
    path: string,
  ) =>
    store.fillShort(id, short.id, {
      ...target,
      path,
      input: target.voLineId ? 'voiceover' : inputFor(accepts, path),
    });
  const dropOn = (
    e: DragEvent,
    key: string,
    target: { slotId?: string; voLineId?: string },
    accepts: readonly string[],
  ) => {
    e.preventDefault();
    setOver(null);
    const p = droppedPaths(e)[0];
    if (p) void put(target, accepts, p);
    else
      store.toast(
        'error',
        'This browser does not share where dropped files are. Paste the file path instead (the desktop app handles drops).',
      );
    void key;
  };

  const zone = (
    key: string,
    target: { slotId?: string; voLineId?: string },
    accepts: readonly string[],
    label: string,
  ) => (
    <div
      className={`foot-drop${over === key ? ' over' : ''}`}
      role="group"
      aria-label={`Drop a file for ${label}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(key);
      }}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => dropOn(e, key, target, accepts)}
    >
      <label className="field">
        <span>Path to {target.voLineId ? 'the recording' : acceptsLabel(accepts)}</span>
        <input
          type="text"
          value={paste[key] ?? ''}
          disabled={disabled}
          onChange={(e) => setPaste({ ...paste, [key]: e.target.value })}
        />
      </label>
      <div className="row">
        <button
          type="button"
          disabled={disabled || !(paste[key] ?? '').trim()}
          onClick={() =>
            void put(target, accepts, paste[key]!.trim()).then(
              (ok) => ok && setPaste({ ...paste, [key]: '' }),
            )
          }
        >
          Use this file
        </button>
        <BrowseButton
          file
          disabled={disabled}
          label="Browse…"
          onPick={(p) => void put(target, accepts, p)}
        />
        <span className="muted">or drop a file here</span>
      </div>
    </div>
  );

  const inset = PLATFORM_SAFE[short.platform];
  const ready = short.progress.slotsFilled > 0 || short.progress.linesRecorded > 0;

  return (
    <section aria-labelledby="tt-edit" className="tt-editor">
      <h2 id="tt-edit">{short.name}</h2>
      <p>
        {short.concept.formatName} · {short.concept.source} concept. <strong>Hook:</strong>{' '}
        {short.concept.hook}
      </p>
      <p role="status">{progressLabel(short.progress)}</p>
      {!short.hasTemplate && <p className="warn-text">The template has not been built yet.</p>}

      <div className="row">
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            void store.startTask(id, {
              kind: 'build-short',
              options: { shortId: short.id, wording: false },
            })
          }
        >
          Rebuild template (keeps your files and edits)
        </button>
        <button
          type="button"
          className="primary"
          disabled={disabled || !ready}
          onClick={() =>
            void store.startTask(id, { kind: 'short-cut', options: { shortId: short.id } })
          }
        >
          {short.cut.built ? 'Rebuild the cut' : 'Generate the TikTok'}
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Remove ${short.name}`}
          onClick={() => void run('core/shorts.remove', {})}
        >
          Remove
        </button>
      </div>
      {short.cut.built && (
        <p>
          Cut built ({short.cut.mode} mode
          {short.cut.seconds !== null ? `, ${short.cut.seconds.toFixed(1)} s` : ''}). Review it and
          export it on the <Link to={projectPath(id, 'review')}>Review</Link> and{' '}
          <Link to={projectPath(id, 'export')}>Export</Link> tabs.
        </p>
      )}

      <h3>Shots</h3>
      <ol className="tt-slots">
        {short.slots
          .filter((s) => s.kind === 'shot')
          .map((s) => (
            <li key={s.id} className="card">
              <strong>{s.title}</strong>{' '}
              <span className="muted">
                {s.sectionName} · {s.seconds.toFixed(1)} s
              </span>
              <p>
                {s.chosen ? (
                  <>
                    <span className="chip">filled</span> {s.chosen.name}{' '}
                    <button
                      type="button"
                      disabled={disabled || s.locked}
                      onClick={() => void run('core/shorts.clear-slot', { slotId: s.id })}
                    >
                      Clear
                    </button>
                  </>
                ) : (
                  <span className="muted">Empty: takes {acceptsLabel(s.accepts)}.</span>
                )}
              </p>
              {!s.locked && zone(s.id, { slotId: s.id }, s.accepts, s.title)}
            </li>
          ))}
      </ol>

      {short.voiceLines.length > 0 && (
        <>
          <h3>Record script</h3>
          <p className="muted">
            Read these lines and add the recording: one file per line, or one long take of the whole
            script.
          </p>
          <ol className="tt-vo">
            {short.voiceLines.map((l) => (
              <li key={l.id} className="card">
                <p>{l.text}</p>
                <p>
                  {l.chosen ? (
                    <span className="chip">recorded</span>
                  ) : (
                    <span className="muted">Not recorded.</span>
                  )}{' '}
                  {l.chosen?.name}
                </p>
                {zone(l.id, { voLineId: l.id }, ['voiceover'], 'a voiceover line')}
              </li>
            ))}
          </ol>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={disabled}
              onClick={() => setPrompter(true)}
            >
              Record the script in the app
            </button>
            <button
              type="button"
              disabled={disabled || short.progress.linesRecorded === 0}
              onClick={() =>
                void store.startTask(id, { kind: 'place-voice', options: { shortId: short.id } })
              }
            >
              Find the lines in the recording
            </button>
            {voice && voice.status !== 'ready' && (
              <span className="muted">
                A long take needs the local voice model (Settings); files per line work without it.
              </span>
            )}
          </div>
        </>
      )}

      {short.voiceLines.length > 0 && <VoiceCleanPanel id={id} short={short} disabled={disabled} />}

      <Teleprompter
        id={id}
        shortId={short.id}
        lines={short.voiceLines}
        open={prompter}
        onClose={() => setPrompter(false)}
      />

      <PostPanel id={id} short={short} disabled={disabled} />

      <HooksPanel id={id} short={short} disabled={disabled} />

      <MusicPanel id={id} short={short} disabled={disabled} />

      <h3>Platform and subtitles</h3>
      <div className="row">
        <label className="field">
          <span>Made for</span>
          <select
            value={short.platform}
            disabled={disabled}
            onChange={(e) => void run('core/shorts.set-subtitles', { platform: e.target.value })}
          >
            {Object.entries(PLATFORM_NAMES).map(([k, n]) => (
              <option key={k} value={k}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={enabled}
            disabled={disabled}
            onChange={(e) =>
              void setEnabledNow(e.target.checked, () =>
                run('core/shorts.set-subtitles', { enabled: e.target.checked }),
              )
            }
          />
          <span>Subtitles synced to the voiceover</span>
        </label>
        <label className="field">
          <span>Style</span>
          <select
            value={short.subtitles.style}
            disabled={disabled || !enabled}
            onChange={(e) => void run('core/shorts.set-subtitles', { style: e.target.value })}
          >
            <option value="lines">Sentence lines</option>
            <option value="word-pop">Big words, spoken one lit</option>
          </select>
        </label>
      </div>

      <div className="tt-preview">
        <div
          className="tt-frame"
          role="img"
          aria-label={`Vertical frame for ${PLATFORM_NAMES[short.platform]}${safe ? ' with the covered areas shaded' : ''}`}
        >
          {safe && (
            <div
              className="tt-unsafe"
              style={{
                top: `${inset.top * 100}%`,
                right: `${inset.right * 100}%`,
                bottom: `${inset.bottom * 100}%`,
                left: `${inset.left * 100}%`,
              }}
            />
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={safe} onChange={(e) => setSafe(e.target.checked)} />
          <span>Show where the app's own buttons and captions cover the picture</span>
        </label>
      </div>

      {short.subtitles.enabled && (
        <>
          <h3>Subtitle text</h3>
          {cues.length === 0 ? (
            <p className="muted">Generate the TikTok to see its subtitles here.</p>
          ) : (
            <ul className="tt-cues">
              {cues.map((c) => (
                <li key={`${c.key}:${c.text}`}>
                  <span className="muted">{cueTime(c.start)}</span>{' '}
                  <input
                    type="text"
                    aria-label={`Subtitle at ${cueTime(c.start)}`}
                    defaultValue={c.text}
                    disabled={disabled}
                    onBlur={(e) => {
                      const text = e.target.value.trim();
                      if (text && text !== c.text)
                        void run('core/shorts.edit-cue', { key: c.key, words: c.words, text });
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
          {short.subtitles.edits > 0 && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => void run('core/shorts.reset-cues', {})}
            >
              Undo all {short.subtitles.edits} hand edit{short.subtitles.edits === 1 ? '' : 's'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

const NO_MUSIC: never[] = [];

/** Music for the cut, a tapped-in tempo when there is no music file, and whether to export without the music. */
function MusicPanel({ id, short, disabled }: { id: string; short: Short; disabled: boolean }) {
  const store = useStore();
  const music = useAppState((s) => s.footage[id]?.status.music) ?? NO_MUSIC;
  const stored = useAppState((s) => s.projects[id]!.project.shorts.find((x) => x.id === short.id));
  const mode = stored?.export?.music ?? 'both';
  const [taps, setTaps] = useState<number[]>([]);
  const last = useRef(0);
  useEffect(() => {
    void store.refreshFootage(id);
  }, [store, id]);
  const result = taps.length >= 4 ? tapTempo(taps) : null;
  const run = (type: string, payload: Record<string, unknown>) =>
    store.command(id, type, { shortId: short.id, ...payload });
  const tap = () => {
    const now = performance.now() / 1000;
    // A pause of more than two seconds starts a new run.
    setTaps((t) => (t.length && now - last.current > 2 ? [now] : [...t, now]));
    last.current = now;
  };
  return (
    <section aria-labelledby="tt-music">
      <h3 id="tt-music">Music and tempo</h3>
      <p className="muted">
        Trending sounds can only be added inside the TikTok app, so the TikTok can be exported with
        the music, without it, or both. Without music the cut still follows a beat: tap the tempo
        in, or choose a reference song that is used for its beat only and never exported.
      </p>
      <div className="row">
        <label className="field">
          <span>Music file</span>
          <select
            value={short.music.assetId ?? ''}
            disabled={disabled}
            onChange={(e) =>
              void run('core/shorts.set-music', {
                assetId: e.target.value || null,
                timingOnly: stored?.storyboard?.music.timingOnly === true,
              })
            }
          >
            <option value="">None</option>
            {music.map((m) => (
              <option key={m.assetId} value={m.assetId}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={short.music.timingOnly}
            disabled={disabled || !short.music.assetId}
            onChange={(e) =>
              void run('core/shorts.set-music', {
                assetId: short.music.assetId,
                timingOnly: e.target.checked,
              })
            }
          />
          <span>Use it for the beat only (never exported)</span>
        </label>
        <label className="field">
          <span>Export</span>
          <select
            value={mode}
            disabled={disabled}
            onChange={(e) =>
              void store.command(id, 'core/export.set', {
                variantId: short.id,
                ...(stored?.export ? {} : { presetId: 'core/tiktok' }),
                music: e.target.value,
              })
            }
          >
            <option value="both">With and without music</option>
            <option value="with">With music</option>
            <option value="without">Without music</option>
          </select>
        </label>
      </div>
      <div className="row">
        <button type="button" onClick={tap} disabled={disabled}>
          Tap the beat
        </button>
        <span role="status">
          {short.music.tempo !== null && `Tempo ${short.music.tempo} BPM. `}
          {taps.length === 0
            ? 'Tap along to set a tempo (four taps or more).'
            : result === null
              ? `${taps.length} tap${taps.length === 1 ? '' : 's'}…`
              : result.ok
                ? `${result.tempo} BPM from your taps (steadiness ${Math.round(result.steadiness * 100)}%).`
                : result.reason}
        </span>
        {result?.ok && (
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              void run('core/shorts.set-grid', {
                patch: { tempo: result.tempo, offset: result.offset },
              }).then(() => setTaps([]))
            }
          >
            Use {result.tempo} BPM
          </button>
        )}
        {taps.length > 0 && (
          <button type="button" onClick={() => setTaps([])}>
            Start over
          </button>
        )}
        {short.music.tempo !== null && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void run('core/shorts.set-grid', { patch: { tempo: null } })}
          >
            Use the music's own beat
          </button>
        )}
      </div>
    </section>
  );
}

/** Voice clean-up switch, and each recording's loudness before and after (measured on request). */
function VoiceCleanPanel({ id, short, disabled }: { id: string; short: Short; disabled: boolean }) {
  const store = useStore();
  const [on, setOn] = usePending(
    useAppState(
      (st) =>
        st.projects[id]!.project.shorts.find((x) => x.id === short.id)?.voiceClean ??
        short.voiceClean,
    ),
  );
  const [report, setReport] = useState<Awaited<ReturnType<typeof store.voiceClean>>>(null);
  const [loading, setLoading] = useState(false);
  const db = (x: number | null) => (x === null ? '?' : x.toFixed(1));
  return (
    <div className="stack">
      <div className="row">
        <label className="check">
          <input
            type="checkbox"
            checked={on}
            disabled={disabled}
            onChange={(e) =>
              void setOn(e.target.checked, () =>
                store.command(id, 'core/shorts.set-voice-clean', {
                  shortId: short.id,
                  enabled: e.target.checked,
                }),
              )
            }
          />
          <span>
            Clean up the voice (less hiss and harsh “s” sounds, even level; your files are not
            changed)
          </span>
        </label>
        <button
          type="button"
          disabled={disabled || loading || short.progress.linesRecorded === 0}
          onClick={() => {
            setLoading(true);
            void store
              .voiceClean(id, short.id)
              .then(setReport)
              .finally(() => setLoading(false));
          }}
        >
          {loading ? 'Measuring…' : 'Show voice levels'}
        </button>
      </div>
      {report && (
        <ul className="tt-cues" aria-label="Voice levels">
          {report.lines.map((l) => (
            <li key={l.voLineId}>
              <span className="muted">{l.text}</span>{' '}
              {l.info
                ? `${db(l.info.before.lufs)} → ${db(l.info.after.lufs)} LUFS after clean-up, then ${l.info.gainDb >= 0 ? '+' : ''}${l.info.gainDb} dB to ${report.targetLufs} LUFS`
                : (l.error ?? 'not recorded')}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Alternative openings for A/B tests: each one exports as its own version of the TikTok. */
function HooksPanel({ id, short, disabled }: { id: string; short: Short; disabled: boolean }) {
  const store = useStore();
  const [ask, setAsk] = useState(false);
  const run = (type: string, payload: Record<string, unknown>) =>
    store.command(id, type, { shortId: short.id, ...payload });
  const full = short.hooks.length >= 3;
  return (
    <section aria-labelledby="tt-hooks">
      <h3 id="tt-hooks">Hook versions</h3>
      <p className="muted">
        Try different openings on the same video: another first shot or other words over it. The
        rest stays the same. Each version has its own review and exports as its own file, so you can
        compare how they perform.
      </p>
      {!short.hasTemplate ? (
        <p className="muted">Build the template first.</p>
      ) : (
        <>
          <div className="row">
            <button
              type="button"
              disabled={disabled || full}
              onClick={() => void run('core/shorts.add-hook', { hook: { name: `Hook ${'ABC'[short.hooks.length]}` } })} // prettier-ignore
            >
              Add a hook version
            </button>
            <button type="button" disabled={disabled || full} onClick={() => setAsk(true)}>
              Suggest hook versions
            </button>
            {full && <span className="muted">Three is the most.</span>}
          </div>
          <ul className="tt-concepts">
            {short.hooks.map((h) => (
              <li key={h.id} className="card">
                <label className="field">
                  <span>Name</span>
                  <input
                    key={`n:${h.name}`}
                    type="text"
                    defaultValue={h.name}
                    disabled={disabled}
                    onBlur={
                      (e) =>
                      e.target.value.trim() &&
                      e.target.value.trim() !== h.name &&
                      void run('core/shorts.edit-hook', { hookId: h.id, patch: { name: e.target.value.trim() } }) // prettier-ignore
                    }
                  />
                </label>
                <label className="field">
                  <span>Words over the opening (empty for none)</span>
                  <input
                    key={`c:${h.caption}`}
                    type="text"
                    defaultValue={h.caption}
                    disabled={disabled}
                    onBlur={
                      (e) =>
                      e.target.value.trim() !== h.caption &&
                      void run('core/shorts.edit-hook', { hookId: h.id, patch: { caption: e.target.value.trim() } }) // prettier-ignore
                    }
                  />
                </label>
                {short.opening && short.opening.takes.length > 1 && (
                  <label className="field">
                    <span>Recording of the opening shot</span>
                    <select
                      value={h.takeId ?? ''}
                      disabled={disabled}
                      onChange={
                        (e) =>
                        void run('core/shorts.edit-hook', { hookId: h.id, patch: { takeId: e.target.value || null } }) // prettier-ignore
                      }
                    >
                      <option value="">The chosen one</option>
                      {short.opening.takes.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {h.why && <p className="muted">{h.why}</p>}
                <p className="muted">
                  Review and export it as <code>{h.versionId}</code> on the{' '}
                  <Link to={projectPath(id, 'review')}>Review</Link> and{' '}
                  <Link to={projectPath(id, 'export')}>Export</Link> tabs.
                </p>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove hook version ${h.name}`}
                  onClick={() => void run('core/shorts.remove-hook', { hookId: h.id })}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <HooksDialog id={id} shortId={short.id} open={ask} onClose={() => setAsk(false)} />
    </section>
  );
}

function HooksDialog({
  id,
  shortId,
  open,
  onClose,
}: {
  id: string;
  shortId: string;
  open: boolean;
  onClose: () => void;
}) {
  const store = useStore();
  const preview = usePreview(id, 'tiktok.hooks', open);
  const provider = preview?.provider;
  return (
    <ConfirmDialog
      open={open}
      title="Suggest hook versions"
      confirmLabel="Suggest"
      confirmDisabled={!preview?.available}
      {...(needsConsent(preview) && provider
        ? { acknowledge: `I understand this information is sent to ${provider.name}.` }
        : {})}
      onCancel={onClose}
      onConfirm={async () => {
        if (!preview?.available) return;
        if (provider?.sendsDataOffDevice) giveConsent(provider.id);
        await store.startTask(id, { kind: 'hooks', options: { shortId } });
        onClose();
      }}
    >
      <div className="stack">
        <p>
          The AI proposes openings: different words over the first shot, or none for a cold open.
          They fill the free places; the ones you made stay.
        </p>
        {!preview ? (
          <p role="status">Checking which AI provider will be used…</p>
        ) : !preview.available || !provider ? (
          <p className="error" role="alert">
            No AI provider is available: {preview.reason}.
          </p>
        ) : (
          <p data-testid="disclosure">
            Sent to <strong>{provider.name}</strong>
            {preview.model ? ` (${preview.model})` : ''}: the concept, the brief and the game facts
            not excluded from AI use. Never recordings or game files.
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}

/** Caption, hashtags, pinned comment and the cover: written beside the export (.post.txt, .cover.png). */
function PostPanel({ id, short, disabled }: { id: string; short: Short; disabled: boolean }) {
  const store = useStore();
  const [ask, setAsk] = useState(false);
  const run = (type: string, payload: Record<string, unknown>) =>
    store.command(id, type, { shortId: short.id, ...payload });
  const tags = short.post.hashtags.map((t) => `#${t}`).join(' ');
  return (
    <section aria-labelledby="tt-post">
      <h3 id="tt-post">Post text and cover</h3>
      <p className="muted">
        What goes with the video when you post it. It is saved next to the export as a text file,
        with the cover image.
      </p>
      <div className="row">
        <button
          type="button"
          disabled={disabled || !short.hasTemplate}
          onClick={() => setAsk(true)}
        >
          Write it with the AI
        </button>
      </div>
      <label className="field">
        <span>Caption ({short.post.caption.length} of 2200 characters)</span>
        <textarea
          key={`cap:${short.post.caption}`}
          rows={3}
          defaultValue={short.post.caption}
          disabled={disabled}
          onBlur={(e) =>
            e.target.value.trim() !== short.post.caption &&
            void run('core/shorts.set-post-copy', { caption: e.target.value })
          }
        />
      </label>
      <label className="field">
        <span>Hashtags (separated by spaces)</span>
        <input
          key={`tags:${tags}`}
          type="text"
          defaultValue={tags}
          disabled={disabled}
          onBlur={(e) =>
            e.target.value.trim() !== tags &&
            void run('core/shorts.set-post-copy', {
              hashtags: e.target.value.split(/[\s,]+/).filter(Boolean),
            })
          }
        />
      </label>
      <label className="field">
        <span>Comment to pin ({short.post.pinnedComment.length} of 150 characters)</span>
        <input
          key={`pin:${short.post.pinnedComment}`}
          type="text"
          defaultValue={short.post.pinnedComment}
          maxLength={150}
          disabled={disabled}
          onBlur={(e) =>
            e.target.value.trim() !== short.post.pinnedComment &&
            void run('core/shorts.set-post-copy', { pinnedComment: e.target.value })
          }
        />
      </label>
      <div className="row">
        <label className="field">
          <span>Cover title</span>
          <input
            key={`ct:${short.cover.title}`}
            type="text"
            defaultValue={short.cover.title}
            maxLength={60}
            disabled={disabled}
            onBlur={(e) =>
              e.target.value.trim() !== short.cover.title &&
              void run('core/shorts.set-cover', { title: e.target.value })
            }
          />
        </label>
        <label className="field">
          <span>Cover frame at (seconds; empty for the poster frame)</span>
          <input
            key={`cs:${short.cover.seconds ?? ''}`}
            type="text"
            inputMode="decimal"
            defaultValue={short.cover.seconds ?? ''}
            disabled={disabled}
            onBlur={(e) => {
              const v = e.target.value.trim();
              const n = v === '' ? null : Number(v);
              if (n !== null && !(Number.isFinite(n) && n >= 0))
                return store.toast('error', 'Give the time in seconds, like 1.5.');
              if (n !== (short.cover.seconds ?? null))
                void run('core/shorts.set-cover', { seconds: n });
            }}
          />
        </label>
      </div>
      <PostDialog id={id} shortId={short.id} open={ask} onClose={() => setAsk(false)} />
    </section>
  );
}

function PostDialog({
  id,
  shortId,
  open,
  onClose,
}: {
  id: string;
  shortId: string;
  open: boolean;
  onClose: () => void;
}) {
  const store = useStore();
  const preview = usePreview(id, 'tiktok.post-copy', open);
  const provider = preview?.provider;
  return (
    <ConfirmDialog
      open={open}
      title="Write the post text"
      confirmLabel="Write it"
      confirmDisabled={!preview?.available}
      {...(needsConsent(preview) && provider
        ? { acknowledge: `I understand this information is sent to ${provider.name}.` }
        : {})}
      onCancel={onClose}
      onConfirm={async () => {
        if (!preview?.available) return;
        if (provider?.sendsDataOffDevice) giveConsent(provider.id);
        await store.startTask(id, { kind: 'post-copy', options: { shortId } });
        onClose();
      }}
    >
      <div className="stack">
        <p>
          The AI writes a caption, hashtags, a comment to pin and a cover title. They replace what
          is there now; Undo brings it back.
        </p>
        {!preview ? (
          <p role="status">Checking which AI provider will be used…</p>
        ) : !preview.available || !provider ? (
          <p className="error" role="alert">
            No AI provider is available: {preview.reason}.
          </p>
        ) : (
          <p data-testid="disclosure">
            Sent to <strong>{provider.name}</strong>
            {preview.model ? ` (${preview.model})` : ''}: the concept, the shot titles, the
            voiceover script, the brief and the game facts not excluded from AI use. Never
            recordings or game files.
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}
