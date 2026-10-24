import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { startTestService, type TestService } from './support.js';

// Drag and drop is driven with the mouse; a tall window keeps source and target on screen.
test.use({ viewport: { width: 1280, height: 1800 } });

let t: TestService;
const ID = 'proj_sample';

test.beforeAll(async () => {
  t = await startTestService();
  const p = sampleProject() as unknown as {
    storyboard: { sections: { slots: { id: string; entityIds?: string[] }[] }[] };
    knowledge: Record<string, unknown>[];
  };
  // Both shots feature the Warden, so they share one capture group and can be reordered.
  p.storyboard.sections[0]!.slots[0]!.entityIds = ['ent_warden'];
  const tagged = (id: string, name: string, description: string, tags: string[]) => ({
    id,
    kind: 'other',
    name,
    description,
    tags,
    origin: 'user',
  });
  p.knowledge.push(
    tagged('ent_god', 'god', 'Debug console command: `god`', ['debug-command', 'all-levels']),
    tagged('ent_save', 'slot1.sav', 'Windows: %USERPROFILE%\\AppData\\LocalLow\\Ember\\slot1.sav', [
      'save-file',
      'all-levels',
    ]),
    tagged('ent_warp', 'warp_forest', 'Debug console command: `warp forest`', ['debug-command']),
  );
  await t.engine.createProject(join(t.root, 'Cap.tforge'), p as never);
});
test.afterAll(async () => {
  await t.close();
});

const open = (page: Page) => page.goto(`${t.svc.url}/p/${ID}/capture#token=${t.svc.token}`);
const titles = (page: Page) => page.locator('.cap-item .cap-title').allTextContents();
const progress = (page: Page) => page.getByTestId('cap-progress-text');
const undo = (page: Page) => page.getByRole('button', { name: /Undo/ }).first();

test('tick shots off, count takes, write notes, skip, reorder, and undo', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));

  await open(page);
  await expect(page.getByRole('heading', { name: 'Capture', level: 1 })).toBeVisible();
  await expect(progress(page)).toContainText('0 of 2 shots recorded');

  // Setup that applies everywhere is shown once; group-specific setup stays with its group.
  const everywhere = page.getByRole('region', { name: 'Setup that applies everywhere' });
  await expect(everywhere).toContainText('god');
  await expect(everywhere).toContainText('slot1.sav');
  await expect(page.locator('.cap-group')).toHaveCount(1);
  await expect(page.locator('.cap-group')).toContainText('warp_forest');
  await expect(page.locator('.cap-group')).not.toContainText('slot1.sav');
  await expect(page.locator('.cap-group').getByRole('heading', { level: 2 })).toContainText(
    'Forest · The Ash Warden',
  );
  await expect.poll(() => titles(page)).toEqual(['Perfect parry', 'Boss reveal']);

  // Tick off a shot: progress, group count and status follow; undo takes it back.
  await page.getByRole('checkbox', { name: 'Recorded: Perfect parry' }).check();
  await expect(progress(page)).toContainText('1 of 2 shots recorded');
  await expect(page.getByTestId('cap-count-0')).toHaveText('(1/2)');
  await expect(page.getByLabel('Status of Perfect parry')).toHaveValue('recorded');
  await undo(page).click();
  await expect(progress(page)).toContainText('0 of 2 shots recorded');
  await expect(page.getByRole('checkbox', { name: 'Recorded: Perfect parry' })).not.toBeChecked();

  // Each shot shows the code to put in its recording's file name (same as the pack).
  await expect(page.locator('[data-slot="shot_boss"] .cap-code')).toHaveText('TF-ZXV5G');

  // Rejecting a shot keeps it on the list, flagged to record again.
  await page.getByLabel('Status of Boss reveal').selectOption('rejected');
  await expect(page.locator('[data-slot="shot_boss"]')).toContainText('Record again');
  await expect(progress(page)).toContainText('0 of 2');

  // Takes.
  await page.getByRole('button', { name: 'One more take of Perfect parry' }).click();
  await page.getByRole('button', { name: 'One more take of Perfect parry' }).click();
  await expect(page.getByLabel('Takes recorded of Perfect parry')).toHaveText('2 takes');
  await page.getByRole('button', { name: 'One fewer take of Perfect parry' }).click();
  await expect(page.getByLabel('Takes recorded of Perfect parry')).toHaveText('1 take');

  // Notes are saved when you leave the box, and survive a reload.
  const notes = page.getByLabel('Notes for Boss reveal');
  await notes.fill('Wait for the intro cinematic <twice> | skip it');
  await notes.blur();
  await page.reload();
  await expect(page.getByLabel('Notes for Boss reveal')).toHaveValue(
    'Wait for the intro cinematic <twice> | skip it',
  );

  // Reorder with the buttons (the keyboard path), then with the mouse; undo restores each.
  await page.getByRole('button', { name: 'Move Boss reveal up' }).click();
  await expect.poll(() => titles(page)).toEqual(['Boss reveal', 'Perfect parry']);
  await expect(page.getByRole('button', { name: 'Move Boss reveal up' })).toBeDisabled();
  await undo(page).click();
  await expect.poll(() => titles(page)).toEqual(['Perfect parry', 'Boss reveal']);
  await page
    .locator('[data-slot="shot_boss"] .handle')
    .dragTo(page.locator('[data-slot="shot_parry"]'), { targetPosition: { x: 40, y: 2 } });
  await expect.poll(() => titles(page)).toEqual(['Boss reveal', 'Perfect parry']);

  // Skipping removes a shot from the checklist and the totals; restoring brings it back.
  await page.getByRole('button', { name: 'Skip Perfect parry' }).click();
  await expect(progress(page)).toContainText('0 of 1 shots recorded');
  await expect.poll(() => titles(page)).toEqual(['Boss reveal']);
  const skipped = page.getByRole('region', { name: 'Skipped shots' });
  await expect(skipped).toContainText('Perfect parry');
  await skipped.getByRole('button', { name: 'Restore Perfect parry' }).click();
  await expect(progress(page)).toContainText('0 of 2 shots recorded');
  await expect(skipped).toHaveCount(0);

  expect(problems).toEqual([]);
});

