import { spawn } from 'node:child_process';
import type { LlmProvider } from '@trailerforge/plugin-api';
import { jsonSchemaFor, withRepairs } from '../structured.js';

export interface ClaudeCodeOptions {
  /** Path to the `claude` CLI. Default: `claude` on PATH. */
  bin?: string;
  timeoutMs?: number;
  /**
   * Tools Claude Code may use. Default none (pure text in, JSON out). The deep repo scan passes
   * read-only tools; never pass Bash/Write/Edit/web tools from here.
   */
  tools?: string[];
  /** Working directory of the CLI process (where its tools can see files). */
  cwd?: string;
}

interface CliResult {
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Runs the locally installed Claude Code CLI headlessly with the user's own login: no API key,
 * no per-call billing. Tools are disabled and sessions aren't persisted; the prompt goes over
 * stdin (prompts can exceed argv limits). Intended for the user's own local use.
 */
export function createClaudeCodeProvider(opts: ClaudeCodeOptions = {}): LlmProvider {
  const bin = opts.bin ?? 'claude';
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  return {
    id: 'core/claude-code',
    name: 'Claude Code (your subscription)',
    kind: 'local-cli',
    sendsDataOffDevice: true,
    async available() {
      try {
        await run(bin, ['--version'], '', 10_000);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: `Claude Code CLI not usable: ${(err as Error).message}` };
      }
    },
    async generate(request, signal) {
      const schema = jsonSchemaFor(request.schema);
      const base = [
        '-p',
        '--output-format',
        'json',
        '--json-schema',
        schema,
        '--system-prompt',
        request.system,
        '--tools',
        (opts.tools ?? []).join(','),
        '--no-session-persistence',
      ];
      if (request.model) base.push('--model', request.model);
      if (request.effort) base.push('--effort', request.effort);
      let usage = { inputTokens: 0, outputTokens: 0 };
      const { value } = await withRepairs(
        request.schema,
        async (prompt, attempt) => {
          // Each call is stateless, so a repair round repeats the request plus the issues.
          const input = attempt === 0 ? prompt : `${request.prompt}\n\n${prompt}`;
          const out = JSON.parse(
            await run(bin, base, input, timeoutMs, signal, opts.cwd),
          ) as CliResult;
          if (out.is_error)
            throw new Error(`Claude Code returned an error: ${out.result ?? 'unknown'}`);
          usage = {
            inputTokens: usage.inputTokens + (out.usage?.input_tokens ?? 0),
            outputTokens: usage.outputTokens + (out.usage?.output_tokens ?? 0),
          };
          return out.structured_output ?? out.result ?? '';
        },
        request.prompt,
      );
      return { value, model: request.model ?? 'claude-code-default', usage };
    },
  };
}

function run(
  bin: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
  signal?: AbortSignal,
  cwd?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(cwd ? { cwd } : {}),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const kill = () => child.kill('SIGTERM');
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) return reject(new Error('cancelled'));
      if (code === 0) resolve(stdout);
      else reject(new Error(`exit ${code}: ${stderr.trim().slice(-500)}`));
    });
    child.stdin.end(stdin);
  });
}
