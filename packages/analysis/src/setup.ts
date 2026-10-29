import { spawn } from 'node:child_process';
import { runTool } from '@trailerforge/media';
import {
  callSidecar,
  defaultSidecarCommand,
  findSidecarProject,
  SidecarError,
  uvCommand,
} from './sidecar.js';

/**
 * The analysis sidecar's Python environment: whether it is ready, and creating it after the user
 * agrees. The check never touches the network (`--offline --no-sync`); creating it downloads the
 * pinned packages from PyPI through `uv` and is only done with `consent: true`.
 */

/** Roughly what `uv sync` downloads (numpy, scipy, librosa, OpenCV, onnxruntime...). */
export const SIDECAR_SETUP_DISCLOSURE = {
  approxMegabytes: 900,
  source: 'PyPI (Python packages) and GitHub (a Python build), through uv',
  what: 'A private copy of Python and the packages for music and footage analysis, at the exact versions this app was tested with.',
} as const;

export type SidecarState = 'ready' | 'needs-setup' | 'uv-missing' | 'missing' | 'broken';

export interface SidecarStatus {
  state: SidecarState;
  /** In words, with what to do. */
  detail: string;
}

export class SidecarSetupConsentRequired extends Error {
  constructor() {
    super('creating the analysis environment downloads packages and needs your agreement');
    this.name = 'SidecarSetupConsentRequired';
  }
}

const uvVersion = async (env: NodeJS.ProcessEnv = process.env): Promise<string | null> =>
  runTool(uvCommand(env), ['--version'], { timeoutMs: 10_000 }).then(
    (r) => r.stdout.trim(),
    () => null,
  );

/** Is the sidecar usable right now? Starts it with `ping` only; downloads nothing. */
export async function sidecarStatus(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 60_000,
): Promise<SidecarStatus> {
  let cmd;
  try {
    cmd = defaultSidecarCommand(env);
  } catch (err) {
    return {
      state: 'missing',
      detail: `${(err as Error).message}. Reinstall TrailerForge, or set TFORGE_ANALYSIS_CMD.`,
    };
  }
  const managed = cmd.command === uvCommand(env);
  if (managed && !(await uvVersion(env)))
    return {
      state: 'uv-missing',
      detail:
        'uv (the Python tool installer) is not installed. Install it from docs.astral.sh/uv, then check again.',
    };
  // Never create the environment while checking: no sync, and no network for the packages.
  const probe = managed
    ? { ...cmd, args: ['run', '--offline', '--no-sync', ...cmd.args.slice(1).filter((a) => a !== '--no-sync')] } // prettier-ignore
    : cmd;
  try {
    await callSidecar('ping', {}, { command: probe, signal: AbortSignal.timeout(timeoutMs) });
    return { state: 'ready', detail: 'The analysis tools start and answer.' };
  } catch (err) {
    const why = err instanceof SidecarError ? err.message : (err as Error).message;
    return managed
      ? {
          state: 'needs-setup',
          detail: `The analysis environment has not been created yet (${why.split('\n')[0]!.slice(0, 160)}).`,
        }
      : { state: 'broken', detail: `The analysis command does not answer: ${why.slice(0, 200)}` };
  }
}

/**
 * Create the environment (`uv sync --frozen`) and check that it answers. Needs `consent: true`.
 * `onLine` gets uv's progress text; cancelling stops uv.
 */
export async function prepareSidecar(opts: {
  consent: boolean;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}): Promise<SidecarStatus> {
  if (opts.consent !== true) throw new SidecarSetupConsentRequired();
  const env = opts.env ?? process.env;
  const project = findSidecarProject(env);
  if (!project) throw new SidecarError('sidecar-missing', 'cannot find workers/analysis');
  if (!(await uvVersion(env)))
    throw new SidecarError('uv-missing', 'uv is not installed (docs.astral.sh/uv)');
  await new Promise<void>((resolve, reject) => {
    opts.signal?.throwIfAborted();
    const child = spawn(uvCommand(env), ['sync', '--project', project, '--frozen'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let tail = '';
    const feed = (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail = `${tail}\n${line}`.slice(-1500);
        opts.onLine?.(line.trim());
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    const onAbort = () => child.kill('SIGTERM');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(opts.signal.reason ?? new Error('cancelled'));
      if (code === 0) return resolve();
      reject(new SidecarError('setup-failed', `uv sync failed (code ${code}): ${tail.trim().slice(-400)}`)); // prettier-ignore
    });
  });
  return sidecarStatus(opts.env);
}
