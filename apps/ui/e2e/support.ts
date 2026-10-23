import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Engine } from '@trailerforge/engine';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import type { LlmRequest } from '@trailerforge/plugin-api';
import { startService, type RunningService } from '@trailerforge/service';

/** Canned "suggest for me" answers, picked by the field named in the prompt. */
const SUGGESTIONS: Record<string, unknown> = {
  'brief.title': 'Ember Knight',
  'brief.keySellingPoints': ['Perfect-parry combat', 'Handcrafted bosses', 'A burning world'],
};

export interface TestService {
  root: string;
  engine: Engine;
  svc: RunningService;
  /** Prompts sent to the mock LLM, for asserting what was (not) shared. */
  prompts: string[];
  close(): Promise<void>;
}

/** A real engine and service serving the built UI, with a deterministic mock LLM. */
export async function startTestService(opts: { claudeBin?: string } = {}): Promise<TestService> {
  const root = await mkdtemp(join(tmpdir(), 'tforge-ui-e2e-'));
  const prompts: string[] = [];
  const mock = createMockProvider({
    'storyboard.generate': {
      rationale: 'Opens on a parry, builds to the Warden, ends on the title.',
      sections: [
        {
          name: 'Hook',
          role: 'hook',
          slots: [
            {
              kind: 'shot',
              title: 'Perfect parry',
              seconds: 6,
              captureInstruction: 'Parry the Warden, no HUD.',
              entityIds: ['ent_warden'],
            },
            { kind: 'shot', title: 'Forest run', seconds: 6 },
          ],
        },
        {
          name: 'Escalation',
          role: 'escalation',
          slots: [{ kind: 'shot', title: 'Boss reveal', seconds: 8 }],
        },
      ],
      music: { direction: 'Hybrid orchestral' },
    },
    'brief.suggest': (req: LlmRequest<unknown>) => {
      prompts.push(req.prompt);
      const field = /^Field: .*\(([^()\s]+)\)$/m.exec(req.prompt)?.[1] ?? '';
      return {
        value: SUGGESTIONS[field] ?? 'Something sensible',
        reason: 'it fits the game facts',
      };
    },
  });
  const llm = new LlmClient({
    providers: (id) => (id === 'core/mock' ? mock : undefined),
    routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
  });
  const engine = await Engine.start({
    home: join(root, 'home'),
    autosaveMs: 0,
    loadUserPlugins: false,
    llm,
  });
  const svc = await startService({
    engine,
    staticDir: resolve(import.meta.dirname, '..', 'dist'),
    ...(opts.claudeBin ? { claudeBin: opts.claudeBin } : {}),
  });
  return {
    root,
    engine,
    svc,
    prompts,
    async close() {
      await svc.close();
      await engine.close();
    },
  };
}
