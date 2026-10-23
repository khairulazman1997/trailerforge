import { rm, stat } from 'node:fs/promises';
import { writeFileAtomic } from '@trailerforge/core';
import { DEFAULT_ROUTES, RoutesConfig } from '@trailerforge/llm';
import type { Engine } from './engine.js';
import { OpError } from './ops.js';

export const ANTHROPIC_KEY = 'anthropic-api-key';

/** Models offered as suggestions in the routes editor; any string is accepted. */
export const MODEL_SUGGESTIONS = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
];

export interface RoutesView {
  /** In effect now. */
  config: RoutesConfig;
  defaults: RoutesConfig;
  /** True when `llm.routes.json` exists, i.e. the user changed something. */
  custom: boolean;
  /** Tasks the app routes by name. */
  tasks: string[];
  providers: string[];
  models: string[];
}

export async function routesView(engine: Engine): Promise<RoutesView> {
  const defaults = RoutesConfig.parse(DEFAULT_ROUTES);
  const custom = await stat(engine.routesPath).then(
    () => true,
    () => false,
  );
  return {
    config: engine.llm.routesConfig,
    defaults,
    custom,
    tasks: Object.keys(defaults.routes),
    providers: engine.llmProviderIds(),
    models: MODEL_SUGGESTIONS,
  };
}

/** Validate, write `llm.routes.json`, and switch the running client over at once. */
export async function saveRoutes(engine: Engine, input: unknown): Promise<RoutesView> {
  const parsed = RoutesConfig.safeParse(input);
  if (!parsed.success) {
    throw new OpError(
      'usage',
      `invalid routes: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  const config = parsed.data;
  const known = new Set(engine.llmProviderIds());
  const used = [
    ...Object.values(config.routes).map((r) => r.provider),
    ...(config.default ? [config.default.provider] : []),
    ...config.fallbacks,
  ];
  const unknown = [...new Set(used.filter((id) => !known.has(id)))];
  if (unknown.length) {
    throw new OpError(
      'usage',
      `unknown provider${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`,
      { known: [...known] },
    );
  }
  await writeFileAtomic(engine.routesPath, `${JSON.stringify(config, null, 2)}\n`);
  engine.llm.setRoutes(config);
  return routesView(engine);
}

/** Delete the user's routes file and go back to the built-in defaults. */
export async function resetRoutes(engine: Engine): Promise<RoutesView> {
  await rm(engine.routesPath, { force: true });
  engine.llm.setRoutes(RoutesConfig.parse(DEFAULT_ROUTES));
  return routesView(engine);
}

export interface SecretsView {
  anthropicApiKey: { set: boolean; source: 'stored' | 'environment' | null };
  /** How a stored key is kept, in words. */
  storage: string;
}

/** Whether keys exist and where from. The values are never returned. */
export function secretsView(engine: Engine): SecretsView {
  const stored = engine.secrets.get(ANTHROPIC_KEY);
  const env = process.env.ANTHROPIC_API_KEY;
  return {
    anthropicApiKey: stored
      ? { set: true, source: 'stored' }
      : env
        ? { set: true, source: 'environment' }
        : { set: false, source: null },
    storage: engine.secrets.kind,
  };
}

export async function setAnthropicKey(engine: Engine, value: unknown): Promise<SecretsView> {
  if (typeof value !== 'string') throw new OpError('usage', 'the key must be a string');
  const key = value.trim();
  if (!key) throw new OpError('usage', 'the key is empty');
  if (key.length > 400 || /\s/.test(key))
    throw new OpError(
      'usage',
      'that does not look like an API key (it has spaces or is far too long)',
    );
  await engine.secrets.set(ANTHROPIC_KEY, key);
  engine.llm.invalidate(); // the provider may have just become available
  return secretsView(engine);
}

export async function clearAnthropicKey(engine: Engine): Promise<SecretsView> {
  await engine.secrets.delete(ANTHROPIC_KEY);
  engine.llm.invalidate();
  return secretsView(engine);
}

export const providerStatus = (engine: Engine) => engine.llm.status(engine.llmProviderIds());
