import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { openFileSecretStore, SecretStoreError, type SecretStore } from '@trailerforge/engine';

/** The part of Electron's `safeStorage` we use (the OS keychain / DPAPI / libsecret). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * Keys encrypted with the operating system's credential store and kept in a file next to the
 * app data. Falls back to the owner-only plain file when the OS offers no encryption (for
 * example Linux without a keyring), and says so in `kind` so Settings tells the truth.
 */
export async function openSafeSecretStore(
  path: string,
  safe: SafeStorageLike,
): Promise<SecretStore> {
  if (!safe.isEncryptionAvailable())
    return openFileSecretStore(path.replace(/\.json$/, '.plain.json'));

  const secrets = new Map<string, string>();
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      secrets?: Record<string, unknown>;
    };
    if (!parsed.secrets || typeof parsed.secrets !== 'object') throw new Error('missing "secrets"');
    for (const [name, value] of Object.entries(parsed.secrets)) {
      if (typeof value === 'string')
        secrets.set(name, safe.decryptString(Buffer.from(value, 'base64')));
    }
    await chmod(path, 0o600).catch(() => undefined);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Never overwrite a file we could not read or decrypt: the keys may still be recoverable.
      throw new SecretStoreError(
        `cannot read ${path}: ${(err as Error).message}. Fix or remove the file.`,
      );
    }
  }

  let queue: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    const write = async () => {
      const encrypted = Object.fromEntries(
        [...secrets].map(([name, value]) => [name, safe.encryptString(value).toString('base64')]),
      );
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(
        tmp,
        `${JSON.stringify({ version: 1, encrypted: true, secrets: encrypted }, null, 2)}\n`,
        {
          mode: 0o600,
        },
      );
      await rename(tmp, path);
    };
    const next = queue.then(write, write);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    kind: "your computer's secure credential store",
    get: (name) => secrets.get(name),
    async set(name, value) {
      const before = secrets.get(name);
      secrets.set(name, value);
      try {
        await persist();
      } catch (err) {
        if (before === undefined) secrets.delete(name);
        else secrets.set(name, before);
        throw err;
      }
    },
    async delete(name) {
      const before = secrets.get(name);
      secrets.delete(name);
      try {
        await persist();
      } catch (err) {
        if (before !== undefined) secrets.set(name, before);
        throw err;
      }
    },
  };
}
