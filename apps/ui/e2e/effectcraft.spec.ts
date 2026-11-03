import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { buildTemplateFiles, EffectCraftCli } from '@trailerforge/effectcraft';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { startTestService, type TestService } from './support.js';

test.describe.configure({ mode: 'serial' });

const STUB = fileURLToPath(
  new URL('../../../packages/effectcraft/src/__fixtures__/stub-cli.mjs', import.meta.url),
);
const stub = { bin: process.execPath, prefixArgs: [STUB, 'ok'] };
const ID = 'proj_sample';
let t: TestService;
let clip: string;

test.beforeAll(async () => {
  // The templates are made by the stand-in CLI here; the real ones need the real EffectCraft.
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'tforge-ec-ui-'));
  await mkdir(join(dir, 'cwd'));
  await buildTemplateFiles(new EffectCraftCli(stub), join(dir, 'templates'), join(dir, 'cwd'));
  t = await startTestService({ engine: { effectcraft: stub, effectcraftTemplates: join(dir, 'templates') } }); // prettier-ignore
  const store = await t.engine.createProject(join(t.root, 'Fx.tforge'), sampleProject() as never);
  for (const sec of store.state.storyboard!.sections)
    if (sec.locked) store.dispatch('core/storyboard.set-section-locked', { sectionId: sec.id, locked: false }); // prettier-ignore
  clip = join(t.root, 'reference.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=15:d=2', '-pix_fmt', 'yuv420p', clip]); // prettier-ignore
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
const projectOf = () => (effects()[0] as unknown as { params: { project: string } }).params.project;
const project = () => [...t.engine.projects.values()].find((s) => s.state.id === ID)!;
const effects = () =>
  project().state.timelines.flatMap((tl) => tl.tracks).find((k) => k.id === 'trk_user_effects')?.items ?? []; // prettier-ignore
const undo = (page: Page) =>
  page.getByRole('group', { name: 'History' }).getByRole('button', { name: /Undo/ });

test('an EffectCraft template is in the picker and its preview says it is a stand-in', async ({
  page,
}) => {
  await page.goto(`${t.svc.url}/p/${ID}/graphics#token=${t.svc.token}`);
  await page
    .getByRole('navigation', { name: 'Cards and on-screen text' })
    .getByRole('button')
    .first()
    .click();
  const select = page.getByLabel('Template');
  await expect(select.locator('option', { hasText: 'Title reveal (EffectCraft)' })).toHaveCount(1);
  await select.selectOption('effectcraft/title-reveal');
  await expect(page.getByTestId('stand-in-note')).toContainText('stand-in');
  expect(await axe(page)).toEqual([]);
});

