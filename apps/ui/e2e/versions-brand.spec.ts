import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { importFootageOp } from '@trailerforge/engine';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { startTestService, type TestService } from './support.js';

test.describe.configure({ mode: 'serial' });

let t: TestService;
let dir: string;
const ID = 'proj_sample';

test.beforeAll(async () => {
  t = await startTestService();
  const store = await t.engine.createProject(
    join(t.root, 'Versions.tforge'),
    sampleProject() as never,
  );
  dir = join(t.root, 'files');
  mkdirSync(dir);
  // A recording for the focus editor: imported on the server and attached to the parry shot.
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=320x180:r=30:d=4',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    join(dir, 'parry.mp4'),
  ]);
  await importFootageOp(t.engine, store, { paths: [join(dir, 'parry.mp4')] });
  for (
    let i = 0;
    i < 600 && t.engine.jobs.list().some((j) => ['queued', 'running'].includes(j.status));
    i++
  )
    await new Promise((r) => setTimeout(r, 100));
  const asset = t.engine.library.list().find((a) => a.originalName === 'parry.mp4')!;
  store.dispatch('core/takes.attach', {
    slotId: 'shot_parry',
    assetId: asset.id,
    matchedBy: 'manual',
  });
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

test('versions: add the missing ones, set a length, drop a shot, set a focus point, and undo', async ({
  page,
}) => {
  await page.goto(`${t.svc.url}/p/${ID}/variants#token=${t.svc.token}`);
  await expect(page.getByRole('heading', { name: 'Versions', level: 1 })).toBeVisible();
  const list = page.getByRole('list', { name: '' }).filter({ has: page.locator('.ver-card') });
  const cards = page.locator('.ver-card');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('TikTok 9:16');
  await expect(cards.first()).toContainText('9:16, 1080×1920, 30 fps');
  await expect(cards.first().getByRole('status')).toContainText('7.5 s of 7.5 s');
  void list;

  // One version per format target, at the master's length.
  await page.getByRole('button', { name: /^Add it at the master's length$/ }).click();
  await expect(cards).toHaveCount(2);
  await expect(page.getByRole('button', { name: /at the master's length$/ })).toHaveCount(0);

  // A 5 s cutdown of the TikTok version: the hook and the end card stay, the rest is dropped or shortened.
  const tt = cards.filter({ hasText: 'TikTok 9:16' });
  await tt.getByLabel('Length in seconds').fill('5');
  await tt.getByLabel('Length in seconds').blur();
  await expect(tt.getByRole('status')).toContainText('of 5 s', { timeout: 15_000 });
  const rows = tt.locator('tbody tr');
  await expect(rows.filter({ hasText: 'Perfect parry' })).not.toContainText('Dropped');

  // Keep and drop by hand.
  const boss = rows.filter({ has: page.getByLabel('Your choice for Boss reveal') });
  await boss.getByLabel('Your choice for Boss reveal').selectOption('drop');
  await expect(boss).toContainText('Dropped');
  await expect(boss).toContainText('dropped by hand in this version');

  // The focus point of the parry shot, on a frame of its recording.
  const parry = rows.filter({ has: page.getByLabel('Your choice for Perfect parry') });
  await expect(parry).toContainText('not analysed yet: centred');
  await parry.getByRole('button', { name: 'Focus' }).click();
  await expect(parry.locator('.focus-crop')).toBeVisible();
  await expect(parry.locator('img.thumb')).toBeVisible({ timeout: 30_000 });
  await parry.getByLabel(/^Across/).fill('80');
  await expect(parry).toContainText('Focus point set by you');
  await expect(parry.getByLabel(/^Across/)).toHaveValue('80');
  await parry.getByRole('button', { name: 'Automatic' }).click();
  await expect(parry).not.toContainText('Focus point set by you');

  expect(await axe(page)).toEqual([]);

  // Remove the new version, then undo walks the edits back one at a time.
  await cards.filter({ hasText: 'YouTube 16:9' }).getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).last().click();
  await expect(cards).toHaveCount(1);
  const undo = page.getByRole('group', { name: 'History' }).getByRole('button', { name: /Undo/ });
  await undo.click(); // the removal comes back
  await expect(cards).toHaveCount(2);
});

test('brand: colours with their contrast, a logo, a font, sizes, and refused files', async ({
  page,
}) => {
  await page.goto(`${t.svc.url}/p/${ID}/brand#token=${t.svc.token}`);
  await expect(page.getByRole('heading', { name: 'Brand', level: 1 })).toBeVisible();
  const contrast = page.getByRole('table');
  await expect(contrast.locator('.chip.ok')).toHaveCount(3);

  // Low contrast is named, with the number, as text (not only by colour).
  await page.getByLabel('Text as hex').fill('#999999');
  await page.getByLabel('Text as hex').blur();
  await page.getByLabel('Background as hex').fill('#aaa');
  await page.getByLabel('Background as hex').blur();
  await expect(contrast.getByRole('row', { name: /Text on background/ })).toContainText('Too low');
  await expect(page.getByRole('status', { name: 'Problems with the brand kit' })).toContainText(
    'contrast',
  );
  await page.getByLabel('Background as hex').fill('#0b0d12');
  await page.getByLabel('Background as hex').blur();
  await page.getByLabel('Text as hex').fill('#f5f6f8');
  await page.getByLabel('Text as hex').blur();
  await expect(contrast.locator('.chip.ok')).toHaveCount(3);

  // A logo by path: copied into the project; a scripted SVG is refused with the reason.
  writeFileSync(
    join(dir, 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>',
  );
  writeFileSync(join(dir, 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
  await page.getByLabel('Logo file (SVG or PNG)').fill(join(dir, 'evil.svg'));
  await page.getByRole('button', { name: 'Use this file' }).first().click();
  await expect(page.getByText(/contains a script/)).toBeVisible();
  await page.getByLabel('Logo file (SVG or PNG)').fill(join(dir, 'logo.svg'));
  await page.getByRole('button', { name: 'Use this file' }).first().click();
  await expect(page.getByText('Using logo.svg.')).toBeVisible();

  // A heading font: the family is read from the file.
  copyFileSync(
    join(process.cwd(), '..', '..', 'assets', 'fonts', 'inter', 'Inter-Bold.otf'),
    join(dir, 'Inter-Bold.otf'),
  );
  await page.getByLabel('Heading font file (TTF or OTF)').fill(join(dir, 'Inter-Bold.otf'));
  await page.getByRole('button', { name: 'Use this file' }).nth(1).click();
  await expect(page.getByRole('button', { name: 'Go back to the shipped font' })).toBeVisible();
  await expect(page.getByText('Inter Bold').first()).toBeVisible();

  // Text sizes as percentages; an invalid one goes back.
  await page.getByLabel('Title (%)').fill('15');
  await page.getByLabel('Title (%)').blur();
  await page.reload();
  await expect(page.getByLabel('Title (%)')).toHaveValue('15');
  await page.getByLabel('Title (%)').fill('99');
  await page.getByLabel('Title (%)').blur();
  await expect(page.getByLabel('Title (%)')).toHaveValue('15');

  expect(await axe(page)).toEqual([]);

  await page.getByRole('button', { name: 'Remove the logo' }).click();
  await expect(page.getByText(/No logo yet/)).toBeVisible();
  await page.getByRole('button', { name: 'Clear the brand kit' }).click();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.getByLabel('Title (%)')).toHaveValue('12');
});
