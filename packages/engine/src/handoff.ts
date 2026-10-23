import { randomUUID } from 'node:crypto';
import type { HandoffBridge, HandoffRequest } from '@trailerforge/llm';

export interface PendingHandoff {
  id: string;
  task: string;
  /** What the user copies into a chat: the full request on round 0, a fix-it follow-up after. */
  prompt: string;
  round: number;
  createdAt: string;
}

export class HandoffCancelled extends Error {
  constructor() {
    super('the copy-to-chat request was cancelled');
    this.name = 'HandoffCancelled';
  }
}

export type HandoffChange =
  | { type: 'requested'; handoff: PendingHandoff }
  | { type: 'resolved'; id: string; outcome: 'replied' | 'cancelled' };

/**
 * The engine half of "Copy prompt to chat". A task asks for a reply; whichever UI is connected
 * shows the prompt, and the person pastes the answer back. Rounds after the first are the
 * provider's fix-it follow-ups for replies that did not validate.
 */
export class HandoffHub implements HandoffBridge {
  private readonly waiting = new Map<
    string,
    { handoff: PendingHandoff; resolve: (text: string) => void; reject: (err: Error) => void }
  >();
  private readonly listeners = new Set<(c: HandoffChange) => void>();

  /**
   * Whether anyone can answer. The service sets this while it runs, so the CLI (which has no
   * screen to show a prompt on) does not fall back to a request that would wait forever.
   */
  available = false;

  request(req: HandoffRequest, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (signal.aborted) return reject(new HandoffCancelled());
      const handoff: PendingHandoff = {
        id: randomUUID(),
        task: req.task,
        prompt: req.prompt,
        round: req.round,
        createdAt: new Date().toISOString(),
      };
      const done = (outcome: 'replied' | 'cancelled') => {
        this.waiting.delete(handoff.id);
        signal.removeEventListener('abort', onAbort);
        this.emit({ type: 'resolved', id: handoff.id, outcome });
      };
      const onAbort = () => {
        done('cancelled');
        reject(new HandoffCancelled());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(handoff.id, {
        handoff,
        resolve: (text) => {
          done('replied');
          resolve(text);
        },
        reject: (err) => {
          done('cancelled');
          reject(err);
        },
      });
      this.emit({ type: 'requested', handoff });
    });
  }

  pending(): PendingHandoff[] {
    return [...this.waiting.values()].map((w) => w.handoff);
  }

  /** Returns false if the request is gone (already answered or cancelled). */
  reply(id: string, text: string): boolean {
    const w = this.waiting.get(id);
    if (!w) return false;
    w.resolve(text);
    return true;
  }

  cancel(id: string): boolean {
    const w = this.waiting.get(id);
    if (!w) return false;
    w.reject(new HandoffCancelled());
    return true;
  }

  onChange(listener: (c: HandoffChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(c: HandoffChange) {
    for (const l of this.listeners) l(c);
  }
}
