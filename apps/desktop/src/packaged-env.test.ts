import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { menuTemplate, packagedEnv } from './packaged-env.js';

describe('packaged app', () => {
  it('finds fonts, the sidecar and uv beside the app, and builds the Python environment in the data folder', () => {
    const env = packagedEnv({ resourcesPath: join('C:', 'App', 'resources'), userData: join('C:', 'Data', 'engine'), platform: 'win32' }); // prettier-ignore
    expect(env.TFORGE_ASSETS_DIR).toBe(join('C:', 'App', 'resources', 'assets'));
    expect(env.TFORGE_SIDECAR_DIR).toBe(join('C:', 'App', 'resources', 'analysis'));
    expect(env.TFORGE_UV).toBe(join('C:', 'App', 'resources', 'uv', 'uv.exe'));
    expect(env.UV_PROJECT_ENVIRONMENT).toBe(join('C:', 'Data', 'engine', 'analysis-env'));
    // Nothing is built behind the user's back: the Setup screen does it after they agree.
    expect(env.TFORGE_SIDECAR_AUTO_SETUP).toBe('0');
    expect(packagedEnv({ resourcesPath: '/r', userData: '/d', platform: 'linux' }).TFORGE_UV).toBe(
      join('/r', 'uv', 'uv'),
    );
  });

  it('has no application menu on Windows and Linux, and a small one on macOS', () => {
    expect(menuTemplate('win32')).toBeNull();
    expect(menuTemplate('linux')).toBeNull();
    const mac = menuTemplate('darwin')!;
    expect(mac.map((m) => m.label)).toEqual(['TrailerForge', 'Edit', 'Window']);
    expect(mac[0]!.submenu.map((i) => i.role)).toContain('quit');
  });
});
