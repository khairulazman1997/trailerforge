import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { parseCliVersion, parseCommandIds } from './compat.js';

export type EffectCraftErrorCode =
  'missing' | 'version' | 'failed' | 'cancelled' | 'timeout' | 'bad-project' | 'bad-output';

export class EffectCraftError extends Error {
  constructor(
    readonly code: EffectCraftErrorCode,
    message: string,
    readonly stderr = '',
  ) {
    super(message);
    this.name = 'EffectCraftError';
  }
}

export interface CliLocation {
  /** The executable: the user's installed `effectcraft-cli`, or a development build. */
  bin: string;
  /** Arguments put before every call; tests run a stub as `node stub.mjs <mode>`. */
  prefixArgs?: string[];
}

/**
 * Where the CLI is, from `TFORGE_EFFECTCRAFT` only (tests and the engine use this: nothing is
 * found by accident). The app's entry points call `resolveCliForApp`, which also looks for an
 * installed copy and sets the variable.
 */
export function locateCli(env: NodeJS.ProcessEnv = process.env): CliLocation | null {
  const bin = env.TFORGE_EFFECTCRAFT?.trim();
  return bin ? { bin } : null;
}

/**
 * The places an EffectCraft install puts its CLI, in the order they are tried: the standard
 * install folders, then each folder on PATH.
 */
export function installedCliCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const exe = platform === 'win32' ? 'effectcraft-cli.exe' : 'effectcraft-cli';
  const out: string[] = [];
  if (platform === 'win32') {
    for (const root of [
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'),
    ])
      // prettier-ignore
      if (root) out.push(join(root, 'EffectCraft', exe));
  } else if (platform === 'darwin') {
    out.push('/Applications/EffectCraft.app/Contents/MacOS/effectcraft-cli');
    if (env.HOME) out.push(join(env.HOME, 'Applications/EffectCraft.app/Contents/MacOS/effectcraft-cli')); // prettier-ignore
  }
  const path = env.PATH ?? env.Path ?? '';
  const sep = platform === 'win32' ? ';' : delimiter;
  for (const dir of path.split(sep)) if (dir.trim()) out.push(join(dir.trim(), exe));
  return out;
}

/** The first installed copy of the CLI, or null. */
export function findInstalledCli(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  return installedCliCandidates(env, platform).find((p) => exists(p)) ?? null;
}

/**
 * For the app's entry points (desktop app, `tforge`): `TFORGE_EFFECTCRAFT` when it is set (an
 * empty value switches EffectCraft off), else the installed copy, else none. Returns the value to
 * put into `TFORGE_EFFECTCRAFT` for the engine, or undefined to leave it unset.
 */
export function resolveCliForApp(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (env.TFORGE_EFFECTCRAFT !== undefined) return env.TFORGE_EFFECTCRAFT;
  return findInstalledCli(env, platform, exists) ?? undefined;
}

export interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Working directory and home of the run: EffectCraft's config and logs land here. */
  cwd: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

const KILL_GRACE_MS = 2000;

/**
 * The environment EffectCraft runs in: only what a process needs to start, with its config
 * folder, home and temp inside the run's own folder, so a user's EffectCraft preferences (render
 * defaults, nested-comp switches) never change TrailerForge's frames, and nothing is left behind.
 */
export function isolatedEnv(cwd: string, parent: NodeJS.ProcessEnv = process.env) {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'windir', 'SYSTEMDRIVE', 'LANG', 'LC_ALL'])
    if (parent[k] !== undefined) env[k] = parent[k];
  const config = join(cwd, 'config');
  const tmp = join(cwd, 'tmp');
  Object.assign(env, {
    EFFECTCRAFT_CONFIG_DIR: config,
    HOME: cwd,
    USERPROFILE: cwd,
    APPDATA: config,
    LOCALAPPDATA: config,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: tmp,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
  });
  return env;
}

/** One headless CLI call. Never uses `--gpu` (decision 7) and never a shell. */
export class EffectCraftCli {
  constructor(readonly location: CliLocation) {}

  exists(): boolean {
    return existsSync(this.location.bin);
  }

  async version(opts: RunOptions): Promise<string | null> {
    const r = await this.run(['--version'], opts);
    return parseCliVersion(r.stdout);
  }

  /** The ids of the commands this build has, or null when it does not list them as JSON. */
  async commands(opts: RunOptions): Promise<Set<string> | null> {
    return (await this.commandList(opts)).ids;
  }

  /** The command ids and the raw `commands --json` output (which also describes parameters). */
  async commandList(opts: RunOptions): Promise<{ ids: Set<string> | null; raw: string }> {
    const r = await this.run(['commands', '--json'], opts);
    return { ids: parseCommandIds(r.stdout), raw: r.stdout };
  }

  async run(args: string[], opts: RunOptions): Promise<RunResult> {
    if (args.includes('--gpu')) throw new Error('the GPU renderer is never used');
    if (opts.signal?.aborted) throw new EffectCraftError('cancelled', 'cancelled before start');
    await mkdir(join(opts.cwd, 'config'), { recursive: true });
    await mkdir(join(opts.cwd, 'tmp'), { recursive: true });
    return new Promise((resolve, reject) => {
      const child = spawn(this.location.bin, [...(this.location.prefixArgs ?? []), ...args], {
        cwd: opts.cwd,
        env: isolatedEnv(opts.cwd),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let stopped: 'cancelled' | 'timeout' | null = null;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c: string) => {
        stdout += c;
      });
      child.stderr.on('data', (c: string) => {
        stderr += c;
        if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      });
      const stop = (why: 'cancelled' | 'timeout') => {
        if (stopped) return;
        stopped = why;
        if (process.platform === 'win32' && child.pid !== undefined) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          }).on('error', () => child.kill());
          return;
        }
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
      };
      const onAbort = () => stop('cancelled');
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = opts.timeoutMs ? setTimeout(() => stop('timeout'), opts.timeoutMs) : null;
      const done = () => {
        opts.signal?.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
      };
      child.on('error', (err: NodeJS.ErrnoException) => {
        done();
        reject(
          err.code === 'ENOENT'
            ? new EffectCraftError('missing', `effectcraft-cli not found at ${this.location.bin}`)
            : new EffectCraftError('failed', err.message),
        );
      });
      child.on('close', (code) => {
        done();
        if (stopped === 'cancelled') return reject(new EffectCraftError('cancelled', 'cancelled'));
        if (stopped === 'timeout')
          return reject(new EffectCraftError('timeout', `timed out after ${opts.timeoutMs} ms`));
        if (code === 0) return resolve({ stdout, stderr });
        reject(new EffectCraftError('failed', failureMessage(args, stdout, stderr, code), stderr));
      });
    });
  }
}

const SUBCOMMANDS = new Set(['info', 'run', 'exec', 'render', 'render-frame', 'commands']);

/** With `--json` a failure is `{"error": "…"}` on stdout; otherwise the last stderr line. */
export function failureMessage(
  args: string[],
  stdout: string,
  stderr: string,
  code: number | null,
): string {
  const cmd = args.find((a) => SUBCOMMANDS.has(a)) ?? args[0] ?? '';
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const v = JSON.parse(line) as { error?: unknown };
      if (typeof v.error === 'string') return `effectcraft-cli ${cmd}: ${v.error}`;
    } catch {
      /* not JSON */
    }
  }
  const last = stderr.trim().split('\n').filter(Boolean).at(-1);
  return `effectcraft-cli ${cmd} failed (exit ${code})${last ? `: ${last}` : ''}`;
}
