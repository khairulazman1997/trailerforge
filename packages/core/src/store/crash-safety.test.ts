import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProject } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { coreCommands } from '../project-commands.js';
import { ProjectStore } from './project-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = createRequire(import.meta.url).resolve('tsx');

/** Start the child, wait until it is saving, then SIGKILL it at a random moment. */
function runAndKill(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, join(here, 'crash-child.ts'), dir],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.stdout.on('data', (d: Buffer) => {
      if (d.toString().includes('ready'))
        setTimeout(() => child.kill('SIGKILL'), 20 + Math.random() * 200);
    });
    child.on('exit', (_code, signal) =>
      signal === 'SIGKILL'
        ? resolve()
        : reject(new Error(`child exited without being killed: ${stderr}`)),
    );
  });
}

describe('crash safety', () => {
  it('project.json stays valid when the process is killed mid-save, repeatedly', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'tforge-crash-')), 'Crash.tforge');
    const created = await ProjectStore.create(dir, sampleProject(), {
      commands: coreCommands(),
      autosaveMs: 0,
    });
    await created.close();

    let lastI = -1;
    for (let round = 0; round < 6; round++) {
      await runAndKill(dir);
      const parsed = parseProject(JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')));
      expect(parsed.ok).toBe(true);
      // The killed process leaves its lock behind; reopening must take it over.
      const reopened = await ProjectStore.open(dir, { commands: coreCommands(), autosaveMs: 0 });
      const ext = reopened.state.extensions['crash-test'] as { i: number } | undefined;
      if (ext) {
        expect(ext.i).toBeGreaterThanOrEqual(0);
        lastI = ext.i;
      }
      await reopened.close();
    }
    expect(lastI).toBeGreaterThanOrEqual(0); // at least one save landed before a kill
  }, 60_000);
});
