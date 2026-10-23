import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ServiceClient } from '@trailerforge/service';
import { startTestService, type TestService } from './support.js';

const SECRET = 'STEAM-KEY-DO-NOT-LEAK';
const REPO: Record<string, string> = {
  'README.md':
    '# Ember Knight\n\nA soulslike about parrying fire.\n\n## Bosses\n- The Ash Warden — second-act boss with two phases\n',
  'docs/GDD.md': '# Design\n\n## Levels\n- Cinder Forest: burning woods\n',
  '.env': `STEAM_API_KEY=${SECRET}`,
  'keys/release.pem': SECRET,
};

let t: TestService;
let projectId: string;
let repo: string;
let mark: string;

test.beforeAll(async () => {
  // A stand-in for the `claude` CLI: records that it ran and returns one finding.
  const tools = await mkdtemp(join(tmpdir(), 'tforge-fake-claude-'));
  const bin = join(tools, 'claude');
  mark = join(tools, 'claude-ran');
  await writeFile(
    bin,
    `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.FAKE_CLAUDE_MARK, 'ran');
process.stdin.resume().on('data', () => {}).on('end', () => {
  process.stdout.write(JSON.stringify({ result: '', structured_output: { entities: [{ kind: 'mechanic', name: 'Soul Siphon', description: 'Drain a foe to heal', paths: ['README.md'] }] }, usage: { input_tokens: 1, output_tokens: 1 } }));
});
`,
  );
  await chmod(bin, 0o755);
  process.env.FAKE_CLAUDE_MARK = mark;
  t = await startTestService({ claudeBin: bin });
  repo = join(t.root, 'game');
  for (const [p, c] of Object.entries(REPO)) {
    await mkdir(dirname(join(repo, p)), { recursive: true });
    await writeFile(join(repo, p), c);
  }
  const client = new ServiceClient({ baseUrl: t.svc.url, token: t.svc.token });
  projectId = (
    await client.createProject({
      dir: join(t.root, 'K.tforge'),
      name: 'Ember Knight',
      videoTypeId: 'game-trailer/release-trailer',
    })
  ).id;
});
test.afterAll(async () => {
  await t.close();
});

const entity = (page: Page, name: string) => page.locator('.entity', { hasText: name });
const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name });

