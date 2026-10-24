import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { startTestService, type TestService } from './support.js';

let t: TestService;
let servers: string;
const CLI = 'C:/tforge/apps/cli/dist/bin.js';

/** A stand-in `claude` that keeps its MCP registrations in a JSON file. */
const fakeClaude = (state: string) => `const fs = require('fs'); const f = ${JSON.stringify(state)};
const db = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
const [, , a, b, ...rest] = process.argv;
if (a === 'mcp' && b === 'get') process.exit(db[rest[0]] ? 0 : 1);
if (a === 'mcp' && b === 'add') {
  const i = rest.indexOf('--'); db[rest[i - 1]] = { cmd: rest.slice(i + 1) };
  fs.writeFileSync(f, JSON.stringify(db)); process.exit(0);
}
if (a === 'mcp' && b === 'remove') { delete db[rest[rest.length - 1]]; fs.writeFileSync(f, JSON.stringify(db)); process.exit(0); }
process.exit(2);`;

test.beforeAll(async () => {
  const dir = join(process.env.TEMP ?? process.env.TMPDIR ?? '.', `tforge-cc-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  servers = join(dir, 'servers.json');
  const script = join(dir, 'claude.js');
  writeFileSync(script, fakeClaude(servers));
  t = await startTestService({
    claudeBin: process.execPath,
    claudeBinArgs: [script],
    cliPath: CLI,
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

/** Pretend to be the desktop app: the folder chooser answers with `window.__picked`. */
const asDesktop = (page: Page) =>
  page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).trailerforgeDesktop = {
      pickFolder: async () => (window as unknown as { __picked?: string }).__picked ?? null,
    };
  });
const picks = (page: Page, path: string) =>
  page.evaluate((p) => ((window as unknown as { __picked?: string }).__picked = p), path);

test('Settings: connect Claude Code in one click, see the command, disconnect', async ({
  page,
}) => {
  await page.goto(`${t.svc.url}/settings#token=${t.svc.token}`);
  const panel = page.getByTestId('claude-code-panel');
  await expect(panel.getByText('Not connected')).toBeVisible();
  await panel.getByRole('button', { name: 'Connect Claude Code' }).click();
  await expect(panel.getByText('Connected', { exact: true })).toBeVisible();
  await expect(page.getByText('Claude Code is connected.')).toBeVisible();

  await panel.getByText('Run it yourself instead').click();
  await expect(panel.locator('code')).toContainText('claude mcp add --scope user trailerforge --');
  await expect(panel.locator('code')).toContainText(CLI);
  expect(await axe(page)).toEqual([]);

  await panel.getByRole('button', { name: 'Reconnect' }).click();
  await expect(panel.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  await panel.getByRole('button', { name: 'Disconnect' }).click();
  await expect(panel.getByText('Not connected')).toBeVisible();
});

test('desktop file chooser: open a project, choose where a new one goes, link a game repo', async ({
  page,
}) => {
  const proj = join(t.root, 'Picked.tforge');
  await t.engine.createProject(proj, { ...sampleProject(), id: 'proj_picked' } as never);
  await t.engine.closeProject(proj);

  // In a plain browser there is nothing to browse with.
  await page.goto(`${t.svc.url}/#token=${t.svc.token}`);
  await expect(page.getByRole('button', { name: /^Browse/ })).toHaveCount(0);

  await asDesktop(page);
  await page.reload(); // the same address again would not run the new init script
  await expect(page.getByRole('heading', { name: 'Open a project' })).toBeVisible();

  // Choose where a new project goes: the folder picked becomes <folder>/<Name>.tforge.
  await page.getByLabel('Name', { exact: true }).fill('Fresh Game');
  await picks(page, t.root);
  await page.getByRole('button', { name: 'Choose where to put it…' }).click();
  await expect(page.getByLabel('Project folder (will be created)')).toHaveValue(
    new RegExp(`Fresh Game\\.tforge$`),
  );
  expect(await axe(page)).toEqual([]);

  // Open an existing project by browsing for it.
  await picks(page, proj);
  await page.getByRole('button', { name: 'Browse for a project…' }).click();
  await expect(page).toHaveURL(/\/p\/proj_picked/);

  // Link a game repo by browsing for its folder.
  const repo = join(t.root, 'UnityGame');
  mkdirSync(join(repo, 'Assets'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# Unity Game\nA small test repo.\n');
  await page
    .getByRole('navigation', { name: 'Project sections' })
    .getByRole('link', { name: 'Knowledge' })
    .click();
  await picks(page, repo);
  await page.getByRole('button', { name: 'Browse for the repo…' }).click();
  await expect(page.getByLabel(/Folder of your game repo|Add another repo/)).toHaveValue(repo);
  await page.getByRole('button', { name: 'Add repo and scan' }).click();
  await expect(page.getByText(/Scanned \d+ files?/)).toBeVisible({ timeout: 30_000 });
});
