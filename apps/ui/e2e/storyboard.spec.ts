import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { ServiceClient } from '@trailerforge/service';
import { startTestService, type TestService } from './support.js';

// Drag and drop is driven with the mouse, and Playwright cannot scroll mid-drag the way a real
// browser auto-scrolls. A tall window keeps source and target on screen together.
test.use({ viewport: { width: 1280, height: 1800 } });

let t: TestService;
let projectId: string;

test.beforeAll(async () => {
  t = await startTestService();
  const client = new ServiceClient({ baseUrl: t.svc.url, token: t.svc.token });
  // The sample project has a locked "End slate" section; generation keeps it and writes the rest.
  await t.engine.createProject(join(t.root, 'SB.tforge'), sampleProject() as never);
  projectId = 'proj_sample';
  const task = await client.startTask(projectId, {
    kind: 'generate',
    options: { duration: 30, assume: true },
  });
  expect((await client.waitForTask(task.id)).status).toBe('succeeded');
});
test.afterAll(async () => {
  await t.close();
});

const section = (page: Page, id: string) => page.locator(`[data-section="${id}"]`);
// The inner locator of `filter({ has })` is resolved inside each row, so it must be built from `page`.
const row = (page: Page, scope: Locator, title: string) =>
  scope.locator('.slot').filter({ has: page.getByLabel(`Title of ${title}`, { exact: true }) });
const titles = (scope: Locator) =>
  scope
    .locator('input.slot-title')
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
const undo = (page: Page) => page.getByRole('button', { name: /Undo/ }).first();

test('edit, retime, reorder, drag, delete and undo', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));

  await page.goto(`${t.svc.url}/p/${projectId}/storyboard#token=${t.svc.token}`);
  await expect(page.getByRole('heading', { name: 'Storyboard' })).toBeVisible();

  // Generated sections plus the sample's locked end slate; the length matches the 30 s target.
  const hook = section(page, 'sec_hook');
  const escalation = section(page, 'sec_escalation');
  const end = section(page, 'sec_end');
  await expect.poll(() => titles(hook)).toEqual(['Perfect parry', 'Forest run']);
  await expect(page.getByTestId('timing-actual')).toHaveText('30 s');
  await expect(page.getByTestId('timing-state')).toHaveText('On target');
  await expect(end).toContainText('Locked');

  // Inline edit: title (marked as hand-edited) and length (the bar reports the overshoot).
  const title = hook.getByLabel('Title of Forest run', { exact: true });
  await title.fill('Forest sprint');
  await title.press('Enter');
  await expect(row(page, hook, 'Forest sprint')).toContainText('Edited');
  const seconds = hook.getByLabel('Length of Forest sprint in seconds');
  const before = Number((await page.getByTestId('timing-actual').textContent())!.replace(' s', ''));
  const old = Number(await seconds.inputValue());
  await seconds.fill(String(old + 5));
  await seconds.press('Enter');
  await expect(page.getByTestId('timing-actual')).toHaveText(
    `${Math.round((before + 5) * 10) / 10} s`,
  );
  await expect(page.getByTestId('timing-state')).toHaveText('5 s over');
  // The target is the user's call: raise it to match and the warning goes.
  const target = page.getByLabel('Target length in seconds');
  await target.fill('35');
  await target.press('Enter');
  await expect(page.getByTestId('timing-state')).toHaveText('On target');

  // Details editor.
  await page.getByRole('button', { name: 'Edit details of Forest sprint' }).click();
  await row(page, hook, 'Forest sprint')
    .getByLabel('What to capture')
    .fill('Sprint through the burning forest.');
  await row(page, hook, 'Forest sprint').getByRole('button', { name: 'Save details' }).click();
  await expect(row(page, hook, 'Forest sprint')).toContainText(
    'Sprint through the burning forest.',
  );

  // Reorder with the buttons (the keyboard path).
  await page.getByRole('button', { name: 'Move Forest sprint up' }).click();
  await expect.poll(() => titles(hook)).toEqual(['Forest sprint', 'Perfect parry']);

  // Drag a slot from another section to just before the first one.
  const handle = escalation.getByRole('button', { name: 'Drag Boss reveal to move it' });
  await handle.dragTo(row(page, hook, 'Forest sprint'), { targetPosition: { x: 40, y: 2 } });
  await expect.poll(() => titles(hook)).toEqual(['Boss reveal', 'Forest sprint', 'Perfect parry']);
  await expect(escalation).toContainText('No slots yet');

  // Delete it, then undo brings it back in place.
  await page.getByRole('button', { name: 'Delete Boss reveal' }).click();
  await expect.poll(() => titles(hook)).toEqual(['Forest sprint', 'Perfect parry']);
  await undo(page).click();
  await expect.poll(() => titles(hook)).toEqual(['Boss reveal', 'Forest sprint', 'Perfect parry']);

  expect(problems).toEqual([]);
});

