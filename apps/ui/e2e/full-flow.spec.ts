import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { startTestService, type TestService } from './support.js';

const SECRET = 'STEAM-KEY-DO-NOT-LEAK';
const REPO: Record<string, string> = {
  'README.md':
    '# Ember Knight\n\nA soulslike about parrying fire.\n\n## Bosses\n- The Ash Warden — second-act boss with two phases\n',
  '.env': `STEAM_API_KEY=${SECRET}`,
};

let t: TestService;
let repo: string;

test.beforeAll(async () => {
  t = await startTestService();
  repo = join(t.root, 'game');
  for (const [p, c] of Object.entries(REPO)) {
    await mkdir(dirname(join(repo, p)), { recursive: true });
    await writeFile(join(repo, p), c);
  }
});
test.afterAll(async () => {
  await t.close();
});

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name });
const titles = (scope: Locator) =>
  scope
    .locator('input.slot-title')
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));

test('create → scan → brief → generate → edit → regenerate → undo, all in the browser', async ({
  page,
}) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));

  // Create.
  await page.goto(`${t.svc.url}/#token=${t.svc.token}`);
  await page.getByLabel('Name', { exact: true }).fill('Ember Knight');
  await page.getByLabel('Video type').selectOption('game-trailer/release-trailer');
  await page.getByLabel('Project folder (will be created)').fill(join(t.root, 'Flow.tforge'));
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByLabel('Project name')).toHaveValue('Ember Knight');

  // Scan the game repo; the secret file is skipped.
  await nav(page, 'Knowledge').click();
  await page.getByLabel('Folder of your game repo').fill(repo);
  await page.getByRole('button', { name: 'Add repo and scan' }).click();
  await expect(page.getByTestId('scan-result')).toContainText('Scanned');
  await expect(page.locator('.entity', { hasText: 'The Ash Warden' })).toBeVisible();

  // Brief: take a suggestion.
  await nav(page, 'Brief').click();
  const title = page.locator('[data-field="brief.title"]');
  await title.getByRole('button', { name: 'Suggest for me' }).click();
  await expect(title.getByRole('textbox')).toHaveValue('Ember Knight');
  await title.getByRole('button', { name: 'Save' }).click();

  // Generate, proceeding with assumptions for the rest of the brief.
  await nav(page, 'Storyboard').click();
  await page.getByRole('button', { name: 'Generate storyboard…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Generate a storyboard' });
  await dialog.getByLabel(/Proceed with assumptions/).check();
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
  const hook = page.locator('[data-section="sec_hook"]');
  await expect.poll(() => titles(hook)).toEqual(['Perfect parry', 'Forest run']);
  expect(t.prompts.at(-1)).toContain('Ash Warden');

  // Edit by hand, then rewrite the section around the edit.
  const slot = hook.getByLabel('Title of Perfect parry', { exact: true });
  await slot.fill('Hand parry');
  await slot.press('Enter');
  await expect(hook.locator('.slot').first()).toContainText('Edited');
  await page.getByRole('button', { name: 'Rewrite Hook' }).click();
  await page
    .getByRole('dialog', { name: 'Rewrite “Hook”' })
    .getByRole('button', { name: 'Rewrite section' })
    .click();
  await expect.poll(() => titles(hook)).toEqual(['Hand parry', 'Warden lands', 'Forest ambush']);

  // Undo walks back: first the rewrite, then the hand edit.
  const undo = page.getByRole('button', { name: /Undo/ }).first();
  await undo.click();
  await expect.poll(() => titles(hook)).toEqual(['Hand parry', 'Forest run']);
  await undo.click();
  await expect.poll(() => titles(hook)).toEqual(['Perfect parry', 'Forest run']);

  // Nothing secret ever reached the AI or the page.
  for (const p of t.prompts) expect(p).not.toContain(SECRET);
  await expect(page.getByText(SECRET)).toHaveCount(0);
  expect(problems).toEqual([]);
});
