import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { appendDurable } from './store/fs-atomic.js';

/** One network request, as written to the egress log. */
export interface EgressRecord {
  at: string;
  /** Why, in words shown to the user ("Download the local AI vision model"). */
  purpose: string;
  method: 'GET';
  host: string;
  path: string;
  /** Where redirects ended up, when somewhere else. */
  finalHost?: string;
  status: number | null;
  bytes: number;
  ok: boolean;
  error?: string;
}

export type EgressErrorCode =
  'not-https' | 'http-error' | 'too-large' | 'size-mismatch' | 'checksum-mismatch' | 'network';

export class EgressError extends Error {
  constructor(
    readonly code: EgressErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'EgressError';
  }
}

export interface EgressOptions {
  /** JSON lines, one per request (`<home>/logs/egress.jsonl`). */
  logFile: string;
  /** Injected in tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface DownloadOptions {
  purpose: string;
  /** Exact size and sha256 the file must have; anything else is discarded. */
  expectedBytes: number;
  sha256: string;
  signal?: AbortSignal;
  onProgress?: (bytes: number, total: number) => void;
}

/**
 * The single door to the network (core principle 7). Every request states its purpose and is
 * logged; only HTTPS GETs of verified files exist so far. Footage, frames and project data are
 * never sent: nothing here uploads.
 */
export class Egress {
  constructor(private readonly opts: EgressOptions) {}

  /**
   * Download to `dest` atomically: the file appears only when its size and sha256 match. A
   * failed, cancelled or tampered download leaves nothing behind.
   */
  async download(url: string, dest: string, o: DownloadOptions): Promise<{ bytes: number }> {
    const u = new URL(url);
    const rec: EgressRecord = {
      at: (this.opts.now?.() ?? new Date()).toISOString(),
      purpose: o.purpose,
      method: 'GET',
      host: u.host,
      path: u.pathname,
      status: null,
      bytes: 0,
      ok: false,
    };
    const tmp = `${dest}.part-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      if (u.protocol !== 'https:')
        throw new EgressError('not-https', `refusing a non-HTTPS URL: ${u.protocol}`);
      const res = await this.fetchOrThrow(url, o.signal);
      rec.status = res.status;
      const finalHost = res.url ? new URL(res.url).host : u.host;
      if (finalHost !== u.host) rec.finalHost = finalHost;
      if (!res.ok || !res.body)
        throw new EgressError('http-error', `HTTP ${res.status} from ${u.host}`);
      await mkdir(dirname(dest), { recursive: true });
      const hash = createHash('sha256');
      const fh = await open(tmp, 'w');
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          rec.bytes += chunk.byteLength;
          if (rec.bytes > o.expectedBytes) {
            throw new EgressError('too-large', `more than the expected ${o.expectedBytes} bytes`);
          }
          hash.update(chunk);
          await fh.write(chunk);
          o.onProgress?.(rec.bytes, o.expectedBytes);
        }
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (rec.bytes !== o.expectedBytes) {
        throw new EgressError(
          'size-mismatch',
          `got ${rec.bytes} bytes, expected ${o.expectedBytes}`,
        );
      }
      const digest = hash.digest('hex');
      if (digest !== o.sha256.toLowerCase()) {
        throw new EgressError('checksum-mismatch', `checksum mismatch for ${u.pathname}`);
      }
      await rename(tmp, dest);
      rec.ok = true;
      return { bytes: rec.bytes };
    } catch (err) {
      rec.error = err instanceof Error ? err.message : String(err);
      await rm(tmp, { force: true });
      throw err;
    } finally {
      await mkdir(dirname(this.opts.logFile), { recursive: true });
      await appendDurable(this.opts.logFile, `${JSON.stringify(rec)}\n`);
    }
  }

  private async fetchOrThrow(url: string, signal?: AbortSignal): Promise<Response> {
    try {
      return await (this.opts.fetch ?? fetch)(url, {
        redirect: 'follow',
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new EgressError('network', `cannot reach ${new URL(url).host}`, { cause: err });
    }
  }
}
