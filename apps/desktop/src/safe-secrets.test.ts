import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSafeSecretStore, type SafeStorageLike } from './safe-secrets.js';

const fakeSafe = (available = true): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`enc:${[...s].reverse().join('')}`),
  decryptString: (b) => [...b.toString().slice(4)].reverse().join(''),
});

describe('safe secret store', () => {
  it('keeps keys encrypted on disk and reads them back', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'tf-safe-')), 'secrets.json');
    const store = await openSafeSecretStore(path, fakeSafe(), `${path}.plain`);
    await store.set('anthropic-api-key', 'sk-ant-secret');
    expect(store.get('anthropic-api-key')).toBe('sk-ant-secret');
    expect(await readFile(path, 'utf8')).not.toContain('sk-ant-secret');

    const again = await openSafeSecretStore(path, fakeSafe(), `${path}.plain`);
    expect(again.get('anthropic-api-key')).toBe('sk-ant-secret');
    await again.delete('anthropic-api-key');
    expect(
      (await openSafeSecretStore(path, fakeSafe(), `${path}.plain`)).get('anthropic-api-key'),
    ).toBeUndefined();
  });

  it('refuses to overwrite a file it cannot read', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'tf-safe-')), 'secrets.json');
    await writeFile(path, 'not json');
    await expect(openSafeSecretStore(path, fakeSafe(), `${path}.plain`)).rejects.toThrow(
      /cannot read/,
    );
  });

  it('falls back to an owner-only file when the OS cannot encrypt, and says so', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'tf-safe-')), 'secrets.json');
    const store = await openSafeSecretStore(path, fakeSafe(false), `${path}.plain`);
    expect(store.kind).not.toMatch(/secure credential/);
    await store.set('k', 'v');
    expect(store.get('k')).toBe('v');
    expect(await readFile(`${path}.plain`, 'utf8')).toContain('"v"');
  });

  it("treats Linux 'basic_text' as no encryption", async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'tf-safe-')), 'secrets.json');
    const safe = { ...fakeSafe(), getSelectedStorageBackend: () => 'basic_text' };
    expect((await openSafeSecretStore(path, safe, `${path}.plain`)).kind).not.toMatch(/secure/);
  });
});
