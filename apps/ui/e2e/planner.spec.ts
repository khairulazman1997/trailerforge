import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { startTestService, type TestService } from './support.js';

test.describe.configure({ mode: 'serial' });

let t: TestService;
test.beforeAll(async () => {
  t = await startTestService();
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

// Days 10 and 17 exist in every month, so the test does not depend on the date it runs.
const now = new Date();
const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const day = (n: number) => `${month}-${String(n).padStart(2, '0')}`;
const cell = (page: Page, date: string) => page.locator(`td[data-date="${date}"]`);
/** Each test gets a fresh browser, so the calendar is switched on the way Settings does it. */
const switchOn = (page: Page) =>
  page.addInitScript(() => localStorage.setItem('tforge.features', '{"planner":true}'));
const MOVE_GAP = 1100; // quick repeated moves of one video are one undo step; keep them apart

test('the calendar is off until it is switched on in Settings', async ({ page }) => {
  await page.goto(`${t.svc.url}/#token=${t.svc.token}`);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Planner' })).toHaveCount(0);

  await page.goto(`${t.svc.url}/planner`);
  await expect(page.getByText('The content calendar is switched off.')).toBeVisible();
  await page.getByRole('link', { name: 'Turn it on in Settings' }).click();
  await page.getByLabel('Content calendar (Planner)').check();
  await expect(nav.getByRole('link', { name: 'Planner' })).toBeVisible();

  // The choice is kept for this browser.
  await page.goto(`${t.svc.url}/#token=${t.svc.token}`);
  await expect(nav.getByRole('link', { name: 'Planner' })).toBeVisible();
});

test('plan a video, move it by drag and by keyboard, and undo', async ({ page }) => {
  await switchOn(page);
  await page.goto(`${t.svc.url}/planner#token=${t.svc.token}`);
  await expect(page.getByRole('heading', { name: 'Planner', level: 1 })).toBeVisible();
  await expect(page.getByText('Nothing is planned yet.')).toBeVisible();
  expect(await axe(page)).toEqual([]);

  await page.getByLabel('New campaign').fill('Launch');
  await page.getByRole('button', { name: 'Add campaign' }).click();
  await expect(page.getByLabel('Name of campaign Launch')).toHaveValue('Launch');

  await page.getByRole('button', { name: 'Plan a video', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Plan a video' });
  await dialog.getByLabel('Title').fill('Release trailer');
  await dialog.getByLabel('Date').fill(day(10));
  await dialog.getByLabel('Campaign').selectOption({ label: 'Launch' });
  await dialog.getByRole('checkbox', { name: 'YouTube 16:9', exact: true }).check();
  await dialog.getByRole('checkbox', { name: 'TikTok 9:16', exact: true }).check();
  expect(await axe(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Add to the calendar' }).click();
  await expect(dialog).toHaveCount(0);

  const chip = page.locator('[data-slot]').filter({ hasText: 'Release trailer' });
  await expect(cell(page, day(10)).locator('[data-slot]')).toHaveText(/Release trailer/);
  await expect(chip.locator('.plan-status')).toHaveText('No project yet');
  expect(await axe(page)).toEqual([]);

  // Drag it to the 17th.
  await page.waitForTimeout(MOVE_GAP);
  await chip.dragTo(cell(page, day(17)));
  await expect(cell(page, day(17)).locator('[data-slot]')).toHaveText(/Release trailer/);
  await expect(cell(page, day(10)).locator('[data-slot]')).toHaveCount(0);

  // Keyboard: Shift and the arrow keys move the focused video a day or a week.
  await page.waitForTimeout(MOVE_GAP);
  await chip.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(cell(page, day(18)).locator('[data-slot]')).toHaveCount(1);
  await expect(chip).toBeFocused(); // focus follows the video to its new day
  await page.waitForTimeout(MOVE_GAP);
  await page.keyboard.press('Shift+ArrowDown');
  await expect(cell(page, day(25)).locator('[data-slot]')).toHaveCount(1);

  // Undo walks the three moves back, one at a time.
  const undo = page.getByRole('button', { name: /Undo/ });
  await undo.click();
  await expect(cell(page, day(18)).locator('[data-slot]')).toHaveCount(1);
  await undo.click();
  await expect(cell(page, day(17)).locator('[data-slot]')).toHaveCount(1);
  await undo.click();
  await expect(cell(page, day(10)).locator('[data-slot]')).toHaveCount(1);
  await page.getByRole('button', { name: /Redo/ }).click();
  await expect(cell(page, day(17)).locator('[data-slot]')).toHaveCount(1);

  // The shortcut list for this page names the keys.
  await page.keyboard.press('?');
  const keys = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(keys).toContainText('Move the focused planned video one day earlier or later');
  await keys.getByRole('button', { name: 'Close' }).click();
});

test('the list view, the campaign filter and an edit', async ({ page }) => {
  await switchOn(page);
  await page.goto(`${t.svc.url}/planner#token=${t.svc.token}`);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const list = page.getByRole('table', { name: 'Planned videos' });
  const row = list.locator('[data-slot-row]').filter({ hasText: 'Release trailer' });
  await expect(row).toContainText('YouTube, TikTok');
  await expect(row).toContainText('Launch');
  expect(await axe(page)).toEqual([]);

  await page.locator('.planner-bar select').selectOption('none');
  await expect(list).toHaveCount(0);
  await page.locator('.planner-bar select').selectOption('all');

  await row.getByRole('button', { name: 'Release trailer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Planned video' });
  await dialog.getByLabel('Title').fill('Launch trailer');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(list).toContainText('Launch trailer');
  await expect(list).not.toContainText('Release trailer');
});

test('make the project for a planned video, then follow its status', async ({ page }) => {
  await switchOn(page);
  await page.goto(`${t.svc.url}/planner#token=${t.svc.token}`);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByRole('button', { name: 'Launch trailer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Planned video' });
  await expect(dialog).toContainText('No project yet.');
  await dialog.getByRole('button', { name: 'Create project' }).click();

  // The project opens, with a version format for each platform.
  await expect(page).toHaveURL(/\/p\/proj_/);
  const made = [...t.engine.projects.values()].find((s) => s.state.name === 'Launch trailer')!;
  expect(made.state.formatTargets.map((f) => f.platformIds[0])).toEqual([
    'core/youtube',
    'core/tiktok',
  ]);
  expect(made.state.scheduledDate).toBe(day(17)); // where the calendar had it

  await page.goto(`${t.svc.url}/planner#token=${t.svc.token}`);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const row = page.locator('[data-slot-row]').filter({ hasText: 'Launch trailer' });
  await expect(row).toContainText('Idea');

  // Status is set by hand in the dialog; the calendar follows.
  await row.getByRole('button', { name: 'Launch trailer' }).click();
  const edit = page.getByRole('dialog', { name: 'Planned video' });
  await expect(edit.getByRole('button', { name: 'Open project' })).toBeEnabled();
  await edit.getByLabel('Status').selectOption('capturing');
  await expect.poll(() => made.state.status).toBe('capturing');
  await expect(edit.locator('.chip').first()).toHaveText('Capturing');
  await edit.getByRole('button', { name: 'Cancel' }).click();
  await expect(row).toContainText('Capturing');

  // The Projects screen lists it from the engine's list of known projects.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects' })
    .click();
  const known = page.getByRole('list', { name: 'Opened before' });
  await expect(known).toContainText('Launch trailer');
  await expect(known).toContainText('Capturing');
});

test('a suggestion for the next status is applied only when asked for', async ({ page }) => {
  await switchOn(page);
  // A project with a storyboard and a cut is further along than "Idea".
  const store = await t.engine.createProject(join(t.root, 'Sample.tforge'), {
    ...sampleProject(),
    id: 'proj_sample',
  } as never);
  await t.engine.planner.dispatch('planner/slot.add', {
    id: 'cal_sample',
    date: day(12),
    title: 'Sample cut',
    platformTargets: ['core/youtube'],
  });
  await t.engine.planner.dispatch('planner/slot.link', {
    slotId: 'cal_sample',
    projectId: 'proj_sample',
  });
  expect(store.state.status).toBe('idea');

  await page.goto(`${t.svc.url}/planner#token=${t.svc.token}`);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const row = page.locator('[data-slot-row]').filter({ hasText: 'Sample cut' });
  await expect(row).toContainText('Idea');
  const apply = row.getByRole('button', { name: /^Mark / });
  await expect(apply).toBeVisible();
  expect(store.state.status).toBe('idea'); // shown, not applied
  await apply.click();
  await expect.poll(() => store.state.status).not.toBe('idea');
  await expect(row.getByRole('button', { name: /^Mark / })).toHaveCount(0);
  expect(await axe(page)).toEqual([]);
});

test('removing a planned video is confirmed and can be undone', async ({ page }) => {
  await switchOn(page);
  await page.goto(`${t.svc.url}/planner#token=${t.svc.token}`);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await t.engine.planner.dispatch('planner/slot.add', {
    id: 'cal_gone',
    date: day(20),
    title: 'Short-lived',
  });
  const row = page.locator('[data-slot-row]').filter({ hasText: 'Short-lived' });
  await row.getByRole('button', { name: 'Short-lived' }).click();
  await page
    .getByRole('dialog', { name: 'Planned video' })
    .getByRole('button', { name: 'Remove from the calendar' })
    .click();
  await page
    .getByRole('dialog', { name: 'Remove from the calendar?' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: /Undo/ }).click();
  await expect(row).toHaveCount(1);
});

test('projects an older version remembered in the browser move to the engine list once', async ({
  page,
}) => {
  const dir = join(t.root, 'Remembered.tforge');
  await t.engine.createProject(dir, { name: 'Remembered' });
  await t.engine.closeProject(dir);
  await t.engine.registry.forget(dir); // the engine does not know it yet, as after an upgrade
  await page.addInitScript((d) => localStorage.setItem('tforge.recent', JSON.stringify([d])), dir);
  await page.goto(`${t.svc.url}/#token=${t.svc.token}`);
  const known = page.getByRole('list', { name: 'Opened before' });
  await expect(known).toContainText('Remembered');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('tforge.recent'))).toBeNull();
  expect(await axe(page)).toEqual([]);
});
