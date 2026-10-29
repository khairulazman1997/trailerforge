import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { startTestService, type TestService } from './support.js';

/** "Try a demo": one click from the Projects page to a project with something on every tab. */

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

test('one click builds the demo and opens it; the tabs have content and the gate is clear', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto(`${t.svc.url}/#token=${t.svc.token}`);
  const offer = page.getByRole('region', { name: 'New here?' });
  await expect(offer).toContainText('nothing is downloaded or sent anywhere');
  expect(await axe(page)).toEqual([]);
  await offer.getByRole('button', { name: 'Try a demo' }).click();
  await expect(offer.getByRole('button', { name: 'Building the demo…' })).toBeDisabled();

  // It opens on the new project.
  await expect(page.getByRole('heading', { name: 'Demo: Ember Knight', level: 1 })).toBeVisible({
    timeout: 180_000,
  });
  const base = new URL(page.url()).pathname;

  await page.goto(`${t.svc.url}${base}/storyboard`);
  for (const name of ['Hook', 'Escalation', 'Climax', 'End slate'])
    await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /Boss reveal/ }).first()).toBeVisible();

  await page.goto(`${t.svc.url}${base}/footage`);
  await expect(page.getByText(/opening-parry TF-/).first()).toBeVisible();

  await page.goto(`${t.svc.url}${base}/cut`);
  const picture = page.getByRole('group', { name: /track$/ }).first();
  await expect(picture.getByRole('button', { name: /^Opening parry, clip,/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /placeholder,/ })).toHaveCount(0);
  expect(await axe(page)).toEqual([]);

  await page.goto(`${t.svc.url}${base}/variants`);
  const versions = page.getByRole('region', { name: 'Versions', exact: true });
  await expect(versions.getByRole('heading', { name: 'YouTube 16:9' })).toBeVisible();
  await expect(versions.getByRole('heading', { name: 'TikTok 9:16' })).toBeVisible();

  await page.goto(`${t.svc.url}${base}/review`);
  await expect(page.getByTestId('gate-verdict')).toContainText('May be exported', {
    timeout: 60_000,
  });
  await page.getByTestId('version-var_tt').or(page.getByRole('button', { name: /TikTok/ }).first()).first().click(); // prettier-ignore
  await expect(page.getByTestId('gate-verdict')).toContainText('May be exported', {
    timeout: 60_000,
  });
});
