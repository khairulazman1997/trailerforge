import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { startTestService, type TestService } from './support.js';

/**
 * The whole app, as a newcomer would use it, without the terminal: "Try a demo" on the Projects
 * page, look at the storyboard and the footage, move a clip on the Cut timeline with the keyboard,
 * render a review draft, comment and approve, export the vertical version and write editor files.
 * Nothing is sent anywhere: the network log stays empty.
 */

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

const tab = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name, exact: true }); // prettier-ignore

test('from "Try a demo" to an exported trailer and editor files, all in the app', async ({
  page,
}) => {
  test.setTimeout(600_000);

  // 1. Projects → Try a demo → the project opens.
  await page.goto(`${t.svc.url}/#token=${t.svc.token}`);
  await page.getByRole('region', { name: 'New here?' }).getByRole('button', { name: 'Try a demo' }).click(); // prettier-ignore
  await expect(page.getByRole('heading', { name: 'Demo: Ember Knight', level: 1 })).toBeVisible({
    timeout: 180_000,
  });
  const projectId = decodeURIComponent(new URL(page.url()).pathname.split('/')[2]!);

  // 2. Storyboard and Footage: written and matched.
  await tab(page, 'Storyboard').click();
  await expect(page.getByRole('region', { name: 'Hook', exact: true })).toBeVisible();
  await tab(page, 'Footage').click();
  await expect(page.getByText(/opening-parry TF-/).first()).toBeVisible();

  // 3. Cut: select the second clip and nudge it a frame to the right with the keyboard (Alt: the
  //    clips after it move along, so nothing overlaps), then back with Undo (the edit and its undo are both real commands).
  await tab(page, 'Cut').click();
  const picture = page.getByRole('group', { name: /track$/ }).first();
  const clip = picture.getByRole('button', { name: /, clip,/ }).nth(1);
  const label0 = await clip.getAttribute('aria-label');
  await clip.click();
  await clip.focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(clip).not.toHaveAttribute('aria-label', label0!);
  await page.getByRole('banner').getByRole('button', { name: /Undo/ }).click();
  await expect(clip).toHaveAttribute('aria-label', label0!);
  expect(await axe(page)).toEqual([]);

  // 4. Review the vertical version: gate clear, a draft, a comment, an approval.
  await tab(page, 'Review').click();
  await page
    .getByRole('list', { name: 'Versions' })
    .getByRole('button', { name: /TikTok/ })
    .click();
  const review = page.getByRole('region', { name: /^Review of TikTok/ });
  await expect(review.getByTestId('gate-verdict')).toContainText('May be exported', {
    timeout: 60_000,
  });
  await review.getByRole('button', { name: 'Render a review draft' }).click();
  await expect(review.getByTestId('draft-player')).toBeVisible({ timeout: 180_000 });
  await review.getByLabel('At (seconds)').fill('2');
  await review.getByLabel('Comment', { exact: true }).fill('Love the parry');
  await review.getByRole('button', { name: 'Add comment' }).click();
  await expect(review.getByRole('list', { name: 'Comments' })).toContainText('Love the parry');
  await review.getByRole('button', { name: 'Approve this version' }).click();
  await expect(review.getByTestId('approval-state')).toHaveText('Approved');
  expect(await axe(page)).toEqual([]);

  // 5. Export it with its default preset (vertical), then write editor files.
  await tab(page, 'Export').click();
  const card = page.getByRole('region', { name: /^Export of TikTok/ });
  await expect(card).toContainText('.mp4');
  await card.getByRole('button', { name: 'Export', exact: true }).click();
  const result = card.getByTestId('export-result');
  await expect(result).toContainText('Exported.', { timeout: 300_000 });
  const file = (await result.locator('code').first().textContent())!;
  expect(file).toMatch(/exports[\\/]render[\\/].*\.mp4$/);
  expect(existsSync(file)).toBe(true);
  const record = JSON.parse(readFileSync(file.replace(/\.mp4$/, '.export.json'), 'utf8')) as {
    preset: string;
  };
  expect(record.preset).toBe('core/vertical');

  await card.getByRole('button', { name: 'Write editor files' }).click();
  const out = card.getByTestId('handoff-result');
  await expect(out).toContainText('OTIO:', { timeout: 180_000 });
  for (const p of await out.locator('code').allTextContents()) expect(existsSync(p), p).toBe(true);
  expect(await axe(page)).toEqual([]);

  // 6. The approval still holds (exporting reads the project and never changes it), and nothing
  //    went over the network.
  await tab(page, 'Review').click();
  await page
    .getByRole('list', { name: 'Versions' })
    .getByRole('button', { name: /TikTok/ })
    .click();
  await expect(page.getByTestId('approval-state')).toHaveText('Approved');
  const log = join(t.engine.home, 'logs', 'egress.jsonl');
  expect(existsSync(log) ? readFileSync(log, 'utf8').trim() : '').toBe('');
  expect(projectId).toBeTruthy();
});
