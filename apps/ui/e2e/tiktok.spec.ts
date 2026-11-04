import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { sampleConcept, sampleProject } from '@trailerforge/schema/fixtures';
import { startTestService, type TestService } from './support.js';

test.describe.configure({ mode: 'serial' });
// A fake microphone, granted without asking (the desktop app grants it to its own window only).
test.use({
  launchOptions: {
    ...(process.env.TFORGE_CHROMIUM ? { executablePath: process.env.TFORGE_CHROMIUM } : {}),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
  permissions: ['microphone'],
});

let t: TestService;
let dir: string;
const ID = 'proj_sample';

test.beforeAll(async () => {
  t = await startTestService();
  const store = await t.engine.createProject(
    join(t.root, 'Tiktok.tforge'),
    sampleProject() as never,
  );
  store.dispatch('core/concepts.add', { concepts: [sampleConcept()] });
  dir = join(t.root, 'files');
  mkdirSync(dir);
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'gradients=s=320x180:r=30:d=3:c0=orange:c1=blue',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    join(dir, 'clip.mp4'),
  ]);
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

test('tiktok: pick a concept, fill a shot, set subtitles, undo', async ({ page }) => {
  await page.goto(`${t.svc.url}/p/${ID}/tiktok#token=${t.svc.token}`);
  await expect(page.getByRole('heading', { name: 'TikTok', level: 1 })).toBeVisible();
  await expect(page.getByText('Parry or die')).toBeVisible();
  expect(await axe(page)).toEqual([]);

  // A series: start one, see its card, the AI dialog shows what it sends, remove it.
  await page.getByLabel('Series name').fill('Boss in 20 seconds');
  await page.getByLabel('What every episode is about').fill('One boss, one tell.');
  await page.getByRole('button', { name: 'Start the series' }).click();
  const seriesCard = page.getByRole('group', { name: 'Series Boss in 20 seconds' });
  await expect(seriesCard).toContainText('No episodes yet.');
  await seriesCard.getByRole('button', { name: 'Suggest episodes' }).click();
  await expect(page.getByRole('dialog')).toContainText('the series name and premise', { timeout: 15_000 }); // prettier-ignore
  await page.keyboard.press('Escape');
  await expect(seriesCard.getByRole('button', { name: 'Export all episodes' })).toBeDisabled();
  await seriesCard.getByRole('button', { name: 'Remove series Boss in 20 seconds' }).click();
  await expect(page.getByRole('group', { name: /^Series / })).toHaveCount(0);

  // The Claude Code dialog shows what would be shared before anything is.
  await page.getByRole('button', { name: 'Ask Claude Code…' }).click();
  await expect(page.getByRole('dialog')).toContainText('read-only', { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Run Claude Code' })).toBeDisabled();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Make this TikTok' }).click();
  await expect(page.getByRole('heading', { name: /Parry or die/, level: 2 })).toBeVisible();
  await expect(page.getByText('Not recorded.').first()).toBeVisible();
  const first = page.locator('.tt-slots > li').first();
  await first.getByLabel(/^Path to/).fill(join(dir, 'clip.mp4'));
  await first.getByRole('button', { name: 'Use this file' }).click();
  await expect(first).toContainText('clip.mp4', { timeout: 30_000 });
  await expect(page.getByRole('status').filter({ hasText: 'shots filled' })).toContainText('1 of');

  // Post text and cover: saved as you leave each field, hashtags tidied.
  await page.getByLabel(/^Caption/).fill('One perfect parry.');
  await page.getByLabel(/^Caption/).blur();
  await expect(page.getByText('Caption (18 of 2200 characters)')).toBeVisible();
  await page.getByLabel(/^Hashtags/).fill('#EmberKnight, indiedev');
  await page.getByLabel(/^Hashtags/).blur();
  await expect(page.getByLabel(/^Hashtags/)).toHaveValue('#EmberKnight #indiedev');
  await page.getByLabel('Cover title').fill('Parry or die');
  await page.getByLabel('Cover title').blur();
  await page.getByLabel(/^Cover frame at/).fill('1.5');
  await page.getByLabel(/^Cover frame at/).blur();
  await expect(page.getByLabel(/^Cover frame at/)).toHaveValue('1.5');
  await page.getByRole('button', { name: 'Write it with the AI' }).click();
  await expect(page.getByRole('dialog')).toContainText('Never recordings or game files', { timeout: 15_000 }); // prettier-ignore
  await page.keyboard.press('Escape');

  // Hook versions: add one, give it words, see its own version id, remove it.
  await page.getByRole('button', { name: 'Add a hook version' }).click();
  const hook = page.locator('li.card').filter({ hasText: '_hk_a' });
  await expect(hook).toBeVisible();
  await hook.getByLabel(/Words over the opening/).fill('Can you parry this?');
  await hook.getByLabel(/Words over the opening/).blur();
  await expect(hook.getByLabel(/Words over the opening/)).toHaveValue('Can you parry this?');
  await page.getByRole('button', { name: 'Suggest hook versions' }).click();
  await expect(page.getByRole('dialog')).toContainText('Never recordings or game files', { timeout: 15_000 }); // prettier-ignore
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Remove hook version Hook A' }).click();
  await expect(page.getByRole('button', { name: 'Remove hook version Hook A' })).toHaveCount(0);

  // Music: export without it, and the tap button asks for more taps.
  await page.getByRole('combobox', { name: /^Export/ }).selectOption('without');
  await expect(page.getByRole('combobox', { name: /^Export/ })).toHaveValue('without');
  await page.getByRole('button', { name: 'Tap the beat' }).click();
  await expect(page.getByText('1 tap…')).toBeVisible();
  await page.getByRole('button', { name: 'Start over' }).click();

  await page.getByLabel('Subtitles synced to the voiceover').check();
  await expect(page.getByLabel('Style')).toBeEnabled();
  await page.getByLabel('Made for').selectOption('reels');
  await expect(page.getByRole('img', { name: /Instagram Reels/ })).toBeVisible();
  expect(await axe(page)).toEqual([]);
});

test('tiktok: record the voiceover in the app, line by line', async ({ page }) => {
  await page.goto(`${t.svc.url}/p/${ID}/tiktok#token=${t.svc.token}`);
  await expect(page.getByText('0 of 2 voiceover lines recorded')).toBeVisible();
  await page.getByRole('button', { name: 'Record the script in the app' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('This boss has one tell.');
  await expect(dialog).toContainText('Line 1 of 2');
  expect(await axe(page)).toEqual([]);

  await dialog.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Recording…');
  await page.waitForTimeout(1200);
  await dialog.getByRole('button', { name: 'Stop' }).click();
  // The take is converted and added; the next line comes up.
  await expect(dialog).toContainText('Line 2 of 2', { timeout: 30_000 });
  await expect(dialog).toContainText('Miss it and you are done.');
  await dialog.getByRole('button', { name: 'Previous line' }).click();
  await expect(dialog.getByRole('status')).toContainText('1 take so far.');
  await expect(dialog.getByRole('button', { name: 'Record again' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('1 of 2 voiceover lines recorded')).toBeVisible();

  // Voice clean-up is on by default; the levels are measured on request.
  await expect(page.getByLabel(/Clean up the voice/)).toBeChecked();
  await page.getByRole('button', { name: 'Show voice levels' }).click();
  await expect(page.getByRole('list', { name: 'Voice levels' })).toContainText(/LUFS after clean-up/, { timeout: 30_000 }); // prettier-ignore
  await page.getByLabel(/Clean up the voice/).uncheck();
  await expect(page.getByLabel(/Clean up the voice/)).not.toBeChecked();
  expect(await axe(page)).toEqual([]);
});
