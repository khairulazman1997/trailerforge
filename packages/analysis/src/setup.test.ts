import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SidecarSetupConsentRequired, defaultSidecarCommand, prepareSidecar, sidecarStatus } from './index.js'; // prettier-ignore

describe('sidecar setup', () => {
  it('says ready when a custom command answers ping, broken when it does not', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tforge-sidecar-'));
    const ok = join(dir, 'ok.mjs');
    await writeFile(ok, `process.stdin.on('data', (d) => { const m = JSON.parse(String(d).split('\\n')[0]); console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { pong: true } })); });`); // prettier-ignore
    const bad = join(dir, 'bad.mjs');
    await writeFile(bad, 'process.exit(3);');
    const env = (f: string) => ({
      ...process.env,
      TFORGE_ANALYSIS_CMD: JSON.stringify([process.execPath, f]),
    });
    expect(await sidecarStatus(env(ok), 20_000)).toMatchObject({ state: 'ready' });
    const broken = await sidecarStatus(env(bad), 20_000);
    expect(broken.state).toBe('broken');
    expect(broken.detail).toMatch(/does not answer/);
  });

  it('the installed app does not build the environment behind the user’s back', () => {
    const auto = defaultSidecarCommand({ ...process.env, TFORGE_ANALYSIS_CMD: '', TFORGE_SIDECAR_AUTO_SETUP: '0' }); // prettier-ignore
    expect(auto.args).toContain('--no-sync');
    expect(defaultSidecarCommand({ ...process.env, TFORGE_ANALYSIS_CMD: '' }).args).not.toContain('--no-sync'); // prettier-ignore
  });

  it('creating the environment needs consent, and downloads nothing without it', async () => {
    await expect(prepareSidecar({ consent: false })).rejects.toBeInstanceOf(
      SidecarSetupConsentRequired,
    );
    await expect(prepareSidecar({ consent: undefined as never })).rejects.toBeInstanceOf(SidecarSetupConsentRequired); // prettier-ignore
  });
});
