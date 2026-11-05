import type { Project, ProjectStatus } from './project.js';

export interface StatusSuggestion {
  status: ProjectStatus;
  /** Plain words for the chip next to the status. */
  reason: string;
}

/** Facts about a project that are not in `project.json`. */
export interface StatusFacts {
  /** At least one finished export exists (`exports/render/...`). */
  exported?: boolean;
}

const ORDER: readonly ProjectStatus[] = [
  'idea',
  'scripted',
  'capturing',
  'editing',
  'in-review',
  'scheduled',
  'published',
];

/**
 * The status the project's state points to, when it is further along than the status set by
 * hand. Never suggests going back and never suggests `published` (only the user knows that).
 * Pure and browser-safe; the user applies a suggestion with `core/project.set-status`.
 */
export function suggestStatus(
  project: Pick<Project, 'status' | 'storyboard' | 'timelines' | 'review' | 'scheduledDate'>,
  facts: StatusFacts = {},
): StatusSuggestion | null {
  const slots = project.storyboard?.sections.flatMap((s) => s.slots) ?? [];
  let best: StatusSuggestion | null = null;
  const consider = (status: ProjectStatus, when: boolean, reason: string) => {
    if (when && (!best || ORDER.indexOf(status) > ORDER.indexOf(best.status)))
      best = { status, reason };
  };
  consider('scripted', slots.length > 0, 'The storyboard has shots.');
  consider(
    'capturing',
    slots.some((s) => s.kind === 'shot' && s.takes.length > 0),
    'Recordings are attached to shots.',
  );
  consider('editing', project.timelines.length > 0, 'A cut has been built.');
  consider('in-review', project.review.approvals.length > 0, 'A version has been approved.');
  consider(
    'scheduled',
    facts.exported === true && project.scheduledDate !== null,
    'A version is exported and the video has a date.',
  );
  const found = best as StatusSuggestion | null;
  if (!found || ORDER.indexOf(found.status) <= ORDER.indexOf(project.status)) return null;
  return found;
}