test('locked sections refuse edits and drops, and unlocking restores them', async ({ page }) => {
  await page.goto(`${t.svc.url}/p/${projectId}/storyboard#token=${t.svc.token}`);
  const hook = section(page, 'sec_hook');
  const end = section(page, 'sec_end');
  await expect(end).toContainText('This section is locked');

  // Nothing in a locked section can be edited, moved or deleted.
  await expect(
    end.getByRole('button', { name: /Edit details|Delete|Add shot|Add card|Drag/ }),
  ).toHaveCount(0);
  await expect(end.locator('input.slot-title')).toHaveCount(0);

  // Dropping a slot onto it does nothing.
  const first = (await titles(hook))[0]!;
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __drag: string[] }).__drag = seen;
    for (const type of ['dragstart', 'drop'])
      document.addEventListener(type, () => seen.push(type), true);
  });
  await hook
    .getByRole('button', { name: `Drag ${first} to move it` })
    .dragTo(end.locator('.slot').first());
  // The drag really started, and the locked section never accepted a drop (so no drop event fired).
  expect(await page.evaluate(() => (window as unknown as { __drag: string[] }).__drag)).toEqual([
    'dragstart',
  ]);
  await expect.poll(() => titles(hook).then((t) => t.includes(first))).toBe(true);
  await expect(end.locator('.slot')).toHaveCount(1);

  // Unlock: controls appear. Lock again: they go.
  await end.getByRole('button', { name: /Unlock/ }).click();
  await expect(end.getByRole('button', { name: 'Add shot' })).toBeVisible();
  await expect(end).not.toContainText('This section is locked');
  await end.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(end.getByRole('button', { name: 'Add shot' })).toHaveCount(0);
});

test('sections can be added, renamed, moved and deleted, and the "why" panel explains generation', async ({
  page,
}) => {
  await page.goto(`${t.svc.url}/p/${projectId}/storyboard#token=${t.svc.token}`);

  await page.getByLabel('New section').fill('Outro');
  await page.getByRole('button', { name: 'Add section' }).click();
  const fresh = page
    .locator('[data-section]')
    .filter({ has: page.getByLabel('Name of section Outro') });
  await expect(fresh).toHaveCount(1);
  const outro = section(page, (await fresh.getAttribute('data-section'))!);
  await outro.getByRole('button', { name: 'Add card' }).click();
  await expect(outro.locator('.slot.card')).toHaveCount(1);

  await outro.getByLabel('Name of section Outro').fill('Closing');
  await outro.getByLabel('Name of section Outro').press('Enter');
  await expect(page.getByLabel('Name of section Closing')).toBeVisible();
  const ids = () =>
    page
      .locator('[data-section]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-section')));
  const closing = page
    .locator('[data-section]')
    .filter({ has: page.getByLabel('Name of section Closing') });
  await closing.getByRole('button', { name: 'Move section Closing up' }).click();
  await expect.poll(async () => (await ids()).indexOf('sec_end')).toBeGreaterThan(1);

  await closing.getByRole('button', { name: 'Delete section Closing' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete “Closing”?' });
  await expect(dialog).toContainText('1 slot(s)');
  await dialog.getByRole('button', { name: 'Delete section' }).click();
  await expect(page.getByLabel('Name of section Closing')).toHaveCount(0);

  // Why: the generation is explained, per storyboard and per section.
  await page.getByRole('button', { name: 'Why this storyboard?' }).click();
  const why = page.getByRole('complementary', { name: 'Why this storyboard' });
  await expect(why).toContainText('Generated the storyboard');
  await expect(why).toContainText('Opens on a parry, builds to the Warden, ends on the title.');
  await page.getByRole('button', { name: 'Why Hook?' }).click();
  await expect(page.getByRole('heading', { name: 'Why “Hook”' })).toBeVisible();
  await expect(why).toContainText('Generated the storyboard');
  await why.getByRole('button', { name: 'Show everything' }).click();
  await why.getByRole('button', { name: 'Close' }).click();
  await expect(why).toHaveCount(0);
});

test('changes made elsewhere appear live, and an empty project explains itself', async ({
  page,
}) => {
  await page.goto(`${t.svc.url}/p/${projectId}/storyboard#token=${t.svc.token}`);
  const client = new ServiceClient({ baseUrl: t.svc.url, token: t.svc.token });
  await client.command(projectId, 'core/storyboard.update-section', {
    sectionId: 'sec_hook',
    patch: { name: 'Cold open' },
  });
  await expect(page.getByLabel('Name of section Cold open')).toBeVisible();

  const fresh = await client.createProject({ dir: join(t.root, 'Empty.tforge'), name: 'Empty' });
  await page.goto(`${t.svc.url}/p/${fresh.id}/storyboard`);
  await expect(page.getByText('This project has no storyboard yet')).toBeVisible();
});
