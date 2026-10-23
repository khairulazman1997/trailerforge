import type { Draft } from 'immer';
import type { Project } from '@trailerforge/schema';
import type { z } from 'zod';

/**
 * The only way to change a project. Commands mutate an Immer draft; the store records
 * patches for undo/redo/history and validates the result before committing.
 *
 * Build new entities with their schema (`Slot.parse({...})`) so defaults are filled in:
 * the store rejects commands that leave objects incomplete.
 */
export interface CommandDef<P> {
  /** Namespaced type, e.g. `core/project.rename`, `game-trailer/storyboard.add-shot`. */
  type: string;
  payload: z.ZodType<P>;
  /** Label for the undo menu and version history. */
  label: (payload: P) => string;
  apply: (draft: Draft<Project>, payload: P) => void;
  /**
   * Consecutive commands of this type with the same key within `windowMs` collapse into one
   * undo step (e.g. dragging a trim handle).
   */
  merge?: { key: (payload: P) => string; windowMs: number };
}

export function defineCommand<P>(def: CommandDef<P>): CommandDef<P> {
  return def;
}

export class CommandRegistry {
  private readonly defs = new Map<string, CommandDef<unknown>>();

  register<P>(def: CommandDef<P>): this {
    if (this.defs.has(def.type)) throw new Error(`command already registered: ${def.type}`);
    this.defs.set(def.type, def as CommandDef<unknown>);
    return this;
  }

  get(type: string): CommandDef<unknown> | undefined {
    return this.defs.get(type);
  }

  types(): string[] {
    return [...this.defs.keys()].sort();
  }
}

export class CommandError extends Error {
  constructor(
    readonly commandType: string,
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(`${commandType}: ${message}`);
    this.name = 'CommandError';
  }
}
