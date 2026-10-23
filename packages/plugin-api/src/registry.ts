import type { z } from 'zod';

export class RegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationError';
  }
}

interface Entry<T> {
  owner: string;
  value: T;
}

/**
 * Id-keyed registry of one contribution kind. Ids must be namespaced by the owning plugin
 * (`<pluginId>/<name>`) so plugins can't collide or shadow each other.
 */
export class Registry<T extends { id: string }> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    readonly kind: string,
    private readonly schema?: z.ZodType<T>,
  ) {}

  /** @internal used by the plugin host, which supplies the owner. */
  add(owner: string, value: unknown): T {
    const parsed = this.schema
      ? this.schema.safeParse(value)
      : { success: true as const, data: value as T };
    if (!parsed.success) {
      throw new RegistrationError(
        `invalid ${this.kind} from "${owner}": ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    const item = parsed.data;
    if (!item.id.startsWith(`${owner}/`)) {
      throw new RegistrationError(`${this.kind} id "${item.id}" must start with "${owner}/"`);
    }
    const existing = this.entries.get(item.id);
    if (existing)
      throw new RegistrationError(
        `${this.kind} "${item.id}" is already registered by "${existing.owner}"`,
      );
    this.entries.set(item.id, { owner, value: item });
    return item;
  }

  /** @internal */
  removeOwner(owner: string): void {
    for (const [id, e] of this.entries) if (e.owner === owner) this.entries.delete(id);
  }

  get(id: string): T | undefined {
    return this.entries.get(id)?.value;
  }

  require(id: string): T {
    const v = this.get(id);
    if (!v) throw new RegistrationError(`unknown ${this.kind}: ${id}`);
    return v;
  }

  list(): T[] {
    return [...this.entries.values()].map((e) => e.value).sort((a, b) => a.id.localeCompare(b.id));
  }

  ownerOf(id: string): string | undefined {
    return this.entries.get(id)?.owner;
  }
}
