import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Where API keys live. Reads are synchronous (providers ask for the key on every request) and
 * come from memory; writes persist. The default is a file only the current user can read; the
 * Electron app supplies one backed by the operating system's keychain.
 */
export interface SecretStore {
  /** Short description for the settings screen, e.g. "a file only you can read". */
  readonly kind: string;
  get(name: string): string | undefined;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export class SecretStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretStoreError';
  }
}

/**
 * A JSON file with owner-only permissions (0600 file in a 0700 folder) on macOS and Linux.
 * Windows ignores those modes, so there the file is protected only by the user's profile folder.
 * It is NOT encrypted: anyone who can read your files can read the key.
 */
export async function openFileSecretStore(path: string): Promise<SecretStore> {
  let secrets: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const inner = (parsed as { secrets?: unknown }).secrets;
    if (!inner || typeof inner !== 'object') throw new Error('missing "secrets" object');
    secrets = Object.fromEntries(
      Object.entries(inner as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === 'string',
      ),
    );
    await chmod(path, 0o600).catch(() => undefined);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Never overwrite a file we could not read: it may hold keys the user needs.
      throw new SecretStoreError(
        `cannot read ${path}: ${(err as Error).message}. Fix or remove the file.`,
      );
    }
  }

  let queue: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    const write = async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ version: 1, secrets }, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(tmp, path);
    };
    const next = queue.then(write, write);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    kind: 'a file only you can read (not encrypted)',
    get: (name) => secrets[name],
    async set(name, value) {
      secrets = { ...secrets, [name]: value };
      await persist();
    },
    async delete(name) {
      const { [name]: _gone, ...rest } = secrets;
      secrets = rest;
      await persist();
    },
  };
}

/** For tests and callers that must never touch disk. */
export function memorySecretStore(initial: Record<string, string> = {}): SecretStore {
  let secrets = { ...initial };
  return {
    kind: 'memory',
    get: (name) => secrets[name],
    async set(name, value) {
      secrets = { ...secrets, [name]: value };
    },
    async delete(name) {
      const { [name]: _gone, ...rest } = secrets;
      secrets = rest;
    },
  };
}
