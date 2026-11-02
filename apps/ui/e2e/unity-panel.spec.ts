import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { startTestService, type TestService } from './support.js';

let t: TestService;
const ID = 'proj_sample';

test.beforeAll(async () => {
  t = await startTestService();
  await t.engine.createProject(join(t.root, 'Unity.tforge'), sampleProject() as never);
});
test.afterAll(async () => {
  await t.close();
});

test('Record in Unity: the pack path, watching the recordings folder, axe clean', async ({
  page,
}) => {
  const out = join(t.root, 'unity-takes');
  await mkdir(out);
  await page.goto(`${t.svc.url}/p/${ID}/capture#token=${t.svc.token}`);
  const panel = page.getByTestId('unity-panel');
  await expect(panel.getByRole('heading', { name: 'Record in Unity' })).toBeVisible();
  await expect(page.getByTestId('unity-pack-path')).toContainText(
    /exports[\\/]capture[\\/]capture-pack\.json$/,
  );

  await panel.getByLabel('Unity recordings folder').fill(out);
  await panel.getByRole('button', { name: 'Watch this folder' }).click();
  await expect(panel).toContainText('Watched now');
  await expect(panel).toContainText(out);

  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);

  // stop watching again so the other specs of this service start clean
  await page.goto(`${t.svc.url}/settings#token=${t.svc.token}`);
  await page.getByRole('button', { name: `Stop watching ${out}` }).click();
  await expect(page.getByTestId('watched-panel')).toContainText('No folders are watched');
});
