import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockProvider, LlmClient, RoutesConfig } from '@trailerforge/llm';
import { describe, expect, it } from 'vitest';
import { main } from './main.js';

const llm = new LlmClient({
  providers: (id) => (id === 'core/mock' ? createMockProvider({}) : undefined),
  routes: RoutesConfig.parse({ default: { provider: 'core/mock' }, fallbacks: [] }),
});

describe('tforge doctor', { timeout: 120_000 }, () => {
  it('prints every check, and exits 1 exactly when something that stops the app fails', async () => {
    const home = join(await mkdtemp(join(tmpdir(), 'tforge-doctor-')), 'home');
    const out: string[] = [];
    const code = await main(['doctor', '--home', home], { out: (l) => out.push(l), err: () => undefined }, process.env, { engine: { llm } }); // prettier-ignore
    const text = out.join('\n');
    expect(text).toMatch(/FFmpeg:/);
    expect(text).toMatch(/Music and footage analysis:/);
    expect(text).toMatch(/Disk space:/);
    const failed = /^FAIL /m.test(text);
    expect(code).toBe(failed ? 1 : 0);
    expect(text).toMatch(failed ? /Not ready/ : /Ready\./);
    const json: string[] = [];
    await main(['doctor', '--json', '--home', home], { out: (l) => json.push(l), err: () => undefined }, process.env, { engine: { llm } }); // prettier-ignore
    expect((JSON.parse(json.join('\n')) as { checks: unknown[] }).checks.length).toBeGreaterThan(5);
  });
});
