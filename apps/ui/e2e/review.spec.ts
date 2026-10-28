import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { startTestService, type TestService } from './support.js';

test.describe.configure({ mode: 'serial' });

let t: TestService;
let dir: string;
const ID = 'proj_sample';

test.beforeAll(async () => {
  t = await startTestService();
  dir = join(t.root, 'Review.tforge');
  await t.engine.createProject(dir, sampleProject() as never);
});
test.afterAll(async () => {
  await t.close();
});

async function axe(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical' || v.id === 'heading-order')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test('review: the Quality Gate, a draft, comments on moments, and an approval that goes out of date', async ({
  page,
}) => {
  await page.goto(`${t.svc.url}/p/${ID}/review#token=${t.svc.token}`);
  await expect(page.getByRole('heading', { name: 'Review', level: 1 })).toBeVisible();
  const versions = page.getByRole('list', { name: 'Versions' });
  await expect(versions.getByRole('listitem')).toHaveCount(2);
  await expect(versions.getByTestId('version-master')).toContainText('Not approved');

  // The sample is not finished: the gate says what blocks and where.
  const verdict = page.getByTestId('gate-verdict');
  await expect(verdict).toContainText('Blocked', { timeout: 20_000 });
  const blocking = page.getByRole('region', { name: 'Always blocks an export' });
  await expect(blocking).toContainText('Placeholder in the cut');
  await expect(blocking).toContainText('Missing recording or sound');

  // Pick the TikTok version.
  await versions.getByTestId('version-var_tt').click();
  await expect(
    page
      .getByRole('heading', { name: 'var_tt', level: 2 })
      .or(page.getByRole('heading', { level: 2 }).first()),
  ).toBeVisible();

  // A review draft: rendered in the background, shown in a player.
  await page.getByRole('button', { name: 'Render a review draft' }).click();
  await expect(page.getByTestId('draft-player')).toBeVisible({ timeout: 60_000 });

  // Comments on moments: they show on the ruler and in the list.
  await page.getByLabel('At (seconds)').fill('1.5');
  await page.getByLabel('Comment', { exact: true }).fill('Hook is too slow');
  await page.getByRole('button', { name: 'Add comment' }).click();
  const list = page.getByRole('list', { name: 'Comments' });
  await expect(list).toContainText('Hook is too slow');
  await expect(list).toContainText('1.5 s');
  await expect(
    page.getByRole('button', { name: /Comment at 1.5 seconds: Hook is too slow/ }),
  ).toBeVisible();
  await expect(versions.getByTestId('version-var_tt')).toContainText('1 open comment');
  await list.getByRole('button', { name: 'Resolve' }).click();
  await expect(list).toContainText('resolved');
  await expect(versions.getByTestId('version-var_tt')).not.toContainText('open comment');
  await list.getByRole('button', { name: 'Reopen' }).click();
  await list.getByRole('button', { name: 'Edit' }).click();
  await list.getByLabel('Comment text').fill('Hook is too slow: cut 10 frames');
  await list.getByRole('button', { name: 'Save' }).click();
  await expect(list).toContainText('cut 10 frames');

  // Approve: comments do not change it, a change to the picture does.
  const state = page.getByTestId('approval-state');
  await expect(state).toHaveText('Not approved');
  await page.getByRole('button', { name: 'Approve this version' }).click();
  await expect(state).toHaveText('Approved');
  await page.getByLabel('Comment', { exact: true }).fill('Nice ending');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect(list).toContainText('Nice ending');
  await expect(state).toHaveText('Approved');

  const store = await t.engine.openProject(dir);
  store.dispatch('core/variants.override', {
    variantId: 'var_tt',
    slotId: 'shot_boss',
    patch: { excluded: true },
  });
  await expect(state).toHaveText('Approval out of date');
  await expect(versions.getByTestId('version-var_tt')).toContainText('Approval out of date');
  store.undo();
  await expect(state).toHaveText('Approved');

  await page.getByRole('button', { name: 'Withdraw approval' }).click();
  await expect(state).toHaveText('Not approved');
  expect(await axe(page)).toEqual([]);
});

test('review: a finding that needs an override takes a reason, and the report follows it', async ({
  page,
}) => {
  // Nothing in the sample can be overridden and an override-tier plan finding is hard to force,
  // so the engine's answer is replaced here; the gate's own tests cover each check.
  const finding = {
    checkId: 'core/safe-area',
    severity: 'error',
    tier: 'override',
    message: 'text "OUT NOW" reaches outside the safe area',
    at: { start: 2.5 },
  };
  const sent: unknown[] = [];
  await page.route('**/versions/*/quality', async (route) => {
    const body = route.request().postDataJSON() as {
      overrides: { checkId: string; reason: string }[];
    };
    sent.push(body.overrides);
    const reason = body.overrides.find((o) => o.checkId === 'core/safe-area')?.reason;
    const verdict = {
      allowed: !!reason,
      blocking: [],
      needsOverride: reason ? [] : [finding],
      overridden: reason ? [{ ...finding, reason }] : [],
      warnings: [],
    };
    await route.fulfill({
      json: {
        variantId: 'var_tt',
        contentHash: 'h',
        preset: { id: 'core/vertical', name: 'Vertical social', extension: 'mp4' },
        findings: [finding],
        verdict,
      },
    });
  });
  await page.goto(`${t.svc.url}/p/${ID}/review#token=${t.svc.token}`);
  await page.getByTestId('version-var_tt').click();
  const verdict = page.getByTestId('gate-verdict');
  await expect(verdict).toContainText('Blocked: 1 needs an override with a reason');
  const needs = page.getByRole('region', { name: 'Blocks until you override it with a reason' });
  await expect(needs).toContainText('Text outside the safe area');
  await expect(needs).toContainText('2.5 s');

  const reason = page.getByTestId('override-safe-area');
  await reason.fill('The label is meant to bleed off the edge');
  await reason.blur();
  await expect(verdict).toContainText('May be exported');
  const overridden = page.getByRole('region', { name: 'Overridden for the next export' });
  await expect(overridden).toContainText('Overridden: The label is meant to bleed off the edge');
  expect(sent.at(-1)).toEqual([
    { checkId: 'core/safe-area', reason: 'The label is meant to bleed off the edge' },
  ]);

  // Clearing the reason takes the override back.
  await reason.fill('');
  await reason.blur();
  await expect(verdict).toContainText('Blocked');
  expect(await axe(page)).toEqual([]);
});
