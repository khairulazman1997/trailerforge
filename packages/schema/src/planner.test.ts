import { describe, expect, it } from 'vitest';
import { PlannerFile, ProjectRegistryFile } from './planner.js';

const at = '2026-11-05T09:00:00.000Z';
const campaign = { id: 'cmp_launch', name: 'Launch', createdAt: at };
const slot = { id: 'cal_1', date: '2026-12-01', title: 'Release trailer', createdAt: at };

describe('PlannerFile', () => {
  it('fills defaults and round-trips', () => {
    const file = PlannerFile.parse({
      schemaVersion: 1,
      campaigns: [campaign],
      slots: [{ ...slot, campaignId: 'cmp_launch', platformTargets: ['core/youtube'] }],
    });
    expect(file.slots[0]).toMatchObject({ projectId: null, notes: '', extensions: {} });
    expect(PlannerFile.parse(JSON.parse(JSON.stringify(file)))).toEqual(file);
  });

  it('refuses dangling campaigns, duplicate ids and a project on two slots', () => {
    const bad = PlannerFile.safeParse({
      schemaVersion: 1,
      campaigns: [campaign, campaign],
      slots: [
        { ...slot, campaignId: 'cmp_gone', projectId: 'proj_a' },
        { ...slot, projectId: 'proj_a' },
      ],
    });
    expect(bad.success).toBe(false);
    const messages = bad.error!.issues.map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'duplicate campaign id "cmp_launch"',
        'no campaign "cmp_gone"',
        'duplicate slot id "cal_1"',
        'project "proj_a" is already linked to slot "cal_1"',
      ]),
    );
  });

  it('refuses a campaign that ends before it starts', () => {
    const bad = PlannerFile.safeParse({
      schemaVersion: 1,
      campaigns: [{ ...campaign, startDate: '2026-12-02', endDate: '2026-12-01' }],
    });
    expect(bad.success).toBe(false);
  });
});

describe('ProjectRegistryFile', () => {
  it('refuses a folder registered twice but allows a repeated id', () => {
    const entry = { id: 'proj_a', dir: '/p/a', name: 'A', registeredAt: at, lastOpenedAt: at };
    expect(
      ProjectRegistryFile.safeParse({
        schemaVersion: 1,
        projects: [entry, { ...entry, dir: '/p/copy' }],
      }).success,
    ).toBe(true);
    expect(
      ProjectRegistryFile.safeParse({ schemaVersion: 1, projects: [entry, entry] }).success,
    ).toBe(false);
  });
});
