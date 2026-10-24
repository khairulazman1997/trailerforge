import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { ServiceClient } from '@trailerforge/service';
import { startTestService, type TestService } from './support.js';

let t: TestService;
let client: ServiceClient;
let dir: string;
const ID = 'proj_sample';

test.beforeAll(async () => {
  t = await startTestService();
  client = new ServiceClient({ baseUrl: t.svc.url, token: t.svc.token });
  dir = join(t.root, 'Flow.tforge');
  await t.engine.createProject(dir, sampleProject() as never);
});
test.afterAll(async () => {
  await t.close();
});

/** Serious and critical WCAG 2.x A/AA problems on the page, as readable lines. */
async function axe(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical' || v.id === 'heading-order')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test('storyboard → capture → tick off by keyboard → export, and the pack matches', async ({
  page,
}) => {
  // Generate the storyboard (the generate dialog itself is covered by generate.spec).
  const task = await client.startTask(ID, {
    kind: 'generate',
    options: { duration: 30, assume: true },
  });
  expect((await client.waitForTask(task.id)).status).toBe('succeeded');

  await page.goto(`${t.svc.url}/p/${ID}/storyboard#token=${t.svc.token}`);
  await expect(page.getByRole('heading', { name: 'Storyboard' })).toBeVisible();
  const tab = page
    .getByRole('navigation', { name: 'Project sections' })
    .getByRole('link', { name: 'Capture' });
  await tab.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Capture', level: 1 })).toBeVisible();

  // Every generated shot is on the checklist; tick them all off with the keyboard.
  const boxes = page.getByRole('checkbox', { name: /^Recorded: / });
  const total = await boxes.count();
  expect(total).toBe(3); // the mock writes three shots; the end slate card is not recorded
  await expect(page.getByTestId('cap-progress-text')).toContainText(`0 of ${total} shots recorded`);
  for (let i = 0; i < total; i++) {
    await boxes.nth(i).focus();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('cap-progress-text')).toContainText(
      `${i + 1} of ${total} shots recorded`,
    );
  }
  // One take was bad: reject it, so it needs recording again.
  await page.getByLabel('Status of Forest run').selectOption('rejected');
  await expect(page.getByTestId('cap-progress-text')).toContainText(
    `${total - 1} of ${total} shots recorded`,
  );

  // Write the pack and read it back from disk.
  const panel = page.getByRole('region', { name: 'Share the pack' });
  await panel.getByRole('button', { name: 'Write to the project folder' }).click();
  await expect(page.getByTestId('cap-export-result')).toContainText('capture-pack.json');
  const pack = JSON.parse(
    await readFile(join(dir, 'exports', 'capture', 'capture-pack.json'), 'utf8'),
  ) as {
    progress: { total: number; done: number };
    groups: { items: { title: string; status: string; done: boolean }[] }[];
  };
  expect(pack.progress).toMatchObject({ total, done: total - 1 });
  const items = pack.groups.flatMap((g) => g.items);
  expect(items.find((i) => i.title === 'Forest run')).toMatchObject({
    status: 'rejected',
    done: false,
  });
  expect(items.filter((i) => i.status === 'recorded')).toHaveLength(total - 1);
  const md = await readFile(join(dir, 'exports', 'capture', 'capture-pack.md'), 'utf8');
  expect(md).toContain('- [ ] **Forest run**');
  expect(md).toContain('rejected, record again');
});

test('the Capture screen has no serious accessibility problems, including dialogs', async ({
  page,
}) => {
  await page.goto(`${t.svc.url}/p/${ID}/capture#token=${t.svc.token}`);
  await expect(page.getByRole('heading', { name: 'Capture', level: 1 })).toBeVisible();
  await page
    .getByRole('button', { name: /^One more take of/ })
    .first()
    .click();
  expect(await axe(page)).toEqual([]);

  await page.getByRole('button', { name: 'Write tips for every group…' }).click();
  await expect(page.getByRole('dialog').getByTestId('disclosure')).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.getByRole('dialog').getByRole('button', { name: 'Write tips' }).click();
  await expect(page.locator('.cap-tips .chip', { hasText: 'Up to date' }).first()).toBeVisible();

  const tips = page
    .locator('.cap-tips', { has: page.locator('.chip', { hasText: 'Up to date' }) })
    .first();
  await tips.getByRole('button', { name: 'Edit' }).click();
  expect(await axe(page)).toEqual([]);
});
