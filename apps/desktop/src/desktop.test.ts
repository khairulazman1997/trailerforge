import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startDesktop, type Desktop, type DesktopHost, type WindowLike } from './desktop.js';

let running: Desktop | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'tf-desktop-'));
  const ui = await mkdtemp(join(tmpdir(), 'tf-ui-'));
  await writeFile(join(ui, 'index.html'), '<!doctype html><title>t</title>');
  const rec = {
    loaded: '',
    external: [] as string[],
    decide: (_: string) => true,
    open: (_: string) => {},
    closed: () => {},
    handlers: new Map<string, () => Promise<unknown>>(),
  };
  const win: WindowLike = {
    load: async (url) => void (rec.loaded = url),
    onWillNavigate: (d) => void (rec.decide = d),
    onWindowOpen: (h) => void (rec.open = h),
    onClosed: (cb) => void (rec.closed = cb),
  };
  const host: DesktopHost = {
    dataDir: join(dir, 'engine'),
    uiDir: ui,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s),
      decryptString: (b) => b.toString(),
    },
    createWindow: () => win,
    openExternal: (u) => void rec.external.push(u),
    pickFolder: async () => '/picked/folder',
    pickFile: async () => undefined,
    handle: (c, fn) => void rec.handlers.set(c, fn),
  };
  running = await startDesktop(host);
  return rec;
}

describe('desktop shell', () => {
  it('opens the window on the local service with the token in the hash', async () => {
    const rec = await harness();
    expect(rec.loaded).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]{16,}$/);
    const health = await fetch(`${running!.url}/`);
    expect(health.status).toBeLessThan(500);
  });

  it('keeps the window on the service and sends web links to the browser', async () => {
    const rec = await harness();
    expect(rec.decide(`${running!.url}/settings`)).toBe(true);
    expect(rec.decide('https://example.com/')).toBe(false);
    expect(rec.decide('file:///etc/passwd')).toBe(false);
    expect(rec.decide('javascript:alert(1)')).toBe(false);
    rec.open('https://example.com/docs');
    rec.open('file:///etc/passwd');
    expect(rec.external).toEqual(['https://example.com/', 'https://example.com/docs']);
  });

  it('exposes only the two pickers and stops the service when the window closes', async () => {
    const rec = await harness();
    expect([...rec.handlers.keys()].sort()).toEqual(['tforge:pick-file', 'tforge:pick-folder']);
    expect(await rec.handlers.get('tforge:pick-folder')!()).toBe('/picked/folder');
    const url = running!.url;
    rec.closed();
    await running!.close();
    await expect(fetch(`${url}/`)).rejects.toThrow();
  });
});