test('describe an effect: see what is sent, preview it, add it to the cut, undo, discard another', async ({
  page,
}) => {
  // prettier-ignore
  await page.goto(`${t.svc.url}/p/${ID}/graphics#token=${t.svc.token}`);
  await page.getByRole('button', { name: 'Describe an effect…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Describe an effect' });
  await dialog.getByLabel('What should it look like?').fill('The title EMBER snaps in with sparks');
  await dialog.getByLabel('Length (seconds)').fill('1');
  const disclosure = dialog.getByTestId('effect-disclosure');
  await expect(disclosure).toContainText('this stays on your computer');
  await expect(dialog.getByTestId('effect-sent')).toContainText('Your words: “The title EMBER snaps in with sparks”'); // prettier-ignore
  expect(await axe(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Write the effect' }).click();

  const card = page.getByRole('article', { name: 'Proposed effect Ember burst' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole('img', { name: /Preview of Ember burst/ })).toBeVisible();
  expect(effects()).toHaveLength(0);
  expect(await axe(page)).toEqual([]);

  await card.getByRole('button', { name: 'Add it to the cut' }).click();
  await expect.poll(() => effects().length).toBe(1);
  await expect(page.getByRole('article', { name: 'Effect Ember burst' })).toBeVisible();
  await undo(page).click();
  await expect.poll(() => effects().length).toBe(0);

  await page.getByRole('button', { name: 'Describe an effect…' }).click();
  await dialog.getByLabel('What should it look like?').fill('Another one');
  await dialog.getByLabel('Length (seconds)').fill('1');
  await expect(dialog.getByTestId('effect-disclosure')).toBeVisible();
  await dialog.getByRole('button', { name: 'Write the effect' }).click();
  await page.getByRole('article', { name: 'Proposed effect Ember burst' }).getByRole('button', { name: 'Discard' }).click(); // prettier-ignore
  await expect(page.getByRole('article', { name: /Proposed effect/ })).toHaveCount(0);
});

test('a reference clip: stills are shown first and sent only after you agree', async ({ page }) => {
  t.prompts.length = 0;
  await page.goto(`${t.svc.url}/p/${ID}/graphics#token=${t.svc.token}`);
  await page.getByRole('button', { name: 'Describe an effect…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Describe an effect' });
  await dialog.getByLabel('What should it look like?').fill('Like this');
  await dialog.getByLabel('Length (seconds)').fill('1');
  await dialog.getByLabel(/Match the style of a reference clip/).fill(clip);
  await expect(dialog.getByTestId('effect-sent')).toContainText(
    'Measurements of the reference clip',
  );
  await dialog.getByRole('button', { name: 'Show the 8 pictures that would be sent' }).click();
  await expect(dialog.getByRole('list', { name: 'Pictures that would be sent' }).getByRole('img')).toHaveCount(8); // prettier-ignore
  expect(await axe(page)).toEqual([]);
  await dialog.getByLabel(/Also send these 8 pictures/).check();
  await dialog.getByRole('button', { name: 'Write the effect' }).click();
  await expect(page.getByRole('article', { name: 'Proposed effect Ember burst' })).toBeVisible({ timeout: 30_000 }); // prettier-ignore
  expect(t.prompts.some((p) => p.startsWith('8 images'))).toBe(true);

  // Without ticking the box, no picture goes.
  t.prompts.length = 0;
  await page.getByRole('article', { name: 'Proposed effect Ember burst' }).getByRole('button', { name: 'Discard' }).click(); // prettier-ignore
  await expect(page.getByRole('article', { name: /Proposed effect/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Describe an effect…' }).click();
  await dialog.getByLabel('What should it look like?').fill('Like this');
  await dialog.getByLabel('Length (seconds)').fill('1');
  await dialog.getByLabel(/Match the style of a reference clip/).fill(clip);
  await dialog.getByRole('button', { name: 'Write the effect' }).click();
  await expect(page.getByRole('article', { name: 'Proposed effect Ember burst' })).toBeVisible({ timeout: 30_000 }); // prettier-ignore
  expect(t.prompts.some((p) => p.startsWith('0 images'))).toBe(true);
  await page.getByRole('article', { name: 'Proposed effect Ember burst' }).getByRole('button', { name: 'Discard' }).click(); // prettier-ignore
});

test('open an accepted effect in EffectCraft and bring the edited copy back (one undo step)', async ({
  page,
}) => {
  // prettier-ignore
  await page.goto(`${t.svc.url}/p/${ID}/graphics#token=${t.svc.token}`);
  await page.getByRole('button', { name: 'Describe an effect…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Describe an effect' });
  await dialog.getByLabel('What should it look like?').fill('To polish');
  await dialog.getByLabel('Length (seconds)').fill('1');
  await expect(dialog.getByTestId('effect-disclosure')).toBeVisible();
  await dialog.getByRole('button', { name: 'Write the effect' }).click();
  const card = page.getByRole('article', { name: 'Proposed effect Ember burst' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByLabel(/Start at/).fill('0');
  await card.getByRole('button', { name: 'Add it to the cut' }).click();
  const item = page.getByRole('article', { name: 'Effect Ember burst' });
  await expect(item).toBeVisible();
  const before = projectOf();

  await item.getByRole('button', { name: 'Save a copy to edit in EffectCraft' }).click();
  const saved = item.getByTestId('effect-saved');
  await expect(saved).toContainText('exports/effectcraft');
  const name = (await saved.locator('code').first().textContent())!;
  const path = join(project().paths.exports, 'effectcraft', name);
  const edited = join(t.root, 'edited.ecproj');
  writeFileSync(edited, readFileSync(path, 'utf8').replace(/\}$/, ', "polished": true}'));
  await item.getByLabel('Edited copy').fill(edited);
  await item.getByRole('button', { name: 'Use the edited copy' }).click();
  await expect.poll(() => projectOf()).not.toBe(before);
  await undo(page).click();
  await expect.poll(() => projectOf()).toBe(before);
  expect(await axe(page)).toEqual([]);
});
