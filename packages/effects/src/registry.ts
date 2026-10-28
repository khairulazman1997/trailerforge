import type { EffectDef, FilterContext, TransitionDef } from './contract.js';
import { checkParams } from './contract.js';
import { builtinEffects } from './effects.js';
import type { FlashEvent } from './flash.js';
import { builtinTransitions } from './transitions.js';

/** Installed effects and transitions by id; the LLM may only pick ids listed here. */
export class FilterRegistry {
  private readonly byId = new Map<string, EffectDef<never> | TransitionDef<never>>();

  register(def: EffectDef<never> | TransitionDef<never>): this {
    if (!/^[a-z0-9-]+(\/[a-z0-9._-]+)+$/.test(def.id)) throw new Error(`bad effect id "${def.id}"`);
    if (this.byId.has(def.id)) throw new Error(`effect already registered: ${def.id}`);
    this.byId.set(def.id, def);
    return this;
  }

  get(id: string) {
    return this.byId.get(id);
  }

  /** Sorted ids of one kind, for the LLM's enum. */
  ids(kind: 'effect' | 'transition'): string[] {
    return [...this.byId.values()]
      .filter((d) => d.kind === kind)
      .map((d) => d.id)
      .sort();
  }
}

export function builtinFilters(): FilterRegistry {
  const r = new FilterRegistry();
  for (const d of [...builtinTransitions, ...builtinEffects]) r.register(d);
  return r;
}

/** Flash events of one effect or transition placed at `at` seconds on the cut. */
export function flashEvents(
  def: EffectDef<never> | TransitionDef<never>,
  params: unknown,
  ctx: FilterContext,
  at: number,
): FlashEvent[] {
  if (!def.flashes) return [];
  const p = checkParams(def as { id: string; params: EffectDef<unknown>['params'] }, params);
  return (def.flashes as (p: unknown, c: FilterContext) => number[])(p, ctx).map((s) => ({
    at: at + s,
    source: def.name,
  }));
}
