import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** How to start the Python analysis sidecar (JSON-RPC over stdio). */
export interface SidecarCommand {
  command: string;
  args: string[];
  cwd?: string;
}

/** A failure reported by the sidecar with a stable code (`decode-failed`, `no-video`, ...). */
export class SidecarError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SidecarError';
  }
}

/** Codes that retrying cannot fix. */
export const PERMANENT_SIDECAR_CODES = new Set([
  'decode-failed',
  'no-video',
  'silent',
  'too-short',
  'ffmpeg-missing',
  'sidecar-missing',
]);

/**
 * `TFORGE_ANALYSIS_CMD` (a JSON array: command then arguments) overrides the default, which runs
 * the sidecar from this repository's `workers/analysis` with uv.
 */
export function defaultSidecarCommand(env: NodeJS.ProcessEnv = process.env): SidecarCommand {
  const override = env.TFORGE_ANALYSIS_CMD;
  if (override) {
    const parts = JSON.parse(override) as unknown;
    if (!Array.isArray(parts) || parts.length === 0 || !parts.every((p) => typeof p === 'string')) {
      throw new Error('TFORGE_ANALYSIS_CMD must be a JSON array of strings');
    }
    return { command: parts[0] as string, args: parts.slice(1) as string[] };
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const project = join(dir, 'workers', 'analysis');
    if (existsSync(join(project, 'pyproject.toml'))) {
      return {
        command: 'uv',
        args: [
          'run',
          '--project',
          project,
          '--frozen',
          '--quiet',
          'python',
          '-m',
          'tforge_analysis',
        ],
      };
    }
    dir = dirname(dir);
  }
  throw new SidecarError(
    'sidecar-missing',
    'cannot find workers/analysis; set TFORGE_ANALYSIS_CMD',
  );
}

export interface CallOptions {
  command?: SidecarCommand;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/**
 * One request to a fresh sidecar process, which exits when its stdin closes. A process per call
 * keeps a crash or a memory spike in one analysis from touching the next, and makes cancelling
 * simple: the process is killed. Nothing is written to disk by the sidecar.
 */
export function callSidecar(
  method: string,
  params: unknown,
  opts: CallOptions = {},
): Promise<unknown> {
  const cmd = opts.command ?? defaultSidecarCommand();
  return new Promise((resolve, reject) => {
    opts.signal?.throwIfAborted();
    const child = spawn(cmd.command, cmd.args, {
      ...(cmd.cwd ? { cwd: cmd.cwd } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    let stderr = '';
    let buffer = '';
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill('SIGKILL');
      finish(() => reject(opts.signal!.reason ?? new Error('aborted')));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) =>
      finish(() =>
        reject(
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? new SidecarError(
                'sidecar-missing',
                `cannot start the analysis sidecar (${cmd.command})`,
              )
            : err,
        ),
      ),
    );
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: {
          method?: string;
          params?: { fraction?: number };
          id?: unknown;
          result?: unknown;
          error?: { message: string; data?: { code?: string } };
        };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // not ours (a library printing to stdout)
        }
        if (msg.method === 'progress' && typeof msg.params?.fraction === 'number') {
          opts.onProgress?.(msg.params.fraction);
        } else if (msg.id === 1 && msg.error) {
          const e = msg.error;
          finish(() => reject(new SidecarError(e.data?.code ?? 'sidecar-error', e.message)));
        } else if (msg.id === 1) {
          finish(() => resolve(msg.result));
        }
      }
    });
    child.on('close', (code, signal) =>
      finish(() =>
        reject(
          new SidecarError(
            'crashed',
            `analysis sidecar exited (${signal ?? `code ${code}`}) without an answer: ${stderr.trim().slice(-500)}`,
          ),
        ),
      ),
    );
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
  });
}
