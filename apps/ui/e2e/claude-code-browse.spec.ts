import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { startTestService, type TestService } from './support.js';

let t: TestService;
let settings: string;
const CLI = 'C:/tforge/apps/cli/dist/bin.js';

test.beforeAll(async () => {
  const dir = join(process.env.TEMP ?? process.env.TMPDIR ?? '.', `tforge-cc-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  // A stand-in for Claude Code's ~/.claude.json, with things that must survive.
  settings = join(dir, 'claude.json');
  writeFileSync(settings, JSON.stringify({ userID: 'u1', mcpServers: {} }));
  t = await startTestService({ claudeConfigPath: settings, cliPath: CLI });
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

test('Settings: connect Claude Code to this app in one click, or the separate tool, then disconnect', async ({
  page,
}) => {
  await page.goto(`${t.svc.url}/settings#token=${t.svc.token}`);
  const panel = page.getByTestId('claude-code-panel');
  const state = panel.getByTestId('claude-code-state');
  await expect(state).toHaveText('Not connected');
  await panel.getByRole('button', { name: 'Connect Claude Code' }).click();
  await expect(state).toHaveText('Connected to this app');
  await expect(page.getByText('Claude Code is connected.')).toBeVisible();
  const saved = JSON.parse(readFileSync(settings, 'utf8'));
  expect(saved.userID).toBe('u1');
  expect(saved.mcpServers.trailerforge).toEqual({
    type: 'http',
    url: t.svc.mcp.url,
    headers: { Authorization: `Bearer ${t.svc.mcp.token}` },
  });
  expect(await axe(page)).toEqual([]);

  await panel.getByText('Use Claude Code while this app is closed').click();
  await panel.getByRole('button', { name: 'Use the separate tool instead' }).click();
  await expect(state).toHaveText('Connected (separate tool)');
  expect(JSON.parse(readFileSync(settings, 'utf8')).mcpServers.trailerforge.type).toBe('stdio');

  await panel
    .getByRole('button', { name: 'Reconnect' })
    .or(panel.getByRole('button', { name: 'Connect Claude Code' }))
    .click();
  await expect(state).toHaveText('Connected to this app');
  await panel.getByRole('button', { name: 'Disconnect' }).click();
  await expect(state).toHaveText('Not connected');
  expect(JSON.parse(readFileSync(settings, 'utf8')).mcpServers).toEqual({});
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