test('recording settings show what is derived, accept overrides, and undo', async ({ page }) => {
  await open(page);
  const panel = page.getByRole('region', { name: 'Recording settings' });
  await expect(panel.getByLabel('Frame rate (fps)', { exact: true })).toHaveValue('60');
  await expect(panel.locator('[data-setting="fps"]')).toContainText('Derived');
  // The platforms in the sample brief (PC, PS5) make this a 4K capture.
  await expect(panel.getByLabel('Resolution', { exact: true })).toHaveValue('3840x2160');
  await expect(panel.getByRole('list', { name: 'Recording warnings' })).toContainText(
    'constant frame rate',
  );
  await expect(panel.getByRole('button', { name: 'Reset all overrides' })).toBeDisabled();

  // Override the frame rate; bitrate follows the effective settings only where it is derived.
  const fps = panel.getByLabel('Frame rate (fps)', { exact: true });
  await fps.fill('30');
  await fps.press('Enter');
  await expect(panel.locator('[data-setting="fps"]')).toContainText('Your override');
  await expect(panel.locator('[data-setting="bitrateMbps"]')).toContainText('Derived');
  await expect(panel.getByLabel('Bitrate (Mbps)', { exact: true })).toHaveValue('70');

  // Not a number: refused with a message, the value stays.
  await fps.fill('fast');
  await fps.press('Enter');
  await expect(panel.getByRole('alert')).toContainText('whole number');
  await expect(fps).toHaveValue('30');

  await panel.getByLabel('Codec', { exact: true }).selectOption('av1');
  await panel.getByLabel('HUD', { exact: true }).selectOption('per-shot');
  await panel.getByLabel('Record HDR', { exact: true }).check();
  await expect(panel.getByRole('list', { name: 'Recording warnings' })).toContainText('HDR');

  // Undo walks back one override at a time; reset clears the rest.
  await undo(page).click();
  await expect(panel.getByLabel('Record HDR', { exact: true })).not.toBeChecked();
  await panel.getByRole('button', { name: 'Reset Frame rate (fps) to the derived value' }).click();
  await expect(fps).toHaveValue('60');
  await panel.getByRole('button', { name: 'Reset all overrides' }).click();
  await expect(panel.getByLabel('Codec', { exact: true })).toHaveValue('hevc');
  await expect(panel.getByLabel('HUD', { exact: true })).toHaveValue('off');
  await expect(panel.locator('.chip', { hasText: 'Your override' })).toHaveCount(0);
});

test('a project with no storyboard points to the storyboard, and tabs are reachable by keyboard', async ({
  page,
}) => {
  await t.engine.createProject(join(t.root, 'Empty.tforge'), { name: 'Empty' });
  const empty = [...t.engine.projects.values()].find((s) => s.state.name === 'Empty')!.state.id;
  await page.goto(`${t.svc.url}/p/${empty}/capture#token=${t.svc.token}`);
  await expect(page.getByText('comes from the storyboard')).toBeVisible();
  await page.getByRole('link', { name: 'Write the storyboard' }).click();
  await expect(page.getByRole('heading', { name: 'Storyboard' })).toBeVisible();

  await open(page);
  const tab = page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', {
    name: 'Capture',
  });
  await expect(tab).toHaveAttribute('aria-current', 'page');
});
