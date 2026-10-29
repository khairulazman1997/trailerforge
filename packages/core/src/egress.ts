import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { appendDurable } from './store/fs-atomic.js';

/** One network request, as written to the egress log. */
export interface EgressRecord {
  at: string;
  /** Why, in words shown to the user ("Download the local AI vision model"). */
  purpose: string;
  /** `EXEC`: a prompt handed to a local tool that reaches the network itself (Claude Code). */
  method: 'GET' | 'POST' | 'EXEC';
  host: string;
  path: string;
  /** Bytes sent (request body or prompt); never the text itself. */
  bytesOut?: number;
  /** Where redirects ended up, when somewhere else. */
  finalHost?: string;
  status: number | null;
  bytes: number;
  ok: boolean;
  error?: string;
}

export type EgressErrorCode =
  | 'not-https'
  | 'http-error'
  | 'too-large'
  | 'size-mismatch'
  | 'checksum-mismatch'
  | 'network'
  | 'host-not-allowed'
  | 'unscoped'
  | 'excluded';

/** Why an LLM request goes out, and the names it must not carry (the project's exclusions). */
export interface EgressScope {
  purpose: string;
  forbidden?: readonly string[];
}

export interface LlmFetchOptions {
  /** Provider id, for the log. */
  provider: string;
  /** Host names requests may go to (exact match), e.g. `api.anthropic.com`. */
  hosts: readonly string[];
  /** Also allow plain HTTP to this machine (localhost, 127.0.0.1, ::1) for a local model. */
  localhost?: boolean;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The first forbidden term in `text` as a whole word (any case), or undefined. */
export function findForbidden(text: string, terms: readonly string[] = []): string | undefined {
  const lower = text.toLowerCase();
  for (const term of terms) {
    const t = term.trim().toLowerCase();
    if (!t || !lower.includes(t)) continue;
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'iu').test(text)) return term;
  }
  return undefined;
}

/**
 * The text a person or the app wrote into an LLM request body: the user turns of a chat-style
 * body (`messages[].content`, string or text parts), else the whole body. System prompts, the
 * JSON schema and the model's own earlier replies are left out, so short excluded names
 * ("Key") are not found in fixed app text.
 */
export function requestUserText(body: string): string {
  try {
    const json = JSON.parse(body) as { messages?: { role?: string; content?: unknown }[] };
    if (!Array.isArray(json.messages)) return body;
    return json.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) =>
        typeof m.content === 'string'
          ? [m.content]
          : Array.isArray(m.content)
            ? m.content
                .map((c) => (c as { text?: unknown }).text)
                .filter((x) => typeof x === 'string')
            : [],
      )
      .join('\n');
  } catch {
    return body;
  }
}

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
  private readonly scopes = new AsyncLocalStorage<EgressScope>();

  constructor(private readonly opts: EgressOptions) {}

  /** Run `fn` with a stated purpose: LLM requests made inside it are allowed and logged under it. */
  scope<R>(scope: EgressScope, fn: () => Promise<R>): Promise<R> {
    return this.scopes.run(scope, fn);
  }

  /**
   * A `fetch` for an LLM provider: only inside `scope()`, only to its allow-listed hosts over
   * HTTPS (or to this machine for a local model), refused when the user's text in the request
   * names something excluded; every request logged with its purpose and size, never its text.
   */
  llmFetch(o: LlmFetchOptions): typeof fetch {
    return async (input, init) => {
      const req = input instanceof Request ? input : undefined;
      const u = new URL(req ? req.url : String(input));
      const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
      const scope = this.scopes.getStore();
      const rec: EgressRecord = {
        at: (this.opts.now?.() ?? new Date()).toISOString(),
        purpose: scope?.purpose ?? `(no purpose given) ${o.provider}`,
        method: method === 'POST' ? 'POST' : 'GET',
        host: u.host,
        path: u.pathname,
        bytesOut: 0,
        status: null,
        bytes: 0,
        ok: false,
      };
      try {
        const body = await bodyText(init?.body ?? (req ? await req.clone().text() : undefined));
        rec.bytesOut = Buffer.byteLength(body ?? '');
        if (!scope)
          throw new EgressError('unscoped', `${o.provider}: a request without a stated purpose`);
        const local = LOCAL_HOSTS.has(u.hostname);
        if (u.protocol !== 'https:' && !(o.localhost && local && u.protocol === 'http:'))
          throw new EgressError('not-https', `refusing a non-HTTPS URL: ${u.protocol}`);
        if (!(o.hosts.includes(u.hostname) || (o.localhost && local)))
          throw new EgressError('host-not-allowed', `${o.provider} may not reach ${u.host}`);
        if (body && findForbidden(requestUserText(body), scope.forbidden))
          throw new EgressError(
            'excluded',
            'the request names something marked "keep out of AI requests"; nothing was sent',
          );
        let res: Response;
        try {
          res = await (this.opts.fetch ?? fetch)(input, init);
        } catch (err) {
          if (init?.signal?.aborted) throw err;
          throw new EgressError('network', `cannot reach ${u.host}`, { cause: err });
        }
        rec.status = res.status;
        rec.bytes = Number(res.headers.get('content-length') ?? 0) || 0;
        rec.ok = res.ok;
        return res;
      } catch (err) {
        rec.error = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        await this.log(rec);
      }
    };
  }

  /**
   * Before a prompt goes to a local tool that reaches the network itself (the Claude Code CLI):
   * the same purpose, exclusion check and log line as `llmFetch`. Throws to stop the hand-off.
   */
  async handOff(o: { provider: string; tool: string; text: string }): Promise<void> {
    const scope = this.scopes.getStore();
    const rec: EgressRecord = {
      at: (this.opts.now?.() ?? new Date()).toISOString(),
      purpose: scope?.purpose ?? `(no purpose given) ${o.provider}`,
      method: 'EXEC',
      host: o.tool,
      path: '',
      bytesOut: Buffer.byteLength(o.text),
      status: null,
      bytes: 0,
      ok: false,
    };
    try {
      if (!scope)
        throw new EgressError('unscoped', `${o.provider}: a request without a stated purpose`);
      if (findForbidden(o.text, scope.forbidden))
        throw new EgressError(
          'excluded',
          'the request names something marked "keep out of AI requests"; nothing was sent',
        );
      rec.ok = true;
    } catch (err) {
      rec.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      await this.log(rec);
    }
  }

  /**
   * A setup step the user agreed to, run by a local tool that fetches things itself (`uv` creating
   * the Python environment from PyPI). Logged like any request, as `EXEC`: purpose, tool, result.
   */
  async logSetup(r: {
    purpose: string;
    tool: string;
    source: string;
    ok: boolean;
    error?: string;
  }): Promise<void> {
    await this.log({
      at: (this.opts.now?.() ?? new Date()).toISOString(),
      purpose: r.purpose,
      method: 'EXEC',
      host: r.source,
      path: r.tool,
      status: null,
      bytes: 0,
      ok: r.ok,
      ...(r.error ? { error: r.error } : {}),
    });
  }

  private async log(rec: EgressRecord): Promise<void> {
    await mkdir(dirname(this.opts.logFile), { recursive: true });
    await appendDurable(this.opts.logFile, `${JSON.stringify(rec)}\n`);
  }

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
      await this.log(rec);
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

async function bodyText(body: unknown): Promise<string | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8');
  if (body instanceof Blob) return body.text();
  if (body instanceof URLSearchParams) return body.toString();
  // Streams and form data are not read here (that would consume them): refused as unknown.
  throw new EgressError('excluded', 'a request body that cannot be checked; nothing was sent');
}
