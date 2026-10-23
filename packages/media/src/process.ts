import { spawn } from 'node:child_process';
import { classifyFailure, MediaError } from './errors.js';

export interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Called with each `key=value` block from `-progress pipe:2`-style output on stdout. */
  onProgressBlock?: (fields: Record<string, string>) => void;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

const KILL_GRACE_MS = 2000;

/**
 * Run ffmpeg/ffprobe without a shell (arguments are passed verbatim, so paths with spaces or
 * quotes are safe). Aborting sends SIGTERM, then SIGKILL after a grace period.
 */
export function runTool(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new MediaError('cancelled', 'cancelled before start'));
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let stopReason: 'cancelled' | 'timeout' | null = null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!opts.onProgressBlock) return;
      pending += chunk;
      let idx;
      while ((idx = pending.search(/progress=(continue|end)\n/)) !== -1) {
        const end = pending.indexOf('\n', idx) + 1;
        const block = pending.slice(0, end);
        pending = pending.slice(end);
        const fields: Record<string, string> = {};
        for (const line of block.split('\n')) {
          const eq = line.indexOf('=');
          if (eq > 0) fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
        opts.onProgressBlock(fields);
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });

    const stop = (reason: 'cancelled' | 'timeout') => {
      stopReason = reason;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
    };
    const onAbort = () => stop('cancelled');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = opts.timeoutMs ? setTimeout(() => stop('timeout'), opts.timeoutMs) : undefined;

    const cleanup = () => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(
        err.code === 'ENOENT'
          ? new MediaError(
              'ffmpeg-missing',
              `${bin} not found; install FFmpeg or set TFORGE_FFMPEG_DIR`,
            )
          : new MediaError('process-failed', err.message),
      );
    });
    child.on('close', (code) => {
      cleanup();
      if (stopReason === 'cancelled')
        return reject(new MediaError('cancelled', 'cancelled', stderr));
      if (stopReason === 'timeout')
        return reject(new MediaError('timeout', `timed out after ${opts.timeoutMs} ms`, stderr));
      if (code === 0) return resolve({ stdout, stderr });
      reject(classifyFailure(bin, stderr, code));
    });
  });
}
