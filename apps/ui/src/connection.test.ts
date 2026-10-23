import { describe, expect, it } from 'vitest';
import {
  isLoopbackUrl,
  loadConnection,
  parseConnectionHash,
  type ConnectionEnv,
} from './connection.js';

const TOKEN = 't'.repeat(43);

function env(over: Partial<ConnectionEnv> = {}) {
  const store = new Map<string, string>();
  const replaced: string[] = [];
  const e: ConnectionEnv = {
    hash: '',
    origin: 'http://127.0.0.1:4000',
    pathname: '/p/proj_1',
    search: '?x=1',
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
    replaceUrl: (u) => void replaced.push(u),
    ...over,
  };
  return { e, store, replaced };
}

describe('parseConnectionHash', () => {
  it('uses the page origin when the UI is served by the service', () => {
    expect(parseConnectionHash(`#token=${TOKEN}`, 'http://127.0.0.1:4000')).toEqual({
      baseUrl: 'http://127.0.0.1:4000',
      token: TOKEN,
    });
  });

  it('takes the service address from the link for a dev server', () => {
    const hash = `#svc=${encodeURIComponent('http://127.0.0.1:41929/')}&token=${TOKEN}`;
    expect(parseConnectionHash(hash, 'http://localhost:5173')).toEqual({
      baseUrl: 'http://127.0.0.1:41929',
      token: TOKEN,
    });
  });

  it('refuses links that point the token at a non-local host', () => {
    for (const svc of [
      'https://evil.example',
      'http://127.0.0.1.evil.example',
      'ftp://127.0.0.1',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(
        parseConnectionHash(`#svc=${encodeURIComponent(svc)}&token=${TOKEN}`, 'http://127.0.0.1:1'),
      ).toBeNull();
    }
    expect(parseConnectionHash(`#token=${TOKEN}`, 'https://evil.example')).toBeNull();
  });

  it('needs a token', () => {
    expect(parseConnectionHash('', 'http://127.0.0.1:1')).toBeNull();
    expect(parseConnectionHash('#svc=http://127.0.0.1:1', 'http://127.0.0.1:1')).toBeNull();
  });
});

describe('loadConnection', () => {
  it('takes the token from the link, saves it for reloads, and removes it from the address bar', () => {
    const { e, store, replaced } = env({ hash: `#token=${TOKEN}` });
    expect(loadConnection(e)?.token).toBe(TOKEN);
    expect(replaced).toEqual(['/p/proj_1?x=1']); // path and query kept, hash gone
    expect(store.size).toBe(1);

    // After a reload the hash is gone and the saved connection is used.
    const again = env({ storage: e.storage });
    expect(loadConnection(again.e)).toEqual({ baseUrl: 'http://127.0.0.1:4000', token: TOKEN });
  });

  it('ignores corrupt or non-local saved connections', () => {
    for (const saved of [
      '{nope',
      JSON.stringify({ baseUrl: 'https://evil.example', token: 'x' }),
      JSON.stringify({ baseUrl: 5 }),
    ]) {
      const { e, store } = env();
      store.set('tforge.connection', saved);
      expect(loadConnection(e)).toBeNull();
    }
  });

  it('works without storage', () => {
    expect(loadConnection(env({ storage: null, hash: `#token=${TOKEN}` }).e)?.token).toBe(TOKEN);
    expect(loadConnection(env({ storage: null }).e)).toBeNull();
  });

  it('recognises loopback names only', () => {
    expect(
      ['http://127.0.0.1:1', 'http://localhost:2', 'http://[::1]:3'].every(isLoopbackUrl),
    ).toBe(true);
    expect(isLoopbackUrl('http://192.168.1.5:1')).toBe(false);
  });
});
