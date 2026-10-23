/** Lowercase `a_b_c` form of a display name, at most 40 characters; never empty. */
export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'x'
  );
}

/** `prefix_slug`, suffixed `_2`, `_3`... until unused; registers the result in `taken`. */
export function mintId(prefix: string, name: string, taken: Set<string>): string {
  const base = `${prefix}_${slug(name)}`.slice(0, 56);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  taken.add(id);
  return id;
}

/** Every `id` string anywhere in a JSON-like value (ids are unique project-wide). */
export function collectIds(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) collectIds(v, into);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'id' && typeof v === 'string') into.add(v);
      else collectIds(v, into);
    }
  }
  return into;
}
