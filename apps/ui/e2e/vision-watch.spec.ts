import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { startTestService, type TestService } from './support.js';

let t: TestService;
let rec: string;
let obs: string;
const ID = 'proj_sample';
const fetched: string[] = [];
const modelFile = Buffer.from('m'.repeat(3_000_000)); // shown as "3 MB"

const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const clip = (path: string, title: string) =>
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=320x180:r=30:d=4',
    '-metadata',
    `title=${title}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    path,
  ]);

test.beforeAll(async () => {
  t = await startTestService({
    engine: {
      watchIntervalMs: 100,
      visionModel: {
        id: 'e2e-clip',
        title: 'Test CLIP',
        license: 'MIT',
        source: 'example/test-clip@abc',
        files: [
          {
            name: 'model.onnx',
            url: 'https://models.example.org/model.onnx',
            bytes: modelFile.length,
            sha256: createHash('sha256').update(modelFile).digest('hex'),
          },
        ],
      },
      egressFetch: (async (url: string) => {
        fetched.push(url);
        return new Response(new Uint8Array(modelFile));
      }) as unknown as typeof fetch,
    },
  });
  await t.engine.createProject(join(t.root, 'VW.tforge'), sampleProject() as never);
  rec = join(t.root, 'recordings');
  obs = join(t.root, 'obs');
  mkdirSync(rec);
  mkdirSync(obs);
  clip(join(rec, 'take-thumb.mp4'), 'thumb');
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

test('AI vision: the dialog says what it does, nothing downloads until yes, then it is on', async ({
  page,
}) => {
  await page.goto(`${t.svc.url}/p/${ID}/footage#token=${t.svc.token}`);
  const panel = page.getByTestId('vision-panel');
  await expect(panel).toContainText('AI vision (optional)');
  await panel.getByRole('button', { name: 'Turn on AI vision…' }).click();

  const dialog = page.getByRole('dialog', { name: 'Turn on AI vision?' });
  await expect(dialog).toContainText('3 MB');
  await expect(dialog).toContainText('models.example.org');
  await expect(dialog).toContainText('MIT');
  await expect(dialog).toContainText('Nothing about you or your project');
  await expect(dialog).toContainText('footage and frames never leave it');
  expect(await axe(page)).toEqual([]);

  await dialog.getByRole('button', { name: 'Not now' }).click();
  await expect(dialog).toBeHidden();
  expect(fetched).toEqual([]); // declining downloads nothing

  await panel.getByRole('button', { name: 'Turn on AI vision…' }).click();
  await page.getByRole('button', { name: 'Download 3 MB' }).click();
  await expect(panel.getByText('On', { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(fetched).toEqual(['https://models.example.org/model.onnx']);
  await expect(panel.getByRole('button', { name: 'Turn on AI vision…' })).toHaveCount(0);
  expect(await axe(page)).toEqual([]);

  // It is app-wide: Settings shows it already on.
  await page.goto(`${t.svc.url}/settings#token=${t.svc.token}`);
  await expect(page.getByTestId('vision-panel').getByText('On', { exact: true })).toBeVisible();
});

test('watched folder: set it in Settings, a new recording arrives by itself, stop watching', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(`${t.svc.url}/settings#token=${t.svc.token}`);
  const panel = page.getByTestId('watched-panel');
  await expect(panel).toContainText('No folders are watched');

  await panel.getByLabel('Folder to watch').fill(join(t.root, 'does-not-exist'));
  await panel.getByRole('button', { name: 'Watch this folder' }).click();
  await expect(page.getByText(/no such folder/i)).toBeVisible();

  await panel.getByLabel('Folder to watch').fill(obs);
  await panel.getByRole('button', { name: 'Watch this folder' }).click();
  const list = page.getByRole('list', { name: 'Watched folders' });
  await expect(list).toContainText(obs);
  expect(await axe(page)).toEqual([]);

  // The first look at a new folder only notes what is there; wait for it, then record.
  await page.waitForTimeout(600);
  clip(join(obs, 'obs-new-take.mp4'), 'obs');
  await page.goto(`${t.svc.url}/p/${ID}/footage#token=${t.svc.token}`);
  await expect(page.getByRole('list', { name: 'Recordings' })).toContainText('obs-new-take', {
    timeout: 60_000,
  });

  await page.goto(`${t.svc.url}/settings#token=${t.svc.token}`);
  await page.getByRole('button', { name: `Stop watching ${obs}` }).click();
  await expect(panel).toContainText('No folders are watched');
});

test('previews on the Footage tab, and the same takes in the Capture tab', async ({ page }) => {
  await page.goto(`${t.svc.url}/p/${ID}/footage#token=${t.svc.token}`);
  await page.getByLabel('Folders or files (one per line)').fill(join(rec, 'take-thumb.mp4'));
  await page.getByRole('button', { name: 'Add recordings' }).click();
  const row = page.locator('.foot-rec', { hasText: 'take-thumb' });
  await expect(row).toBeVisible({ timeout: 60_000 });
  const thumb = row.getByRole('img', { name: 'Preview of take-thumb.mp4' });
  await expect(thumb).toBeVisible({ timeout: 60_000 });
  expect(await thumb.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  await row.getByText('Frames across the recording').click();
  const strip = row.getByRole('img', { name: 'Frames across take-thumb.mp4' });
  await expect(strip).toBeVisible();
  expect(await strip.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);

  // Attach it to a shot by hand, then see and manage it from the Capture tab.
  const sugg = page.getByRole('list', { name: 'Suggestions' });
  const item = sugg.locator(':scope > li').filter({ hasText: 'take-thumb' });
  await item.getByLabel(/^Shot for /).selectOption('shot_parry');
  await item.getByRole('button', { name: /^Attach / }).click();
  await expect(
    page.getByRole('list', { name: 'Takes' }).locator('[data-slot="shot_parry"]'),
  ).toContainText('take-thumb');

  await page
    .getByRole('navigation', { name: 'Project sections' })
    .getByRole('link', { name: 'Capture' })
    .click();
  const shot = page.locator('li.cap-item[data-slot="shot_parry"]');
  const takes = shot.getByRole('list', { name: 'Recordings for Perfect parry' });
  await expect(takes).toContainText('take-thumb');
  await expect(takes.getByRole('img', { name: 'Preview of take-thumb.mp4' })).toBeVisible({
    timeout: 30_000,
  });
  await takes.getByRole('button', { name: 'Use take-thumb.mp4 for Perfect parry' }).click();
  await expect(takes).toContainText('used in the cut');
  expect(await axe(page)).toEqual([]);
  await takes.getByRole('button', { name: 'Reject take-thumb.mp4 for Perfect parry' }).click();
  await expect(takes.locator('li.rejected')).toHaveCount(1);

  // Both were commands, so undo walks them back (reject, choose, attach).
  await page.goto(`${t.svc.url}/p/${ID}#token=${t.svc.token}`);
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  for (let i = 0; i < 3; i++) {
    await expect(undo).toBeEnabled();
    await undo.click();
  }
  await expect(undo).toBeDisabled();
  await page
    .getByRole('navigation', { name: 'Project sections' })
    .getByRole('link', { name: 'Capture' })
    .click();
  await expect(shot.getByRole('list', { name: 'Recordings for Perfect parry' })).toHaveCount(0);
});
