import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { shotCodes } from '@trailerforge/pack-game-trailer';
import { Project } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { startTestService, type TestService } from './support.js';

let t: TestService;
let rec: string;
const ID = 'proj_sample';

const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

test.beforeAll(async () => {
  t = await startTestService();
  await t.engine.createProject(join(t.root, 'Footage.tforge'), sampleProject() as never);
  rec = join(t.root, 'recordings');
  mkdirSync(rec);
  const code = shotCodes(Project.parse(sampleProject())).get('shot_parry')!;
  const clip = (name: string, title: string, extra: string[] = []) =>
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x180:r=30:d=5',
      '-metadata',
      `title=${title}`,
      ...extra,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      join(rec, name),
    ]);
  clip(`${code} take1.mp4`, 'one'); // matches shot_parry by its code
  clip('2026-10-24 14-03-22.mp4', 'two'); // no code: only a suggestion
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

test('add recordings, review the suggestions, attach, choose a take, and undo', async ({
  page,
}) => {
  await page.goto(`${t.svc.url}/p/${ID}/footage#token=${t.svc.token}`);
  await expect(page.getByRole('heading', { name: 'Footage', level: 1 })).toBeVisible();
  await expect(page.getByTestId('foot-progress')).toContainText('No recordings yet');

  // Paste where they are (a browser cannot see dropped files' locations; the desktop app can).
  await page.getByLabel('Folders or files (one per line)').fill(rec);
  await page.getByRole('button', { name: 'Add recordings' }).click();
  const list = page.getByRole('list', { name: 'Recordings' });
  await expect(list.locator(':scope > li')).toHaveCount(2, { timeout: 60_000 });
  await expect(list).toContainText('Low resolution'); // the test clips are 320×180
  await expect(page.getByTestId('foot-progress')).toContainText('nothing running', {
    timeout: 60_000,
  });

  // The coded file matches by itself; the other is a suggestion to confirm.
  const sugg = page.getByRole('list', { name: 'Suggestions' });
  await expect(sugg.locator(':scope > li')).toHaveCount(2);
  await expect(sugg).toContainText('Shot code');
  await sugg.locator(':scope > li').filter({ hasText: 'take1' }).locator('details summary').click();
  await expect(sugg).toContainText('The file name has shot code');

  await expect(page.getByRole('button', { name: 'Attach the 2 confident' })).toBeEnabled();

  // Attach the coded file as suggested, and the other one to a shot chosen by hand.
  const takes = page.getByRole('list', { name: 'Takes' });
  await page.getByRole('button', { name: /^Attach .*take1/ }).click();
  await expect(takes.locator('[data-slot="shot_parry"]')).toContainText('take1');
  const other = sugg.locator(':scope > li').filter({ hasText: '14-03-22' });
  await other.getByLabel(/^Shot for /).selectOption('shot_parry');
  await other.getByRole('button', { name: /^Attach / }).click();
  await expect(takes.locator('[data-slot="shot_parry"] li')).toHaveCount(2);
  await page.getByRole('button', { name: /^Use .*14-03-22.* for Perfect parry$/ }).click();
  await expect(takes.locator('[data-slot="shot_parry"]')).toContainText('used in the cut');
  await page.getByRole('button', { name: /^Reject .*take1/ }).click();
  await expect(takes.locator('li.rejected')).toHaveCount(1);

  expect(await axe(page)).toEqual([]);

  // Everything above was a command: undo walks it back (reject, choose, attach, attach).
  await page.goto(`${t.svc.url}/p/${ID}#token=${t.svc.token}`);
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  for (let i = 0; i < 4; i++) {
    await expect(undo).toBeEnabled();
    await undo.click();
  }
  await expect(undo).toBeDisabled(); // exactly those four changes were made
  await page
    .getByRole('navigation', { name: 'Project sections' })
    .getByRole('link', { name: 'Footage' })
    .click();
  await expect(page.getByRole('list', { name: 'Takes' })).toHaveCount(0);
});

test('a path with no recordings says so; a project without a storyboard explains itself', async ({
  page,
}) => {
  await t.engine.createProject(join(t.root, 'Bare.tforge'), {
    name: 'Bare',
    id: 'proj_bare',
  } as never);
  await page.goto(`${t.svc.url}/p/proj_bare/footage#token=${t.svc.token}`);
  await expect(page.getByText('has no storyboard yet')).toBeVisible();
  await page.getByLabel('Folders or files (one per line)').fill(join(t.root, 'nothing-here'));
  await page.getByRole('button', { name: 'Add recordings' }).click();
  await expect(page.getByText('No recordings found there')).toBeVisible();
});
