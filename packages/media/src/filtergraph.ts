/**
 * Small, deterministic FFmpeg filtergraph builder. Values are escaped so user text (titles,
 * paths) can't break the graph. Output is stable for identical input, which keeps renders
 * reproducible and golden tests meaningful.
 */
export type FilterArg = string | number | boolean;

export interface Filter {
  name: string;
  /** Positional args first, then named args in insertion order. */
  args?: FilterArg[] | Record<string, FilterArg>;
}

/** Escape a filter option value (level 1: inside a filter's argument list). */
export function escapeValue(v: FilterArg): string {
  const s = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
  return s.replace(/[\\':]/g, (c) => `\\${c}`);
}

/** Escape for the graph level (commas, semicolons, brackets separate filters and chains). */
function escapeGraph(s: string): string {
  return s.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

export function renderFilter(f: Filter): string {
  if (!/^[a-z0-9_]+$/i.test(f.name)) throw new Error(`invalid filter name: ${f.name}`);
  if (!f.args) return f.name;
  const parts = Array.isArray(f.args)
    ? f.args.map(escapeValue)
    : Object.entries(f.args).map(([k, v]) => `${k}=${escapeValue(v)}`);
  return parts.length ? `${f.name}=${escapeGraph(parts.join(':'))}` : f.name;
}

const label = (l: string) => {
  if (!/^[A-Za-z0-9_.:]+$/.test(l)) throw new Error(`invalid pad label: ${l}`);
  return `[${l}]`;
};

export class FilterGraph {
  private readonly chains: string[] = [];
  private counter = 0;

  /** A fresh, unique pad label. */
  pad(prefix = 'p'): string {
    return `${prefix}${this.counter++}`;
  }

  chain(inputs: string[], filters: Filter[], outputs: string[]): this {
    if (filters.length === 0) throw new Error('a chain needs at least one filter');
    this.chains.push(
      inputs.map(label).join('') +
        filters.map(renderFilter).join(',') +
        outputs.map(label).join(''),
    );
    return this;
  }

  toString(): string {
    return this.chains.join(';');
  }
}
