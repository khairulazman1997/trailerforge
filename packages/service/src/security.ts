import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Only loopback interfaces: the service is for this machine's UI, never the network. */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** 32 random bytes, URL-safe. A new one every launch; the UI receives it out of band. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Constant-time comparison (hashing first also hides the length). */
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

export function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  const m = h ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  return m?.[1];
}

/**
 * DNS-rebinding defence: a page on evil.example that rebinds its name to 127.0.0.1 still sends
 * `Host: evil.example`. Accept only the loopback names, on our own port.
 */
export function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  if (!host) return false;
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase());
}

/**
 * Browsers always send Origin on cross-origin and non-GET requests. Requests without one come
 * from non-browser clients (CLI, tests, Electron main) and still need the token.
 * `null` (file:// pages, sandboxed frames) is never accepted: any local file could claim it.
 */
export function originAllowed(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (origin === undefined) return true;
  return allowed.has(origin);
}
