import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Egress, EgressError } from './egress.js';

const body = Buffer.from('model bytes '.repeat(1000));
const sha = createHash('sha256').update(body).digest('hex');
let dir: string;
let calls: string[];
const fakeFetch = (data: Buffer = body, status = 200) =>
  (async (url: string) => {
    calls.push(String(url));
    return new Response(status === 200 ? new Uint8Array(data) : null, { status });
  }) as unknown as typeof fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tforge-egress-'));
  calls = [];
});
const egress = (f = fakeFetch()) =>
  new Egress({ logFile: join(dir, 'logs', 'egress.jsonl'), fetch: f });
const log = async () =>
  (await readFile(join(dir, 'logs', 'egress.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const opts = { purpose: 'Download the test model', expectedBytes: body.length, sha256: sha };

describe('Egress.download', () => {
  it('writes a verified file and logs the request with its purpose', async () => {
    const seen: number[] = [];
    const dest = join(dir, 'models', 'm.onnx');
    await egress().download('https://example.org/m.onnx?x=1', dest, {
      ...opts,
      onProgress: (b) => seen.push(b),
    });
    expect(await readFile(dest)).toEqual(body);
    expect(seen.at(-1)).toBe(body.length);
    expect(await log()).toEqual([
      expect.objectContaining({
        purpose: 'Download the test model',
        host: 'example.org',
        path: '/m.onnx',
        ok: true,
        status: 200,
        bytes: body.length,
      }),
    ]);
  });

  it.each([
    ['checksum-mismatch', fakeFetch(Buffer.from(body).fill(65, 0, 1))],
    ['size-mismatch', fakeFetch(body.subarray(0, 100))],
    ['too-large', fakeFetch(Buffer.concat([body, body]))],
    ['http-error', fakeFetch(body, 404)],
  ] as const)('rejects %s and leaves nothing behind', async (code, f) => {
    const dest = join(dir, 'models', 'm.onnx');
    await expect(
      egress(f).download('https://example.org/m.onnx', dest, opts),
    ).rejects.toMatchObject({ code });
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(join(dir, 'models')) ? await readdir(join(dir, 'models')) : []).toEqual([]);
    expect((await log())[0]).toMatchObject({ ok: false });
  });

  it('refuses plain HTTP without making the request', async () => {
    await expect(
      egress().download('http://example.org/m', join(dir, 'm'), opts),
    ).rejects.toBeInstanceOf(EgressError);
    expect(calls).toEqual([]);
  });

  it('reports an unreachable host as a network error', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(
      egress(failing).download('https://example.org/m', join(dir, 'm'), opts),
    ).rejects.toMatchObject({
      code: 'network',
    });
  });
});
