/** How the UI finds and authenticates to the engine service. */
export interface Connection {
  baseUrl: string;
  token: string;
}

const STORAGE_KEY = 'tforge.connection';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Only ever talk to a loopback service: a crafted link must not make the UI send the token (or
 * project data) to some other host.
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * `tforge serve` prints a link like `http://127.0.0.1:41234/#token=…` (UI served by the
 * service, same origin) or `http://localhost:5173/#svc=http%3A%2F%2F127.0.0.1%3A41234&token=…`
 * (dev server). The token is after the `#`, so it is never sent to a server or written to a log.
 */
export function parseConnectionHash(hash: string, origin: string): Connection | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const token = params.get('token');
  if (!token) return null;
  const baseUrl = (params.get('svc') ?? origin).replace(/\/+$/, '');
  return isLoopbackUrl(baseUrl) ? { baseUrl, token } : null;
}

export interface ConnectionEnv {
  hash: string;
  origin: string;
  pathname: string;
  search: string;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** Replace the address-bar URL without navigating (used to drop the token from view). */
  replaceUrl(url: string): void;
}

export function browserEnv(): ConnectionEnv {
  let storage: Storage | null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null; // blocked storage: the connection just won't survive a reload
  }
  return {
    hash: window.location.hash,
    origin: window.location.origin,
    pathname: window.location.pathname,
    search: window.location.search,
    storage,
    replaceUrl: (url) => window.history.replaceState(null, '', url),
  };
}

/** Link first (then removed from the address bar), else what this tab saved earlier. */
export function loadConnection(env: ConnectionEnv = browserEnv()): Connection | null {
  const fromHash = parseConnectionHash(env.hash, env.origin);
  if (fromHash) {
    saveConnection(fromHash, env);
    env.replaceUrl(`${env.pathname}${env.search}`);
    return fromHash;
  }
  try {
    const saved = env.storage?.getItem(STORAGE_KEY);
    if (!saved) return null;
    const c = JSON.parse(saved) as Partial<Connection>;
    return typeof c.baseUrl === 'string' && typeof c.token === 'string' && isLoopbackUrl(c.baseUrl)
      ? { baseUrl: c.baseUrl, token: c.token }
      : null;
  } catch {
    return null;
  }
}

export function saveConnection(
  c: Connection,
  env: Pick<ConnectionEnv, 'storage'> = browserEnv(),
): void {
  try {
    env.storage?.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    // storage unavailable: fine
  }
}

export function clearConnection(env: Pick<ConnectionEnv, 'storage'> = browserEnv()): void {
  try {
    env.storage?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
