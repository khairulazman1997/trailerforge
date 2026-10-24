import { execFile } from 'node:child_process';
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
}

export interface ClaudeCodeView {
  /** The `claude` command was found and answered. */
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

export async function claudeCodeStatusOp(
  engine: Engine,
  cli: ClaudeCodeCli,
): Promise<ClaudeCodeView> {
  const got = await run(cli, ['mcp', 'get', MCP_NAME]);
  return {
    installed: !got.missing,
    // `mcp get` exits 0 when the server exists and non-zero when it does not.
    connected: got.code === 0,
    canConnect: !!cli.cliPath,
    command: connectCommand(engine, cli),
  };
}

/** Register (or re-register, after the app moved) TrailerForge with Claude Code. */
export async function claudeCodeConnectOp(
  engine: Engine,
  cli: ClaudeCodeCli,
): Promise<ClaudeCodeView> {
  if (!cli.cliPath)
    throw new OpError('usage', 'this build cannot tell Claude Code where its tool is');
  const status = await claudeCodeStatusOp(engine, cli);
  if (!status.installed)
    throw new OpError('not-found', 'Claude Code was not found. Install it, then try again.');
  if (status.connected) await run(cli, ['mcp', 'remove', '--scope', 'user', MCP_NAME]);
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
  if (status.connected) {
    const r = await run(cli, ['mcp', 'remove', '--scope', 'user', MCP_NAME]);
    if (r.code !== 0)
      throw new OpError(
        'failed',
        `Claude Code refused: ${(r.stderr || r.stdout).trim().slice(0, 300)}`,
      );
  }
  return claudeCodeStatusOp(engine, cli);
}
