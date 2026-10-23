import { useState } from 'react';
import type { PendingHandoff } from '@trailerforge/service/client';
import { useAppState, useStore } from '../app-context.js';
import { Dialog } from './Dialog.js';

const TASK_NAME: Record<string, string> = {
  'brief.suggest': 'a suggestion for a brief question',
  'brief.parse': 'reading your brief',
  'storyboard.generate': 'the storyboard',
  'storyboard.regenerate-section': 'a rewrite of one section',
};

/**
 * "Copy prompt to chat": shows the request to paste into any chat and takes the reply back.
 * A request can be hidden and reopened from the top bar; it waits until answered or cancelled.
 */
export function HandoffHost() {
  const handoffs = useAppState((s) => s.handoffs);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const shown = handoffs.find((h) => !hidden.has(h.id));
  const waitingHidden = handoffs.filter((h) => hidden.has(h.id));

  return (
    <>
      {waitingHidden.length > 0 && (
        <button
          type="button"
          className="pill"
          onClick={() =>
            setHidden(new Set([...hidden].filter((id) => !waitingHidden.some((h) => h.id === id))))
          }
        >
          {waitingHidden.length} chat request{waitingHidden.length === 1 ? '' : 's'} waiting
        </button>
      )}
      {shown && (
        <HandoffDialog
          key={shown.id}
          handoff={shown}
          onHide={() => setHidden(new Set([...hidden, shown.id]))}
        />
      )}
    </>
  );
}

function HandoffDialog({ handoff: h, onHide }: { handoff: PendingHandoff; onHide: () => void }) {
  const store = useStore();
  const [reply, setReply] = useState('');
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const followUp = h.round > 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(h.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      store.toast('error', 'Could not copy automatically. Select the text and copy it yourself.');
    }
  };

  const send = async () => {
    setSending(true);
    const ok = await store.replyHandoff(h.id, reply);
    setSending(false);
    if (ok) store.toast('info', 'Reply received. Checking it…');
  };

  return (
    <Dialog
      open
      title={
        followUp ? 'That reply did not validate: send this follow-up' : 'Copy this into a chat'
      }
      onClose={onHide}
      footer={
        <>
          <button
            type="button"
            className="danger"
            disabled={sending}
            onClick={() => void store.cancelHandoff(h.id)}
          >
            Cancel request
          </button>
          <button type="button" onClick={onHide}>
            Hide for now
          </button>
          <button
            type="button"
            className="primary"
            disabled={sending || !reply.trim()}
            onClick={() => void send()}
          >
            {sending ? 'Sending…' : 'Send reply'}
          </button>
        </>
      }
    >
      <div className="stack handoff">
        <p>
          This is for {TASK_NAME[h.task] ?? h.task}.{' '}
          {followUp ? (
            <>
              Paste the follow-up into the <strong>same chat</strong> so it can correct itself, then
              paste its new reply below.
            </>
          ) : (
            <>
              Copy the request, paste it into any chat (Claude, ChatGPT…), then paste the
              chat&apos;s <strong>whole reply</strong> below.
            </>
          )}
        </p>
        <label>
          Request to copy
          <textarea readOnly rows={8} value={h.prompt} onFocus={(e) => e.currentTarget.select()} />
        </label>
        <div className="row">
          <button type="button" onClick={() => void copy()}>
            {copied ? 'Copied ✓' : 'Copy request'}
          </button>
          {!followUp && (
            <span className="hint">
              TrailerForge sends nothing itself, but the chat service you paste into will see this
              text.
            </span>
          )}
        </div>
        <label>
          Reply from the chat
          <textarea
            rows={6}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Paste the reply here"
          />
        </label>
      </div>
    </Dialog>
  );
}
