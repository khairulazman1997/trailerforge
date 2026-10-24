import { AssetRole, Id, IsoDateTime, ProjectAssetRef, findAssetUsages } from '@trailerforge/schema';
import { z } from 'zod';
import { CommandError, defineCommand } from './commands.js';

/**
 * Project asset references. The library entry (path, hash, probe data) lives in the app-level
 * `LibraryStore`; callers check the id exists there before adding it to a project.
 */
export const addProjectAsset = defineCommand({
  type: 'core/assets.add',
  payload: z.strictObject({ assetId: Id, role: AssetRole, addedAt: IsoDateTime.optional() }),
  label: ({ role }) => `Add ${role}`,
  apply: (d, { assetId, role, addedAt }) => {
    const existing = d.assets.find((a) => a.assetId === assetId);
    if (existing) {
      if (existing.role === role) return;
      throw new CommandError(
        'core/assets.add',
        `asset "${assetId}" is already in the project as ${existing.role}; use core/assets.set-role`,
      );
    }
    d.assets.push(
      ProjectAssetRef.parse({ assetId, role, addedAt: addedAt ?? new Date().toISOString() }),
    );
  },
});

export const removeProjectAsset = defineCommand({
  type: 'core/assets.remove',
  payload: z.strictObject({ assetId: Id }),
  label: () => 'Remove asset',
  apply: (d, { assetId }) => {
    const i = d.assets.findIndex((a) => a.assetId === assetId);
    if (i < 0)
      throw new CommandError('core/assets.remove', `asset "${assetId}" is not in the project`);
    const uses = findAssetUsages(d, assetId);
    if (uses.length) {
      throw new CommandError(
        'core/assets.remove',
        `asset "${assetId}" is still used (${uses.length} place${uses.length === 1 ? '' : 's'})`,
        uses.map((path) => ({ path, message: 'uses this asset' })),
      );
    }
    d.assets.splice(i, 1);
  },
});

export const setProjectAssetRole = defineCommand({
  type: 'core/assets.set-role',
  payload: z.strictObject({ assetId: Id, role: AssetRole }),
  label: ({ role }) => `Set asset role to ${role}`,
  apply: (d, { assetId, role }) => {
    const ref = d.assets.find((a) => a.assetId === assetId);
    if (!ref)
      throw new CommandError('core/assets.set-role', `asset "${assetId}" is not in the project`);
    ref.role = role;
  },
});
