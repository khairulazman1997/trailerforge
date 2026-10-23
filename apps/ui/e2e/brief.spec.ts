import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ServiceClient } from '@trailerforge/service';
import { startTestService, type TestService } from './support.js';

let t: TestService;
let projectId: string;

test.beforeAll(async () => {
  t = await startTestService();
  const client = new ServiceClient({ baseUrl: t.svc.url, token: t.svc.token });
  const p = await client.createProject({
    dir: join(t.root, 'Brief.tforge'),
    name: 'Ember Knight',
    videoTypeId: 'game-trailer/release-trailer',
  });
  projectId = p.id;
});
test.afterAll(async () => {
  await t.close();
});

const field = (page: Page, id: string) => page.locator(`[data-field="${id}"]`);
const percent = async (page: Page) =>
  Number((await page.getByTestId('brief-percent').textContent())!.replace('%', ''));

test('fill in a brief with suggestions, proceed with assumptions, and manage them', async ({
  page,
}) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));

  await page.goto(`${t.svc.url}/p/${projectId}/brief#token=${t.svc.token}`);
  await expect(page.getByRole('heading', { name: 'Brief' })).toBeVisible();

  // A fresh brief: nothing answered, eight things required for a release trailer.
  await expect(page.getByTestId('brief-percent')).toHaveText('0%');
  await expect(page.getByTestId('brief-status')).toHaveText('8 required details still needed');
  await expect(page.getByRole('heading', { name: 'Needs your answer (8)' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Brief completeness' })).toHaveAttribute(
    'aria-valuenow',
    '0',
  );

  // "Suggest for me" fills the box for review and saves nothing until you accept.
  const title = field(page, 'brief.title');
  await title.getByRole('button', { name: 'Suggest for me' }).click();
  await expect(title.getByRole('textbox')).toHaveValue('Ember Knight');
  await expect(title.locator('.suggestion')).toContainText('it fits the game facts');
  expect(await percent(page)).toBe(0);
  await title.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Needs your answer (7)' })).toBeVisible();
  expect(await percent(page)).toBeGreaterThan(0);
  expect(t.prompts).toHaveLength(1);

  // A wrong shape is explained, not swallowed.
  const points = field(page, 'brief.keySellingPoints');
  await points.getByRole('textbox').fill('Only one');
  await points.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toContainText('Key selling points');
  await points.getByRole('textbox').fill('Parry\nBosses\nFire');
  await points.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Needs your answer (6)' })).toBeVisible();

  // Choice, multi-choice, and release date (an exact date or a window both work).
  const genre = field(page, 'brief.extensions.game-trailer.genre');
  await genre.getByRole('combobox').selectOption({ index: 1 });
  await genre.getByRole('button', { name: 'Save' }).click();
  const platforms = field(page, 'brief.extensions.game-trailer.gamePlatforms');
  await platforms.getByRole('checkbox').nth(0).check();
  await platforms.getByRole('checkbox').nth(1).check();
  await platforms.getByRole('button', { name: 'Save' }).click();
  const release = field(page, 'brief.keyDates[label=Release].date');
  await release.getByRole('textbox').fill('Q2 2027');
  await release.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Needs your answer (3)' })).toBeVisible();

  // Output formats: choose one and see it listed.
  const formats = field(page, 'formatTargets');
  await formats.getByRole('checkbox').first().check();
  await formats.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Needs your answer (2)' })).toBeVisible();
  // Answered questions are tucked away while others are open; expand them to see the formats.
  await page.getByText(/^Answered \(\d+\)$/).click();
  await expect(
    page.getByRole('list', { name: 'Output formats in this project' }).getByRole('listitem'),
  ).toHaveCount(1);

  // Proceed with assumptions for what is left (tone and call to action).
  await page.getByRole('button', { name: 'Proceed with assumptions' }).click();
  const dialog = page.getByRole('dialog', { name: 'Proceed with assumptions?' });
  await expect(dialog).toContainText('2 missing required details');
  await dialog.getByRole('button', { name: 'Mark as assumptions' }).click();
  await expect(page.getByRole('heading', { name: 'Assumed (2)' })).toBeVisible();
  await expect(page.getByTestId('brief-status')).toHaveText('Can proceed with assumptions');
  const assumptions = page.getByRole('list', { name: 'Assumptions' });
  await expect(assumptions.getByRole('listitem')).toHaveCount(2);
  await expect(assumptions).toContainText('left open for the generator');

  // Removing an assumption puts the question back; undo brings the assumption back.
  await assumptions.getByRole('button', { name: 'Remove assumption for Tone' }).click();
  await expect(page.getByRole('heading', { name: 'Needs your answer (1)' })).toBeVisible();
  await expect(assumptions.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: /Undo/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Assumed (2)' })).toBeVisible();
  await expect(assumptions.getByRole('listitem')).toHaveCount(2);

  // Answering replaces an assumption; the brief is complete once nothing required is open.
  const tone = field(page, 'brief.tone');
  await tone.getByRole('checkbox').first().check();
  await tone.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Assumed (1)' })).toBeVisible();
  await expect(assumptions.getByRole('listitem')).toHaveCount(1);
  const cta = field(page, 'brief.callToAction');
  await cta.getByRole('combobox').selectOption({ index: 1 });
  await cta.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('brief-status')).toHaveText('Ready to generate');
  await expect(page.getByText('None. Everything above comes from you.')).toBeVisible();

  // The answers persist across a reload.
  const done = await percent(page);
  await page.reload();
  await expect(page.getByTestId('brief-percent')).toHaveText(`${done}%`);
  await expect(page.getByTestId('brief-status')).toHaveText('Ready to generate');

  // The only console noise allowed is the browser logging the 400 we provoked on purpose above.
  expect(problems.filter((p) => !/Failed to load resource.*status of 400/.test(p))).toEqual([]);
});

test('changing the video type changes what is asked', async ({ page }) => {
  await page.goto(`${t.svc.url}/p/${projectId}/brief#token=${t.svc.token}`);
  const before = await page.locator('.field').count();
  await page.getByLabel('Video type').selectOption('game-trailer/gameplay-trailer');
  await expect(page.getByTestId('brief-status')).toBeVisible();
  await expect.poll(() => page.locator('.field').count()).not.toBe(before);
  await expect(page.locator('.meter-text')).toContainText('Gameplay trailer');
});