test.describe.serial('knowledge', () => {
  test('scan a repo, review it, and see exclusions respected in what the AI is sent', async ({
    page,
  }) => {
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));

    await page.goto(`${t.svc.url}/p/${projectId}/knowledge#token=${t.svc.token}`);
    await expect(page.getByRole('heading', { name: 'Game knowledge' })).toBeVisible();
    await expect(page.getByText('No repo yet.')).toBeVisible();
    await expect(page.getByTestId('privacy-summary')).toHaveText(
      '0 of 0 entries can be shared with an AI provider',
    );

    // Scan: secrets are skipped and said so; the facts show up.
    await page.getByLabel('Folder of your game repo').fill(repo);
    await page.getByRole('button', { name: 'Add repo and scan' }).click();
    const result = page.getByTestId('scan-result');
    await expect(result).toContainText('Scanned');
    await expect(result).toContainText('2 secret');
    await expect(entity(page, 'The Ash Warden')).toContainText('boss');
    await expect(entity(page, 'Cinder Forest')).toBeVisible();
    await expect(entity(page, 'Ember Knight')).toBeVisible();
    await expect(page.getByTestId('privacy-summary')).toHaveText(
      '3 of 3 entries can be shared with an AI provider',
    );
    await expect(page.getByText(SECRET)).toHaveCount(0);

    // Before excluding anything, the AI is told about the boss.
    await nav(page, 'Brief').click();
    const title = page.locator('[data-field="brief.title"]');
    await title.getByRole('button', { name: 'Suggest for me' }).click();
    await expect(title.locator('.suggestion')).toContainText('Suggested');
    expect(t.prompts.at(-1)).toContain('The Ash Warden');
    expect(t.prompts.at(-1)).not.toContain(SECRET);

    // Exclude the boss: it is marked, counted, and no longer part of what the AI sees.
    await nav(page, 'Game knowledge').click();
    const boss = entity(page, 'The Ash Warden');
    await boss.getByRole('switch', { name: 'Exclude The Ash Warden from AI' }).check();
    await expect(boss).toContainText('Excluded from AI');
    await expect(page.getByTestId('privacy-summary')).toHaveText(
      '2 of 3 entries can be shared with an AI provider · 1 excluded',
    );
    await nav(page, 'Brief').click();
    await page
      .locator('[data-field="brief.title"]')
      .getByRole('button', { name: 'Suggest for me' })
      .click();
    await expect(page.locator('[data-field="brief.title"] .suggestion')).toContainText('Suggested');
    const prompt = t.prompts.at(-1)!;
    expect(prompt).not.toContain('Ash Warden');
    expect(prompt).toContain('Cinder Forest'); // the rest is still shared

    // Editing makes an entry yours; a full re-scan keeps the edit and the exclusion.
    await nav(page, 'Game knowledge').click();
    await page.getByRole('button', { name: 'Edit Cinder Forest' }).click();
    const editing = page.locator('.entity.editing');
    await editing.getByLabel('Description').fill('My own words about the forest');
    await expect(editing).toContainText('later scans will not change it');
    await editing.getByRole('button', { name: 'Save' }).click();
    await expect(entity(page, 'Cinder Forest')).toContainText('Yours');
    await page.getByRole('button', { name: 'Full re-scan' }).click();
    await expect(result).toContainText('Scanned');
    await expect(entity(page, 'Cinder Forest')).toContainText('My own words about the forest');
    await expect(entity(page, 'The Ash Warden')).toContainText('Excluded from AI');

    // Add an entry by hand, filter to what is yours, then remove it again.
    await page.getByText('Add an entry by hand').click();
    await page
      .getByRole('group')
      .filter({ hasText: 'Add entry' })
      .first()
      .isVisible()
      .catch(() => undefined);
    const form = page.locator('.add-entry form');
    await form.getByLabel('Name').fill('Perfect Parry');
    await form.getByLabel('Kind').selectOption('ability');
    await form.getByRole('button', { name: 'Add entry' }).click();
    await expect(entity(page, 'Perfect Parry')).toContainText('Yours');
    await page.getByLabel('Show').selectOption('yours');
    await expect(page.locator('.entity')).toHaveCount(2);
    await page.getByLabel('Show').selectOption('all');
    await page.getByRole('button', { name: 'Remove Perfect Parry' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove “Perfect Parry”?' });
    await expect(dialog).toContainText('will not come back');
    await dialog.getByRole('button', { name: 'Remove entry' }).click();
    await expect(entity(page, 'Perfect Parry')).toHaveCount(0);

    expect(problems).toEqual([]);
  });

  test('deep scan needs an explicit confirmation, and its findings are marked', async ({
    page,
  }) => {
    test.skip(process.platform === 'win32', 'uses a shell-script stand-in for the claude CLI');
    await page.goto(`${t.svc.url}/p/${projectId}/knowledge#token=${t.svc.token}`);

    // Cancelling runs nothing.
    await page.getByRole('button', { name: 'Deep scan…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Let Claude Code read this repo?' });
    await expect(dialog).toContainText('contents of your text files are sent to Anthropic');
    const run = dialog.getByRole('button', { name: 'Run deep scan' });
    await expect(run).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(existsSync(mark)).toBe(false);

    // Ticking the acknowledgement is required, then it runs.
    await page.getByRole('button', { name: 'Deep scan…' }).click();
    await expect(run).toBeDisabled();
    await dialog.getByRole('checkbox', { name: /files will be sent to Anthropic/ }).check();
    await expect(run).toBeEnabled();
    await run.click();
    await expect(page.getByTestId('scan-result')).toContainText('deep scan found 1');
    await expect(entity(page, 'Soul Siphon')).toContainText('Deep scan');
    expect(existsSync(mark)).toBe(true);

    // A normal re-scan leaves the deep-scan finding alone.
    await page.getByRole('button', { name: 'Full re-scan' }).click();
    await expect(page.getByTestId('scan-result')).toContainText('Scanned');
    await expect(entity(page, 'Soul Siphon')).toBeVisible();
  });
});
