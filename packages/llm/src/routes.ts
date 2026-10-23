import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const Route = z.strictObject({
  provider: z.string().min(1),
  model: z.string().optional(),
  effort: Effort.optional(),
});
export type Route = z.infer<typeof Route>;

/** Contents of llm.routes.json: task -> provider/model/effort, user-editable. */
export const RoutesConfig = z.strictObject({
  routes: z.record(z.string(), Route).default({}),
  default: Route.optional(),
  /** Tried in order when the routed provider is unavailable. */
  fallbacks: z.array(z.string()).default(['core/claude-code', 'core/chat-handoff']),
});
export type RoutesConfig = z.infer<typeof RoutesConfig>;

/** Defaults from the plan; the file overrides any of them. */
export const DEFAULT_ROUTES: z.input<typeof RoutesConfig> = {
  default: { provider: 'core/anthropic', model: 'claude-sonnet-5-5', effort: 'medium' },
  routes: {
    'brief.parse': { provider: 'core/anthropic', model: 'claude-haiku-5-5', effort: 'low' },
    'brief.suggest': { provider: 'core/anthropic', model: 'claude-sonnet-5-5', effort: 'low' },
    'storyboard.generate': { provider: 'core/anthropic', model: 'claude-opus-5-5', effort: 'high' },
    'storyboard.regenerate-section': {
      provider: 'core/anthropic',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
    },
    'vo.script': { provider: 'core/anthropic', model: 'claude-opus-5-5', effort: 'medium' },
    'capture.tips': { provider: 'core/anthropic', model: 'claude-sonnet-5-5', effort: 'low' },
    'reference.template': {
      provider: 'core/anthropic',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
    },
    'critique.run': { provider: 'core/anthropic', model: 'claude-opus-5-5', effort: 'high' },
  },
};

export interface ResolvedRoute extends Route {
  /** True when a fallback replaced the configured provider. */
  fellBack: boolean;
}

/** Pick the provider for `task`: its route, else the default, else the first available fallback. */
export async function resolveRoute(
  config: RoutesConfig,
  task: string,
  isAvailable: (providerId: string) => Promise<boolean>,
): Promise<ResolvedRoute> {
  const route = config.routes[task] ?? config.default;
  if (route && (await isAvailable(route.provider))) return { ...route, fellBack: false };
  for (const provider of config.fallbacks) {
    if (provider !== route?.provider && (await isAvailable(provider))) {
      // Model names are provider-specific; only effort carries over.
      return { provider, ...(route?.effort ? { effort: route.effort } : {}), fellBack: true };
    }
  }
  throw new Error(
    `no LLM provider available for task "${task}" (tried ${[route?.provider, ...config.fallbacks].filter(Boolean).join(', ')})`,
  );
}

/** Read `llm.routes.json`; a missing file means the defaults. A malformed file is an error. */
export async function loadRoutesConfig(path: string): Promise<RoutesConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return RoutesConfig.parse(DEFAULT_ROUTES);
    throw err;
  }
  return RoutesConfig.parse(JSON.parse(text));
}
