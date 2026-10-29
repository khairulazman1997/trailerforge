import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ServiceClient } from '@trailerforge/service';
import { startTestService, type TestService } from './support.js';

let t: TestService;
let client: ServiceClient;
let source: string;
let other: string;

const open = (id: string, tab: string) => `${t.svc.url}/p/${id}/${tab}#token=${t.svc.token}`;

async function axe(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical' || v.id === 'heading-order')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test.beforeAll(async () => {
  t = await startTestService();
  client = new ServiceClient({ baseUrl: t.svc.url, token: t.svc.token });
  const make = async (name: string, videoTypeId: string) =>
    (await client.createProject({ dir: join(t.root, `${name}.tforge`), name, videoTypeId })).id;
  source = await make('Teaser', 'game-trailer/custom');
  other = await make('Next', 'game-trailer/release-trailer');
  await client.command(source, 'core/brief.set-field', {
    path: 'brief.extensions.game-trailer.customType',
    value: 'A 20 s Kickstarter teaser',
  });
  const task = await client.startTask(source, {
    kind: 'generate',
    options: { duration: 20, assume: true },
  });
  expect((await client.waitForTask(task.id)).status).toBe('succeeded');
});
test.afterAll(async () => {
  await t.close();
});

test('"Something else" sends the description; the structure saves and is picked in another project', async ({
  page,
}) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  expect(t.prompts.at(-1)).toContain('A 20 s Kickstarter teaser');

  await page.goto(open(source, 'storyboard'));
  await page.getByRole('button', { name: 'Save as a video type…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save as a video type' });
  await expect(dialog.getByLabel('Description')).toHaveValue('A 20 s Kickstarter teaser');
  expect(await axe(page)).toEqual([]);
  await dialog.getByLabel('Name').fill('Kickstarter teaser');
  await dialog.getByRole('button', { name: 'Save video type' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Saved "Kickstarter teaser"')).toBeVisible();

  // The other project's Brief lists it under "Saved by you"; picking it keeps a copy.
  await page.goto(open(other, 'brief'));
  const select = page.getByLabel('Video type');
  await expect(select.locator('optgroup[label="Saved by you"] option')).toHaveText([
    'Kickstarter teaser',
  ]);
  await select.selectOption('user/kickstarter-teaser');
  await expect
    .poll(async () => (await client.getProject(other)).project.extensions.core)
    .toMatchObject({ savedVideoType: { id: 'user/kickstarter-teaser' } });

  // Settings: rename, then delete; the project keeps working from its copy.
  await page.goto(`${t.svc.url}/settings#token=${t.svc.token}`);
  const panel = page.getByTestId('saved-types-panel');
  const name = panel.getByLabel('Name of Kickstarter teaser');
  await name.fill('KS teaser');
  await name.press('Enter');
  await expect(panel.getByLabel('Name of KS teaser')).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await panel.getByRole('button', { name: 'Delete KS teaser' }).click();
  await page.getByRole('button', { name: 'Delete video type' }).click();
  await expect(panel.getByText('You have not saved any video types yet.')).toBeVisible();

  await page.goto(open(other, 'brief'));
  await expect(page.getByLabel('Video type')).toHaveValue('user/kickstarter-teaser');
  await expect(page.getByLabel('Video type').locator('option:checked')).toHaveText(
    'Kickstarter teaser',
  );
  expect(problems).toEqual([]);
});
