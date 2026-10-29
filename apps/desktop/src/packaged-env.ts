import { join } from 'node:path';

/**
 * Where an installed app finds what ships beside it. The installer puts these under the app's
 * `resources` folder: the bundled fonts, the analysis sidecar's source and a pinned `uv`. The
 * Python environment is built (after the user agrees, on the Setup screen) in the per-user data
 * folder, never inside the install folder, and never automatically.
 */
export function packagedEnv(o: {
  resourcesPath: string;
  userData: string;
  platform: NodeJS.Platform;
}): Record<string, string> {
  return {
    TFORGE_ASSETS_DIR: join(o.resourcesPath, 'assets'),
    TFORGE_SIDECAR_DIR: join(o.resourcesPath, 'analysis'),
    TFORGE_UV: join(o.resourcesPath, 'uv', o.platform === 'win32' ? 'uv.exe' : 'uv'),
    TFORGE_SIDECAR_AUTO_SETUP: '0',
    UV_PROJECT_ENVIRONMENT: join(o.userData, 'analysis-env'),
  };
}

/**
 * The application menu. Windows and Linux get none: the app has no File or Edit menu to offer
 * (copy and paste still work in the page). macOS keeps a minimal one so Quit and the editing
 * shortcuts keep working.
 */
export function menuTemplate(
  platform: NodeJS.Platform,
): { label: string; submenu: { role: string }[] }[] | null {
  if (platform !== 'darwin') return null;
  return [
    { label: 'TrailerForge', submenu: [{ role: 'about' }, { role: 'hide' }, { role: 'quit' }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
  ];
}
