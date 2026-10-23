/** Where hand edits are recorded on a slot: `extensions.core.userEdited`, a sorted field list. */
interface HasExtensions {
  extensions: Record<string, unknown>;
}

export function userEditedFields(slot: { extensions: Record<string, unknown> }): string[] {
  const core = slot.extensions.core as { userEdited?: unknown } | undefined;
  return Array.isArray(core?.userEdited) ? (core.userEdited as string[]) : [];
}

/** Remember which fields the user changed, so regenerating the section keeps the slot. */
export function markUserEdited(slot: HasExtensions, fields: readonly string[]) {
  const core = (slot.extensions.core as Record<string, unknown> | undefined) ?? {};
  slot.extensions.core = {
    ...core,
    userEdited: [...new Set([...userEditedFields(slot), ...fields])].sort(),
  };
}
