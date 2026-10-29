import { projectPath, type ProjectTab } from './router.js';

/** Where a failed request or task points the person next: a label and an in-app path. */
export interface NextStep {
  label: string;
  to: string;
}

const TAB_FOR_CODE: Record<string, { tab: ProjectTab; label: string }> = {
  'gate-blocked': { tab: 'review', label: 'Open the Quality Gate' },
  excluded: { tab: 'knowledge', label: 'Open game knowledge' },
  'takes-attached': { tab: 'footage', label: 'Open footage' },
};

/**
 * What to offer next for an error code, so an error is never a dead end. `projectId` is the
 * project the person is working in, when there is one.
 */
export function nextStepFor(code: string | undefined, projectId: string | null): NextStep | null {
  if (code === 'missing-tool') return { label: 'Open Setup', to: '/setup' };
  const hit = code ? TAB_FOR_CODE[code] : undefined;
  if (hit && projectId) return { label: hit.label, to: projectPath(projectId, hit.tab) };
  return null;
}
