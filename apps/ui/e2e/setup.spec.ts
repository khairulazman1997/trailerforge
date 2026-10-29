import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { REQUIRED_ENCODERS, REQUIRED_FILTERS } from '@trailerforge/engine';
import { startTestService, type TestService } from './support.js';

/** The Setup screen with an FFmpeg that lacks one filter and a sidecar that answers. */

test.skip(process.platform === 'win32', 'the fake FFmpeg is a shell script');
let t: TestService;
const savedCmd = process.env.TFORGE_ANALYSIS_CMD;

test.beforeAll(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'tforge-setup-e2e-'));
  const sidecar = join(dir, 'sidecar.mjs');
  await writeFile(
    sidecar,
    `process.stdin.on('data', (d) => { const m = JSON.parse(String(d).split('\\n')[0]); console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { pong: true } })); });`,
  );
  process.env.TFORGE_ANALYSIS_CMD = JSON.stringify([process.execPath, sidecar]);
  const ffmpeg = join(dir, 'ffmpeg');
  await writeFile(
    ffmpeg,
    `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a.includes('-version')) console.log('ffmpeg version 6.1.1-fake --enable-gpl');
else if (a.includes('-encoders')) console.log(${JSON.stringify(REQUIRED_ENCODERS.map((e) => ` V....D ${e}   fake`).join('\n'))});
else if (a.includes('-filters')) console.log(${JSON.stringify(
      REQUIRED_FILTERS.filter((f) => f !== 'xfade')
        .map((f) => ` ... ${f}   V->V  fake`)
        .join('\n'),
    )});
`,
  );
  await chmod(ffmpeg, 0o755);
  t = await startTestService({ engine: { ffmpegTools: { ffmpeg, ffprobe: 'ffprobe' } } });
});
test.afterAll(async () => {
  if (savedCmd === undefined) delete process.env.TFORGE_ANALYSIS_CMD;
  else process.env.TFORGE_ANALYSIS_CMD = savedCmd;
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

test('the Projects page points at what is missing; Setup names it and says what to do', async ({
  page,
}) => {
  await page.goto(`${t.svc.url}/#token=${t.svc.token}`);
  const banner = page.getByTestId('setup-banner');
  await expect(banner).toContainText('FFmpeg');
  await banner.getByRole('link', { name: 'Open Setup' }).click();

  await expect(page.getByRole('heading', { name: 'Setup', level: 1 })).toBeVisible();
  await expect(page.getByTestId('setup-verdict')).toHaveText('Something needs attention');
  const ffmpeg = page.locator('[data-check="ffmpeg"]');
  await expect(ffmpeg).toHaveAttribute('data-status', 'fail');
  await expect(ffmpeg).toContainText('lacks the filter "xfade"');
  await expect(page.getByTestId('fix-ffmpeg')).toContainText('full FFmpeg build');
  await expect(page.locator('[data-check="analysis"]')).toHaveAttribute('data-status', 'ok');
  await expect(page.locator('[data-check="disk"]')).toContainText('GB free');
  expect(await axe(page)).toEqual([]);

  // Checking again re-reads everything.
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(ffmpeg).toContainText('xfade');
});

test('creating the analysis environment shows its size and source and waits for a yes', async ({
  page,
}) => {
  // The real check is "ready" here; a needs-setup answer is crafted so the dialog can be seen.
  await page.route('**/v1/health', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { checks: { id: string; status: string; action?: string; detail: string }[] }; // prettier-ignore
    const a = body.checks.find((c) => c.id === 'analysis')!;
    a.status = 'fail';
    a.action = 'setup-sidecar';
    a.detail = 'The analysis environment has not been created yet.';
    await route.fulfill({ response: res, json: body });
  });
  let posted = 0;
  await page.route('**/v1/health/analysis-setup', (route) => {
    posted++;
    return route.abort();
  });
  await page.goto(`${t.svc.url}/setup#token=${t.svc.token}`);
  await page.getByRole('button', { name: 'Create the analysis environment…' }).click();
  const dialog = page.getByRole('dialog');
  const text = dialog.getByTestId('setup-disclosure');
  await expect(text).toContainText('about 900 MB');
  await expect(text).toContainText('PyPI');
  await expect(text).toContainText('network log');
  await expect(text).toContainText('No footage, project data or personal information is sent');
  expect(await axe(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(posted).toBe(0); // nothing is requested until the yes
});
