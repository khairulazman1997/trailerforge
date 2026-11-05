import { describe, expect, it } from 'vitest';
import { sampleProject } from './fixtures.js';
import { Project } from './project.js';
import { suggestStatus } from './status.js';

const at = '2026-11-05T09:00:00.000Z';

function variants() {
  const full = Project.parse(sampleProject());
  const noTimelines = { ...full, timelines: [] };
  const scriptOnly = noTimelines;
  const withTake = structuredClone(noTimelines);
  const shot = withTake
    .storyboard!.sections.flatMap((s) => s.slots)
    .find((s) => s.kind === 'shot')!;
  if (shot.kind === 'shot')
    shot.takes.push({ id: 'take_1', assetId: 'ast_1', addedAt: at } as never);
  const approved = {
    ...full,
    review: {
      comments: [],
      approvals: [{ variantId: null, planHash: 'a'.repeat(64), approvedAt: at }],
    },
  };
  return {
    full,
    noTimelines,
    scriptOnly,
    withTake,
    approved,
    empty: { ...noTimelines, storyboard: null },
  };
}

describe('suggestStatus', () => {
  const v = variants();
  it.each([
    ['nothing yet', v.empty, {}, null],
    ['a storyboard', v.scriptOnly, {}, 'scripted'],
    ['a take attached', v.withTake, {}, 'capturing'],
    ['a cut', v.full, {}, 'editing'],
    ['an approval', v.approved, {}, 'in-review'],
    ['exported without a date', v.approved, { exported: true }, 'in-review'],
    [
      'exported with a date',
      { ...v.approved, scheduledDate: '2026-12-01' },
      { exported: true },
      'scheduled',
    ],
  ] as const)('%s', (_name, project, facts, want) => {
    expect(suggestStatus({ ...project, status: 'idea' }, facts)?.status ?? null).toBe(want);
  });

  it('never suggests going back or past what the user set', () => {
    expect(suggestStatus({ ...v.full, status: 'in-review' })).toBeNull();
    expect(suggestStatus({ ...v.full, status: 'editing' })).toBeNull();
    expect(suggestStatus({ ...v.full, status: 'published' })).toBeNull();
    expect(suggestStatus({ ...v.full, status: 'scripted' })).toMatchObject({
      status: 'editing',
      reason: 'A cut has been built.',
    });
  });
});
