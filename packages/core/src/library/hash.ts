import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';

/** Bytes read from each end of a file for the quick hash. */
export const QUICK_HASH_CHUNK = 4 * 1024 * 1024;

export interface QuickHashResult {
  quickHash: string;
  sizeBytes: number;
  modifiedAt: string;
}

/**
 * sha256 over the file size (8 bytes, little-endian) followed by the first and last 4 MiB (the
 * whole file when it is smaller than 8 MiB). Cheap enough for multi-gigabyte recordings, and in
 * practice unique for video: two different recordings would need the same size and identical
 * first and last 4 MiB.
 */
export async function quickHashFile(path: string): Promise<QuickHashResult> {
  const fh = await open(path, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error(`not a regular file: ${path}`);
    const size = st.size;
    const hash = createHash('sha256');
    const sizeBuf = Buffer.alloc(8);
    sizeBuf.writeBigUInt64LE(BigInt(size));
    hash.update(sizeBuf);
    const readAt = async (position: number, length: number) => {
      const buf = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await fh.read(buf, done, length - done, position + done);
        if (bytesRead === 0) throw new Error(`file shrank while hashing: ${path}`);
        done += bytesRead;
      }
      hash.update(buf);
    };
    if (size <= 2 * QUICK_HASH_CHUNK) await readAt(0, size);
    else {
      await readAt(0, QUICK_HASH_CHUNK);
      await readAt(size - QUICK_HASH_CHUNK, QUICK_HASH_CHUNK);
    }
    return { quickHash: hash.digest('hex'), sizeBytes: size, modifiedAt: st.mtime.toISOString() };
  } finally {
    await fh.close();
  }
}

export interface FullHashOptions {
  signal?: AbortSignal;
  /** Called with bytes hashed so far. */
  onProgress?: (bytes: number, total: number) => void;
}

/** Streaming sha256 of the whole file; abortable. */
export async function fullHashFile(path: string, opts: FullHashOptions = {}): Promise<string> {
  opts.signal?.throwIfAborted();
  const total = (await stat(path)).size;
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024, signal: opts.signal });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    hash.update(chunk);
    bytes += chunk.length;
    opts.onProgress?.(bytes, total);
  }
  return hash.digest('hex');
}

/** Library asset id for a file's quick hash; the same content always gets the same id. */
export function assetIdForHash(quickHash: string): string {
  return `asset_${quickHash.slice(0, 16)}`;
}
