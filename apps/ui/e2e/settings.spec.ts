import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ServiceClient } from '@trailerforge/service';
import { startTestService, type TestService } from './support.js';

let t: TestService;
let projectId: string;
const savedEnvKey = process.env.ANTHROPIC_API_KEY;

test.beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  t = await startTestService({ realProviders: true });
  const client = new ServiceClient({ baseUrl: t.svc.url, token: t.svc.token });
  projectId = (
    await client.createProject({
      dir: join(t.root, 'Settings.tforge'),
      name: 'Ember Knight',
      videoTypeId: 'game-trailer/release-trailer',
    })
  ).id;
});
test.afterAll(async () => {
  if (savedEnvKey !== undefined) process.env.ANTHROPIC_API_KEY = savedEnvKey;
  await t.close();
});

const open = (page: Page, path: string) => page.goto(`${t.svc.url}${path}#token=${t.svc.token}`);

test('save an API key, see the provider become available, remove it', async ({ page }) => {
  await open(page, '/settings');
  const anthropic = page.locator('[data-provider="core/anthropic"]');
  await expect(anthropic).toContainText('Unavailable');
  await expect(page.getByTestId('key-state')).toContainText('No key yet');

  const secret = 'sk-ant-e2e-secret-value-1234567890';
  await page.getByLabel('Paste your key').fill(secret);
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByTestId('key-state')).toContainText('A key is saved in settings');
  await expect(anthropic).toContainText('Available');
  expect(await page.content()).not.toContain(secret);
  expect(
    await page.locator('input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)),
  ).not.toContain(secret);

  await page.reload();
  await expect(anthropic).toContainText('Available');
  expect(await page.content()).not.toContain(secret);

  await page.getByRole('button', { name: 'Remove key' }).click();
  await expect(page.getByTestId('key-state')).toContainText('No key yet');
  await expect(anthropic).toContainText('Unavailable');
});

test('edit a route, persist it, then reset to defaults', async ({ page }) => {
  await open(page, '/settings');
  await expect(page.getByRole('button', { name: 'Reset to defaults' })).toHaveCount(0);
  await page
    .getByLabel('Provider for Default for everything else')
    .selectOption('core/chat-handoff');
  await page.getByRole('button', { name: 'Save routes' }).click();
  await expect(page.getByText('Customised')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Provider for Default for everything else')).toHaveValue(
    'core/chat-handoff',
  );

  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await page.getByRole('button', { name: 'Reset routes' }).click();
  await expect(page.getByText('Customised')).toHaveCount(0);
  await expect(page.getByLabel('Provider for Default for everything else')).not.toHaveValue(
    'core/chat-handoff',
  );
});

test('Chat Handoff round-trip with a fix-it follow-up', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const client = new ServiceClient({ baseUrl: t.svc.url, token: t.svc.token });
  await client.saveRoutes({
    default: { provider: 'core/chat-handoff' },
    fallbacks: [],
  } as never);

  await open(page, `/p/${projectId}/brief`);
  const title = page.locator('[data-field="brief.title"]');
  await title.getByRole('button', { name: 'Suggest for me' }).click();

  const dialog = page.getByRole('dialog', { name: 'Copy this into a chat' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Request to copy')).toHaveValue(/Game name/);
  await dialog.getByRole('button', { name: 'Copy request' }).click();
  await expect(dialog.getByRole('button', { name: 'Copied ✓' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Game name');

  // Hiding keeps the request alive and reopens from the top bar.
  await dialog.getByRole('button', { name: 'Hide for now' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '1 chat request waiting' }).click();
  await expect(dialog).toBeVisible();

  // A reply that is not valid gets a follow-up to paste into the same chat.
  await dialog.getByLabel('Reply from the chat').fill('Sure! Here is a title.');
  await dialog.getByRole('button', { name: 'Send reply' }).click();
  const followUp = page.getByRole('dialog', { name: /did not validate/ });
  await expect(followUp).toBeVisible();
  await expect(followUp.getByLabel('Request to copy')).not.toHaveValue(/^$/);

  await followUp
    .getByLabel('Reply from the chat')
    .fill('{"value": "Ember Knight", "reason": "it fits the game"}');
  await followUp.getByRole('button', { name: 'Send reply' }).click();
  await expect(followUp).toBeHidden();
  await expect(title.getByRole('textbox')).toHaveValue('Ember Knight');
  await expect(title.locator('.suggestion')).toContainText('it fits the game');

  // Cancelling a request ends the operation cleanly.
  await title.getByRole('button', { name: 'Save' }).click();
  const points = page.locator('[data-field="brief.keySellingPoints"]');
  await points.getByRole('button', { name: 'Suggest for me' }).click();
  const again = page.getByRole('dialog', { name: 'Copy this into a chat' });
  await again.getByRole('button', { name: 'Cancel request' }).click();
  await expect(again).toBeHidden();
  await expect(page.getByRole('button', { name: /chat request/ })).toHaveCount(0);

  await client.resetRoutes();
});
