import { copyFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '@trailerforge/core';
import type { Engine } from './engine.js';
import { OpError } from './ops.js';

/** The name the MCP server is registered under in Claude Code. */
export const MCP_NAME = 'trailerforge';

/**
 * `app`: Claude Code talks to this running app (shared open projects, no lock clash, edits show
 * in the window at once). `standalone`: Claude Code starts its own copy of the engine, which
 * works with the app closed but cannot open a project the app has open.
 */
export type ClaudeCodeMode = 'app' | 'standalone';

export interface ClaudeCodeSetup {
  /** This app's MCP address and token (the local service); null when not served. */
  app?: { url: string; token: string } | null;
  /** `apps/cli/dist/bin.js`, for standalone mode. Null: not available in this build. */
  cliPath?: string | null;
  /** Claude Code's user settings file. Default `~/.claude.json`. */
  configPath?: string;
}

export interface ClaudeCodeView {
  /** Claude Code's settings file exists (it is made the first time Claude Code runs). */
  installed: boolean;
  /** How TrailerForge is registered, or null when it is not. */
  mode: ClaudeCodeMode | null;
  /** The registration matches this app as it runs now (address, token, tool location). */
  upToDate: boolean;
  /** Modes this app can register. */
  available: ClaudeCodeMode[];
}

// Claude Code keeps user-scope MCP servers in `mcpServers` of `~/.claude.json`, which both the
// `claude` command and the Claude desktop app read; `claude mcp add --scope user` writes the same.
const configFile = (s: ClaudeCodeSetup) => s.configPath ?? join(homedir(), '.claude.json');

function entryFor(engine: Engine, s: ClaudeCodeSetup, mode: ClaudeCodeMode) {
  if (mode === 'app') {
    if (!s.app) throw new OpError('usage', 'the app is not serving its tools right now');
    return { type: 'http', url: s.app.url, headers: { Authorization: `Bearer ${s.app.token}` } };
  }
  if (!s.cliPath)
    throw new OpError('usage', 'this build cannot tell Claude Code where its tool is');
  // Its own process, on this app's data folder: same library and provider settings.
  return {
    type: 'stdio',
    command: 'node',
    args: [s.cliPath, 'mcp', '--home', engine.home],
    env: {},
  };
}

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

const serversOf = (config: Record<string, unknown> | null): Record<string, unknown> => {
  const raw = config?.mcpServers;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as object) } : {};
};

/**
 * Add or remove our entry and nothing else. The file is read again right before writing, written
 * atomically, and copied once to `<file>.tforge-backup` before each change.
 */
async function editConfig(
  s: ClaudeCodeSetup,
  change: (servers: Record<string, unknown>) => void,
): Promise<void> {
  const path = configFile(s);
  if (!(await readConfig(path)))
    throw new OpError(
      'not-found',
      'Claude Code was not found. Install it and open it once, then try again.',
    );
  await copyFile(path, `${path}.tforge-backup`);
  const fresh = (await readConfig(path)) ?? {};
  const servers = serversOf(fresh);
  change(servers);
  await writeFileAtomic(path, `${JSON.stringify({ ...fresh, mcpServers: servers }, null, 2)}\n`);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function claudeCodeStatusOp(
  engine: Engine,
  s: ClaudeCodeSetup,
): Promise<ClaudeCodeView> {
  const available: ClaudeCodeMode[] = [
    ...(s.app ? (['app'] as const) : []),
    ...(s.cliPath ? (['standalone'] as const) : []),
  ];
  const config = await readConfig(configFile(s)).catch(() => null);
  const entry = serversOf(config)[MCP_NAME] as { type?: string } | undefined;
  const mode: ClaudeCodeMode | null = !entry ? null : entry.type === 'http' ? 'app' : 'standalone';
  let upToDate = false;
  if (mode && available.includes(mode)) upToDate = same(entry, entryFor(engine, s, mode));
  return { installed: config !== null, mode, upToDate, available };
}

/** Register (or re-register, after a change of port or folder) TrailerForge with Claude Code. */
export async function claudeCodeConnectOp(
  engine: Engine,
  s: ClaudeCodeSetup,
  mode: ClaudeCodeMode = 'app',
): Promise<ClaudeCodeView> {
  const entry = entryFor(engine, s, mode);
  await editConfig(s, (servers) => {
    servers[MCP_NAME] = entry;
  });
  return claudeCodeStatusOp(engine, s);
}

export async function claudeCodeDisconnectOp(
  engine: Engine,
  s: ClaudeCodeSetup,
): Promise<ClaudeCodeView> {
  const status = await claudeCodeStatusOp(engine, s);
  if (status.mode)
    await editConfig(s, (servers) => {
      delete servers[MCP_NAME];
    });
  return claudeCodeStatusOp(engine, s);
}
