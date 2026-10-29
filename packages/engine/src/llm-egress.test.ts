import dns from 'node:dns';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Engine } from './engine.js';
import { suggestBriefAnswerOp } from './ops.js';

/**
 * The real Anthropic provider, through the engine: every request goes out only through Egress
 * (stubbed here at its fetch), with a purpose and size in the log and never the text, and a
 * request carrying a name the user excluded is stopped at the boundary.
 */

const network = {
  connect: vi.spyOn(net.Socket.prototype, 'connect'),
  lookup: vi.spyOn(dns, 'lookup'),
  fetch: vi.spyOn(globalThis, 'fetch'),
};
const sent: { url: string; body: string }[] = [];
const egressFetch = (async (url: string, init?: RequestInit) => {
  sent.push({ url: String(url), body: String(init?.body ?? '') });
  const reply = { value: 'Ember Knight', reason: 'the game facts say so' };
  return new Response(
    JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: JSON.stringify(reply) }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as unknown as typeof fetch;

let root: string;
let engine: Engine;
let store: Awaited<ReturnType<Engine['createProject']>>;
const secrets = {
  kind: 'test',
  get: (k: string) => (k === 'anthropic-api-key' ? 'sk-ant-test' : undefined),
  set: async () => undefined,
  delete: async () => undefined,
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-llm-egress-'));
  engine = await Engine.start({
    home: join(root, 'home'),
    autosaveMs: 0,
    loadUserPlugins: false,
    egressFetch,
    secrets,
  });
  store = await engine.createProject(join(root, 'P.tforge'), sampleProject() as never);
});
afterAll(async () => engine.close());

const egressLog = async () =>
  (await readFile(join(root, 'home', 'logs', 'egress.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('LLM requests through Egress', () => {
  it('the Anthropic provider sends only through Egress, logged with its purpose', async () => {
    const s = await suggestBriefAnswerOp(engine, store, { questionId: 'brief.title' });
    expect(s).toMatchObject({ value: 'Ember Knight', provider: 'core/anthropic' });
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]!.url).host).toBe('api.anthropic.com');
    const [rec] = await egressLog();
    expect(rec).toMatchObject({
      purpose: 'AI request "brief.suggest" (Anthropic API)',
      method: 'POST',
      host: 'api.anthropic.com',
      ok: true,
      status: 200,
    });
    expect(rec!.bytesOut).toBe(Buffer.byteLength(sent[0]!.body));
    // The log holds no prompt text.
    expect(JSON.stringify(rec)).not.toMatch(/Game name|Ember/);
  });

  it('a request naming an excluded entity is stopped before it leaves', async () => {
    // The sample's boss, "The Ash Warden", is marked "keep out of AI requests".
    store.dispatch('core/knowledge.set-excluded', { id: 'ent_warden', excluded: true });
    // The brief text is the user's own words; it slips the name in.
    store.dispatch('core/brief.set-field', {
      path: 'brief.freeText',
      value: 'Beat the ash warden.',
    });
    await expect(
      suggestBriefAnswerOp(engine, store, { questionId: 'brief.title' }),
    ).rejects.toMatchObject({ code: 'excluded' });
    expect(sent).toHaveLength(1); // nothing more went out
    const recs = await egressLog();
    expect(recs).toHaveLength(2); // refused once, not retried
    expect(recs.at(-1)).toMatchObject({ ok: false, host: 'api.anthropic.com' });
    expect(JSON.stringify(recs)).not.toMatch(/ash warden/i);
  });

  it('nothing opened a connection on its own', () => {
    expect(network.connect).not.toHaveBeenCalled();
    expect(network.lookup).not.toHaveBeenCalled();
    expect(network.fetch).not.toHaveBeenCalled();
  });
});
