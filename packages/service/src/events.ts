import type { ServerResponse } from 'node:http';

export interface ServiceEvent {
  /** Strictly increasing across the whole service; clients use it to detect gaps. */
  seq: number;
  type: string;
  at: string;
  data: unknown;
}

/**
 * Ordered event log with a replay window, streamed as server-sent events over a normal
 * authenticated HTTP response (so the token travels in a header, never in a URL). A client
 * that reconnects with `?after=<seq>` gets what it missed, or a `reset` event if that has
 * already fallen out of the window and it must refetch state.
 */
export class EventLog {
  private seq = 0;
  private readonly buffer: ServiceEvent[] = [];
  private readonly clients = new Set<ServerResponse>();

  constructor(private readonly windowSize = 2000) {}

  get lastSeq(): number {
    return this.seq;
  }

  emit(type: string, data: unknown): ServiceEvent {
    const e: ServiceEvent = { seq: ++this.seq, type, at: new Date().toISOString(), data };
    this.buffer.push(e);
    if (this.buffer.length > this.windowSize) this.buffer.shift();
    for (const res of this.clients) this.write(res, e);
    return e;
  }

  /** Attach a streaming response. Replays events after `after` first, in order. */
  attach(res: ServerResponse, after: number | undefined): () => void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': trailerforge events\n\n');
    if (after !== undefined) {
      const oldest = this.buffer[0]?.seq ?? this.seq + 1;
      if (after < oldest - 1) {
        this.write(res, {
          seq: this.seq,
          type: 'reset',
          at: new Date().toISOString(),
          data: { reason: 'gap' },
        });
      } else {
        for (const e of this.buffer) if (e.seq > after) this.write(res, e);
      }
    }
    this.clients.add(res);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);
    keepAlive.unref();
    const detach = () => {
      clearInterval(keepAlive);
      this.clients.delete(res);
    };
    res.on('close', detach);
    return detach;
  }

  closeAll(): void {
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  private write(res: ServerResponse, e: ServiceEvent) {
    res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  }
}
