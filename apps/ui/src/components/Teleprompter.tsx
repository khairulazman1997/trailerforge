import { useEffect, useRef, useState } from 'react';
import { useStore } from '../app-context.js';
import { elapsedLabel, micProblem, nextLine, pickRecorderMime } from '../tiktok-view.js';
import { Dialog } from './Dialog.js';

interface Line {
  id: string;
  text: string;
  takes: number;
  chosen: { name: string } | null;
}

type Phase = 'idle' | 'starting' | 'recording' | 'saving';

/**
 * Read the script and record it, one line at a time. The audio is recorded by the browser,
 * sent to the engine on this computer only, and added as the line's newest take.
 */
export function Teleprompter({
  id,
  shortId,
  lines,
  open,
  onClose,
}: {
  id: string;
  shortId: string;
  lines: Line[];
  open: boolean;
  onClose: () => void;
}) {
  const store = useStore();
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [problem, setProblem] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const discard = useRef(false);

  const release = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    recorder.current = null;
  };
  // Closing the dialog or leaving the page drops a recording in progress and frees the microphone.
  useEffect(() => {
    if (open) return;
    discard.current = true;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    else release();
  }, [open]);
  useEffect(() => {
    if (phase !== 'recording') return;
    const t = setInterval(() => setSeconds((performance.now() - started.current) / 1000), 250);
    return () => clearInterval(t);
  }, [phase]);
  useEffect(
    () => () => {
      discard.current = true;
      if (recorder.current?.state === 'recording') recorder.current.stop();
      release();
    },
    [],
  );

  const line = lines[Math.min(index, lines.length - 1)];
  if (!line) return null;

  const start = async () => {
    setProblem('');
    const mime = pickRecorderMime((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)); // prettier-ignore
    if (!navigator.mediaDevices?.getUserMedia || !mime) {
      setProblem(
        'This browser cannot record audio. Use the desktop app, or add a recording file instead.',
      );
      return;
    }
    setPhase('starting');
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      stream.current = s;
      const r = new MediaRecorder(s, { mimeType: mime });
      chunks.current = [];
      discard.current = false;
      r.ondataavailable = (e) => e.data.size > 0 && chunks.current.push(e.data);
      r.onstop = () => {
        const blob = new Blob(chunks.current, { type: mime });
        const lineId = line.id;
        const drop = discard.current;
        release();
        if (drop || blob.size === 0) return setPhase('idle');
        setPhase('saving');
        void store
          .recordVoiceTake(id, shortId, lineId, blob)
          .then((ok) => {
            if (ok)
              setIndex((i) =>
                nextLine(
                  lines.map((l) => l.takes > 0 || l.id === lineId),
                  i,
                ),
              );
          })
          .finally(() => setPhase('idle'));
      };
      recorder.current = r;
      started.current = performance.now();
      setSeconds(0);
      r.start();
      setPhase('recording');
    } catch (err) {
      release();
      setProblem(micProblem(err));
      setPhase('idle');
    }
  };
  const stop = () => recorder.current?.state === 'recording' && recorder.current.stop();
  const busy = phase !== 'idle';

  return (
    <Dialog
      open={open}
      title="Record the voiceover"
      onClose={() => !busy && onClose()}
      wide
      footer={
        <button type="button" onClick={onClose} disabled={phase === 'saving'}>
          Done
        </button>
      }
    >
      <div className="stack tt-prompter">
        <p className="muted">
          Line {index + 1} of {lines.length}. Press Record, read the line, press Stop. The recording
          stays on this computer. Record a line again for a new take; the newest one is used.
        </p>
        <p className="tt-prompt-line" aria-live="polite">
          {line.text}
        </p>
        <p role="status">
          {phase === 'recording'
            ? `Recording… ${elapsedLabel(seconds)}`
            : phase === 'saving'
              ? 'Saving…'
              : phase === 'starting'
                ? 'Starting the microphone…'
                : line.takes > 0
                  ? `${line.takes} take${line.takes === 1 ? '' : 's'} so far.`
                  : 'Not recorded yet.'}
        </p>
        {problem && (
          <p className="error" role="alert">
            {problem}
          </p>
        )}
        <div className="row">
          <button type="button" disabled={busy || index === 0} onClick={() => setIndex(index - 1)}>
            Previous line
          </button>
          {phase === 'recording' ? (
            <button type="button" className="primary" onClick={stop}>
              Stop
            </button>
          ) : (
            <button type="button" className="primary" disabled={busy} onClick={() => void start()}>
              {line.takes > 0 ? 'Record again' : 'Record'}
            </button>
          )}
          <button
            type="button"
            disabled={busy || index >= lines.length - 1}
            onClick={() => setIndex(index + 1)}
          >
            Next line
          </button>
        </div>
      </div>
    </Dialog>
  );
}
