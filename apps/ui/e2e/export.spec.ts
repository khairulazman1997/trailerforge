import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  analyzeOp,
  createDefaultVariantsOp,
  generateCutOp,
  importFootageOp,
  matchAcceptOp,
} from '@trailerforge/engine';
import { shotCodes } from '@trailerforge/pack-game-trailer';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { startTestService, type TestService } from './support.js';

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

let t: TestService;
let dir: string;
const ID = 'proj_sample';
const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

async function idle() {
  for (let i = 0; i < 900; i++) {
    if (t.engine.jobs.list().every((j) => j.status !== 'queued' && j.status !== 'running')) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('jobs did not finish');
}

test.beforeAll(async () => {
  t = await startTestService();
  dir = join(t.root, 'Export.tforge');
  const store = await t.engine.createProject(dir, sampleProject() as never);
  const codes = shotCodes(store.state);
  const rec = (name: string, src: string) =>
    ff(['-f', 'lavfi', '-i', `${src}=s=320x180:r=30:d=6`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(t.root, name)]); // prettier-ignore
  rec(`parry ${codes.get('shot_parry')}.mp4`, 'testsrc2');
  rec(`boss ${codes.get('shot_boss')}.mp4`, 'smptebars');
  ff(['-f', 'lavfi', '-i', "aevalsrc='0.35*sin(2*PI*220*t)+if(lt(mod(t-0.25\\,0.5)\\,0.01)*gte(t\\,0.25)\\,0.6*sin(2*PI*2000*t)\\,0)':s=44100:d=20", join(t.root, 'song.wav')]); // prettier-ignore
  await importFootageOp(t.engine, store, {
    paths: [join(t.root, `parry ${codes.get('shot_parry')}.mp4`), join(t.root, `boss ${codes.get('shot_boss')}.mp4`), join(t.root, 'song.wav')],
  }); // prettier-ignore
  await idle();
  store.dispatch('core/music.set-track', {
    assetId: t.engine.library.list().find((a) => a.originalName === 'song.wav')!.id,
  });
  await analyzeOp(t.engine, store);
  await idle();
  await matchAcceptOp(t.engine, store, { minConfidence: 'certain' });
  await generateCutOp(t.engine, store);
  createDefaultVariantsOp(store);
  // ProRes keeps the test quick; the web presets are rendered in the render package's tests.
  store.dispatch('core/export.set', { variantId: 'var_tt', presetId: 'core/master' });
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

const card = (page: Page, name: string) => page.getByRole('region', { name: `Export of ${name}` });
const open = async (page: Page) => {
  await page.goto(`${t.svc.url}/p/${ID}/export#token=${t.svc.token}`);
  await expect(page.getByRole('heading', { name: 'Export', level: 1 })).toBeVisible();
};

test('export: choose the preset and file name, export, see the result, and the file is there', async ({
  page,
}) => {
  await open(page);
  const tt = card(page, 'var_tt');
  await expect(tt.getByLabel('Preset for var_tt')).toHaveValue('core/master');
  await expect(tt).toContainText('.mov');
  await expect(page.getByTestId('export-gate-var_tt')).toContainText('May be exported', {
    timeout: 30_000,
  });

  // The master cut has no stored choice: its settings are read-only.
  await expect(card(page, 'Master').getByLabel('Preset for Master')).toBeDisabled();

  // Settings are commands: a file name pattern, a bad number refused, a good one kept.
  await tt.getByLabel('File name pattern for var_tt').fill('{project}-shorts');
  await tt.getByLabel('File name pattern for var_tt').blur();
  await expect(tt).toContainText('-shorts.mov');
  await tt.getByLabel('Loudness target for var_tt').fill('-3');
  await tt.getByLabel('Loudness target for var_tt').blur();
  await expect(tt.getByRole('alert')).toContainText('A number from -30 to -6');
  await tt.getByLabel('Loudness target for var_tt').fill('-16');
  await tt.getByLabel('Loudness target for var_tt').blur();
  await expect(tt.getByRole('alert')).toHaveCount(0);

  await tt.getByRole('button', { name: 'Export', exact: true }).click();
  const result = tt.getByTestId('export-result');
  await expect(result).toContainText('Exported.', { timeout: 150_000 });
  const file = (await result.locator('code').first().textContent())!;
  expect(file).toMatch(/exports[\\/]render[\\/]var_tt[\\/].*-shorts\.mov$/);
  expect(existsSync(file)).toBe(true);
  expect(existsSync(file.replace(/\.mov$/, '.png'))).toBe(true);
  const record = JSON.parse(readFileSync(file.replace(/\.mov$/, '.export.json'), 'utf8')) as {
    preset: string;
  };
  expect(record.preset).toBe('core/master');
  await expect(page.getByRole('region', { name: 'Renders' })).toContainText('Done');
  expect(await axe(page)).toEqual([]);

  // Reset puts the default back.
  await tt.getByRole('button', { name: 'Reset to the default' }).click();
  await expect(tt.getByLabel('File name pattern for var_tt')).toHaveValue('');
});

test('export: cancel stops it cleanly, and exporting again resumes', async ({ page }) => {
  await open(page);
  const tt = card(page, 'var_tt');
  // The reset above put the default preset back; choose ProRes again.
  await expect(tt).toContainText('.mp4');
  await tt.getByLabel('Preset for var_tt').selectOption('core/master');
  await tt.getByLabel('File name pattern for var_tt').fill('cancel-me');
  await tt.getByLabel('File name pattern for var_tt').blur();
  await expect(tt).toContainText('cancel-me.mov');
  await tt.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(tt.getByTestId('export-progress')).toBeVisible({ timeout: 20_000 });
  await tt.getByRole('button', { name: 'Cancel' }).click();
  await expect(tt).toContainText('Cancelled. Starting again resumes', { timeout: 30_000 });
  const folder = join(dir, 'exports', 'render', 'var_tt');
  expect(readdirSync(folder).filter((f) => f.startsWith('cancel-me'))).toEqual([]);
  await tt.getByRole('button', { name: 'Resume export' }).click();
  await expect(tt.getByTestId('export-result')).toContainText('cancel-me.mov', {
    timeout: 150_000,
  });
  expect(existsSync(join(folder, 'cancel-me.mov'))).toBe(true);
});

test('export: a finding only the finished file shows needs a reason, then the export goes through and is logged', async ({
  page,
}) => {
  await open(page);
  const tt = card(page, 'var_tt');
  await tt.getByLabel('File name pattern for var_tt').fill('override-me');
  await tt.getByLabel('File name pattern for var_tt').blur();
  await tt.getByLabel('Loudness target for var_tt').fill('-6');
  await tt.getByLabel('Loudness target for var_tt').blur();
  await tt.getByRole('button', { name: 'Export', exact: true }).click();
  const banner = tt.getByRole('alert').filter({ hasText: 'Quality Gate stopped the export' });
  await expect(banner).toContainText('after checking the finished file', { timeout: 150_000 });
  await expect(banner).toContainText('loudness is');
  expect(existsSync(join(dir, 'exports', 'render', 'var_tt', 'override-me.mov'))).toBe(false);

  const reason = banner.getByTestId('override-loudness');
  await reason.fill('The platform normalises it anyway');
  await reason.blur();
  await tt.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(tt.getByTestId('export-result')).toContainText('Overridden: loudness (logged)', {
    timeout: 150_000,
  });
  expect(existsSync(join(dir, 'exports', 'render', 'var_tt', 'override-me.mov'))).toBe(true);
  const log = readFileSync(join(dir, 'logs', 'decisions.jsonl'), 'utf8');
  expect(log).toContain('The platform normalises it anyway');
  await tt.getByLabel('Loudness target for var_tt').fill('');
  await tt.getByLabel('Loudness target for var_tt').blur();
});

test('export: files for an editor, and a blocked plan disables the button until it is fixed', async ({
  page,
}) => {
  await open(page);
  const tt = card(page, 'var_tt');
  await tt.getByRole('checkbox', { name: /EDL/ }).uncheck();
  await tt.getByRole('button', { name: 'Write editor files' }).click();
  const out = tt.getByTestId('handoff-result');
  await expect(out).toContainText('FCPXML:', { timeout: 120_000 });
  await expect(out).toContainText('OTIO:');
  await expect(out).not.toContainText('EDL:');
  const paths = await out.locator('code').allTextContents();
  for (const p of paths) expect(existsSync(p), p).toBe(true);
  expect(
    readFileSync(
      paths.find((p) => p.endsWith('.fcpxml'))!,
      'utf8',
    ),
  ).toContain('<fcpxml version="1.10">');
  await expect(out).toContainText('with transparency');

  // A placeholder in the cut blocks every export of it; undo clears it.
  const store = await t.engine.openProject(dir);
  const item = store.state.timelines
    .find((x) => x.id === 'tl_rough')!
    .tracks.flatMap((x) => x.items)
    .find((i) => i.kind === 'clip' && i.slotId === 'shot_boss')!;
  store.dispatch('core/timeline.to-placeholder', { timelineId: 'tl_rough', itemId: item.id });
  await expect(page.getByTestId('export-gate-var_tt')).toContainText('Blocked', {
    timeout: 30_000,
  });
  await expect(tt.getByRole('button', { name: 'Export', exact: true })).toBeDisabled();
  store.undo();
  await expect(page.getByTestId('export-gate-var_tt')).toContainText('May be exported', {
    timeout: 30_000,
  });
  await expect(tt.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
  expect(await axe(page)).toEqual([]);
});
