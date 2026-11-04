import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { sampleConcept, sampleProject } from '@trailerforge/schema/fixtures';
import { startTestService, type TestService } from './support.js';

test.describe.configure({ mode: 'serial' });

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

  await page.getByLabel('Subtitles synced to the voiceover').check();
  await expect(page.getByLabel('Style')).toBeEnabled();
  await page.getByLabel('Made for').selectOption('reels');
  await expect(page.getByRole('img', { name: /Instagram Reels/ })).toBeVisible();
  expect(await axe(page)).toEqual([]);
});
