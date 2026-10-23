import type { LlmProvider, LlmRequest } from '@trailerforge/plugin-api';
import { withRepairs } from '../structured.js';

type Reply = unknown | ((req: LlmRequest<unknown>) => unknown);

/**
 * Deterministic provider for tests and offline demos. `replies[task]` is a reply or a list of
 * replies consumed in order (to exercise the repair loop). Replies may be objects or raw text.
 */
export function createMockProvider(replies: Record<string, Reply | Reply[]>, id = 'core/mock') {
  const calls: { task: string; prompt: string }[] = [];
  const cursor = new Map<string, number>();
  const provider: LlmProvider & { calls: typeof calls } = {
    id,
    name: 'Mock',
    kind: 'mock',
    sendsDataOffDevice: false,
    calls,
    available: async () => ({ ok: true }),
    async generate(request) {
      const configured = replies[request.task];
      if (configured === undefined) throw new Error(`mock has no reply for task "${request.task}"`);
      const list = Array.isArray(configured) ? configured : [configured];
      const { value } = await withRepairs(
        request.schema,
        async (prompt) => {
          calls.push({ task: request.task, prompt });
          const i = cursor.get(request.task) ?? 0;
          cursor.set(request.task, i + 1);
          const reply = list[Math.min(i, list.length - 1)];
          return typeof reply === 'function'
            ? (reply as (r: LlmRequest<unknown>) => unknown)(request)
            : reply;
        },
        request.prompt,
      );
      return { value, model: 'mock' };
    },
  };
  return provider;
}
