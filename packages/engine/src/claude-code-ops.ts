import { execFile } from 'node:child_process';
import { copyFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '@trailerforge/core';
import type { Engine } from './engine.js';
import { OpError } from './ops.js';

/** The name the MCP server is registered under in Claude Code. */
export const MCP_NAME = 'trailerforge';

export interface ClaudeCodeCli {
  /** The `claude` executable. Default `claude` on PATH. */
  bin?: string;
  /** Arguments before the CLI's own (tests run a fake CLI through Node). */
  binArgs?: string[];
  /** `apps/cli/dist/bin.js`: what Claude Code launches as the MCP server. Null: not available here. */
  cliPath?: string | null;
  /** Claude Code's settings file. Default `~/.claude.json`. */
  configPath?: string;
}

export interface ClaudeCodeView {
  /** Claude Code was found: its command, or its settings file when only the desktop app is installed. */
  installed: boolean;
  /** TrailerForge is registered as an MCP server in Claude Code (user scope). */
  connected: boolean;
  /** This build knows where its command-line tool is, so it can offer to connect. */
  canConnect: boolean;
  /** The command that connects it, for people who prefer to run it themselves. */
  command: string | null;
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
}

function run(cli: ClaudeCodeCli, args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(
      cli.bin ?? 'claude',
      [...(cli.binArgs ?? []), ...args],
      { timeout: 20_000, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        resolve({
          code: !e ? 0 : typeof e.code === 'number' ? e.code : null,
          stdout: String(stdout),
          stderr: String(stderr),
          missing: e?.code === 'ENOENT',
        });
      },
    );
  });
}

/** Quote one argument for a command a person pastes into a terminal. */
const quote = (s: string) => (/^[\w./:\\-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/**
 * The server runs in its own process but on this app's data folder, so Claude Code sees the same
 * library and provider settings. It takes the project folder with each request.
 */
function serverArgs(engine: Engine, cliPath: string): string[] {
  return ['node', cliPath, 'mcp', '--home', engine.home];
}

export function connectCommand(engine: Engine, cli: ClaudeCodeCli): string | null {
  if (!cli.cliPath) return null;
  const add = [
    'claude',
    'mcp',
    'add',
    '--scope',
    'user',
    MCP_NAME,
    '--',
    ...serverArgs(engine, cli.cliPath),
  ];
  return add.map(quote).join(' ');
}

// ---- Claude Code's settings file ---------------------------------------------------------------
// Used when there is no `claude` command (Claude Code running inside the desktop app has none on
// PATH). Both read the same user-level `~/.claude.json`, whose `mcpServers` lists the servers.

const configFile = (cli: ClaudeCodeCli) => cli.configPath ?? join(homedir(), '.claude.json');

async function readConfig(path: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new OpError(
    'failed',
    `Claude Code's settings file (${path}) is not valid JSON; not touching it.`,
  );
}

/**
 * Add or remove our entry and nothing else. The file is read again right before writing, written
 * atomically, and kept once as `<file>.tforge-backup` the first time we change it.
 */
async function editConfig(
  cli: ClaudeCodeCli,
  change: (servers: Record<string, unknown>) => void,
): Promise<void> {
  const path = configFile(cli);
  const config = await readConfig(path);
  if (!config)
    throw new OpError('not-found', 'Claude Code was not found. Install it, then try again.');
  await copyFile(path, `${path}.tforge-backup`).catch(() => undefined);
  const fresh = (await readConfig(path)) ?? config;
  const raw = fresh.mcpServers;
  const servers: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as object) } : {};
  change(servers);
  await writeFileAtomic(path, `${JSON.stringify({ ...fresh, mcpServers: servers }, null, 2)}\n`);
}

// ---- operations --------------------------------------------------------------------------------

export async function claudeCodeStatusOp(
  engine: Engine,
  cli: ClaudeCodeCli,
): Promise<ClaudeCodeView> {
  const base = { canConnect: !!cli.cliPath, command: connectCommand(engine, cli) };
  const got = await run(cli, ['mcp', 'get', MCP_NAME]);
  if (!got.missing) {
    // `mcp get` exits 0 when the server exists and non-zero when it does not.
    return { installed: true, connected: got.code === 0, ...base };
  }
  const config = await readConfig(configFile(cli)).catch(() => null);
  const servers = config?.mcpServers;
  return {
    installed: config !== null,
    connected: !!servers && typeof servers === 'object' && MCP_NAME in servers,
    ...base,
  };
}

/** Register (or re-register, after the app moved) TrailerForge with Claude Code. */
export async function claudeCodeConnectOp(
  engine: Engine,
  cli: ClaudeCodeCli,
): Promise<ClaudeCodeView> {
  if (!cli.cliPath)
    throw new OpError('usage', 'this build cannot tell Claude Code where its tool is');
  const probe = await run(cli, ['mcp', 'get', MCP_NAME]);
  if (probe.missing) {
    const cliPath = cli.cliPath;
    await editConfig(cli, (servers) => {
      servers[MCP_NAME] = {
        type: 'stdio',
        command: 'node',
        args: serverArgs(engine, cliPath).slice(1),
        env: {},
      };
    });
    return claudeCodeStatusOp(engine, cli);
  }
  if (probe.code === 0) await run(cli, ['mcp', 'remove', '--scope', 'user', MCP_NAME]);
  const r = await run(cli, [
    'mcp',
    'add',
    '--scope',
    'user',
    MCP_NAME,
    '--',
    ...serverArgs(engine, cli.cliPath),
  ]);
  if (r.code !== 0)
    throw new OpError(
      'failed',
      `Claude Code refused: ${(r.stderr || r.stdout).trim().slice(0, 300)}`,
    );
  return claudeCodeStatusOp(engine, cli);
}

export async function claudeCodeDisconnectOp(
  engine: Engine,
  cli: ClaudeCodeCli,
): Promise<ClaudeCodeView> {
  const status = await claudeCodeStatusOp(engine, cli);
  if (!status.connected) return status;
  const probe = await run(cli, ['mcp', 'get', MCP_NAME]);
  if (probe.missing) {
    await editConfig(cli, (servers) => {
      delete servers[MCP_NAME];
    });
  } else {
    const r = await run(cli, ['mcp', 'remove', '--scope', 'user', MCP_NAME]);
    if (r.code !== 0)
      throw new OpError(
        'failed',
        `Claude Code refused: ${(r.stderr || r.stdout).trim().slice(0, 300)}`,
      );
  }
  return claudeCodeStatusOp(engine, cli);
}
