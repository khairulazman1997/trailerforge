import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { Engine } from '@trailerforge/engine';
import { ServiceClient, startService, type RunningService } from '@trailerforge/service';

let root: string;
let engine: Engine;
let svc: RunningService;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-ui-e2e-'));
  engine = await Engine.start({ home: join(root, 'home'), autosaveMs: 0, loadUserPlugins: false });
  svc = await startService({ engine, staticDir: resolve(import.meta.dirname, '..', 'dist') });
});

test.afterAll(async () => {
  await svc.close();
  await engine.close();
});

const link = () => `${svc.url}/#token=${svc.token}`;

test('connect from the link, create a project, edit it, see outside changes live, undo and redo', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // Connecting: the token in the link is used, then removed from the address bar.
  await page.goto(link());
  await expect(page.getByTestId('connection-status')).toHaveText('Connected');
  expect(page.url()).not.toContain('token');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

  // Creating a project from the form.
  const dir = join(root, 'Smoke.tforge');
  await page.getByLabel('Name', { exact: true }).fill('Smoke Test');
  await page.getByLabel('Video type').selectOption('game-trailer/release-trailer');
  await page.getByLabel('Project folder (will be created)').fill(dir);
  await page.getByRole('button', { name: 'Create' }).click();
  const name = page.getByLabel('Project name');
  await expect(name).toHaveValue('Smoke Test');
  await expect(page.getByTestId('project-version')).toHaveText('0');
  await expect(page.getByText('game-trailer/release-trailer')).toBeVisible();
  const projectUrl = page.url();
  expect(projectUrl).toMatch(/\/p\/proj_/);

  // Editing: rename, then undo and redo with the buttons.
  await name.fill('Renamed');
  await name.press('Enter');
  await expect(page.getByTestId('project-version')).toHaveText('1');
  const undo = page.getByRole('button', { name: 'Undo' }).last();
  const redo = page.getByRole('button', { name: 'Redo' }).last();
  await expect(redo).toBeDisabled();
  await undo.click();
  await expect(name).toHaveValue('Smoke Test');
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(name).toHaveValue('Renamed');

  // Live state: a change made by someone else (another client, Claude Code) appears with no reload.
  const id = projectUrl.split('/p/')[1]!;
  const other = new ServiceClient({ baseUrl: svc.url, token: svc.token });
  const status = page
    .getByRole('group', { name: 'Project state' })
    .or(page.getByLabel('Project state'));
  await expect(status).toContainText('idea');
  const before = Number(await page.getByTestId('project-version').textContent());
  await other.command(id, 'core/project.set-status', { status: 'capturing' });
  await expect(status).toContainText('capturing');
  await expect(page.getByTestId('project-version')).toHaveText(String(before + 1));

  // Keyboard undo reverts it (focus is not in a text field).
  await page.locator('body').click({ position: { x: 5, y: 400 } });
  await page.keyboard.press('Control+z');
  await expect(status).toContainText('idea');
  await expect(name).toHaveValue('Renamed');
  await page.keyboard.press('Control+Shift+z');
  await expect(status).toContainText('capturing');

  // A reload reconnects with the saved token and shows the same project.
  await page.reload();
  await expect(page.getByTestId('connection-status')).toHaveText('Connected');
  await expect(page.getByLabel('Project name')).toHaveValue('Renamed');
  await expect(page.getByLabel('Project state')).toContainText('capturing');

  expect(errors).toEqual([]);
});

test('closing a project asks first, and cancelling keeps it open', async ({ page }) => {
  await page.goto(link());
  await expect(page.getByTestId('connection-status')).toHaveText('Connected');
  await page
    .getByRole('link', { name: /Smoke Test|Renamed|ok|From elsewhere/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Close project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Close this project?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('Project name')).toBeVisible();

  await page.getByRole('button', { name: 'Close project' }).click();
  await page.keyboard.press('Escape'); // Escape cancels too
  await expect(page.getByRole('dialog')).toBeHidden();

  await page.getByRole('button', { name: 'Close project' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close project' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open now' })).toHaveCount(0);
});

test('a wrong token shows the connect screen with the reason, and a local-only address check', async ({
  page,
}) => {
  await page.goto(`${svc.url}/#token=${'x'.repeat(43)}`);
  await expect(page.getByRole('heading', { name: 'Connect to TrailerForge' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('token');

  // Typing the right token in the form connects.
  await page.getByLabel('Token').fill(svc.token);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByTestId('connection-status')).toHaveText('Connected');

  // Non-local addresses are not accepted.
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByRole('heading', { name: 'Connect to TrailerForge' })).toBeVisible();
  await page.getByLabel('Service address').fill('https://evil.example');
  await page.getByLabel('Token').fill('abc');
  await expect(page.getByRole('button', { name: 'Connect' })).toBeDisabled();
  await expect(page.getByText('Only local addresses')).toBeVisible();
});
