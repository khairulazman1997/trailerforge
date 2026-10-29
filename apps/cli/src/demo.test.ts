import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { describe, expect, it } from 'vitest';
import { main } from './main.js';

const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? createMockProvider({}) : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

describe('tforge demo', { timeout: 180_000 }, () => {
  it('builds the demo project where asked and says what is in it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tforge-clidemo-'));
    const dir = join(root, 'My Demo.tforge');
    const out: string[] = [];
    const code = await main(['demo', '--dir', dir, '--home', join(root, 'home')], { out: (l) => out.push(l), err: (l) => out.push(l) }, process.env, { engine: { llm } }); // prettier-ignore
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(
      /Demo project ready: .*My Demo\.tforge\n\s+5 shots, [\d.]+ s cut, versions /,
    );
    expect(existsSync(join(dir, 'project.json'))).toBe(true);
  });
});
