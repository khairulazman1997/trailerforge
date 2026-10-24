import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { analysisCacheFile, readAnalysisCache, writeAnalysisCache } from './analysis-cache.js';

const H = 'a'.repeat(64);
const Result = z.strictObject({ beats: z.array(z.int()) });

describe('analysis cache', () => {
  it('lays files out by hash and analyzer version', () => {
    expect(analysisCacheFile('/p/cache/analysis', H, 'music', '1.2')).toBe(
      join('/p/cache/analysis', H, 'music@1.2.json'),
    );
  });

  it('rejects path-like names', () => {
    expect(() => analysisCacheFile('/c', '../x', 'music', '1')).toThrow(/hash/);
    expect(() => analysisCacheFile('/c', H, '../music', '1')).toThrow(/analyzer/);
    expect(() => analysisCacheFile('/c', H, 'music', '1/2')).toThrow(/version/);
  });

  it('round-trips, and treats missing, corrupt or stale entries as absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tforge-ac-'));
    const file = analysisCacheFile(root, H, 'music', '1');
    expect(await readAnalysisCache(file, Result)).toBeNull();
    await writeAnalysisCache(file, { beats: [1, 2] });
    expect(await readAnalysisCache(file, Result)).toEqual({ beats: [1, 2] });
    expect((await readdir(dirname(file))).filter((n) => n.includes('.tmp-'))).toEqual([]);
    await writeFile(file, '{"beats": [1.5]}');
    expect(await readAnalysisCache(file, Result)).toBeNull();
    await writeFile(file, '{"beats": [');
    expect(await readAnalysisCache(file, Result)).toBeNull();
  });
});
