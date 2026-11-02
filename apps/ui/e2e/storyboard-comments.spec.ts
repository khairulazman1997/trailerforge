import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ServiceClient } from '@trailerforge/service';
import { startTestService, type TestService } from './support.js';

const clientOf = (t: TestService) => new ServiceClient({ baseUrl: t.svc.url, token: t.svc.token });
const titles = (scope: Locator) =>
  scope
    .locator('input.slot-title')
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
const section = (page: Page, id: string) => page.locator(`[data-section="${id}"]`);

test.describe.serial('comments on the storyboard, then a rewrite from them', () => {
  let t: TestService;
  let id: string;

  test.beforeAll(async () => {
    t = await startTestService();
    const client = clientOf(t);
    id = (
      await client.createProject({
        dir: join(t.root, 'Comments.tforge'),
        name: 'Comments',
        videoTypeId: 'game-trailer/release-trailer',
      })
    ).id;
    const task = await client.startTask(id, {
      kind: 'generate',
      options: { duration: 20, assume: true },
    });
    expect((await client.waitForTask(task.id)).status).toBe('succeeded');
  });
  test.afterAll(async () => {
    await t.close();
  });

  test('comment on a slot and a section, rewrite from them, comments resolve, undo restores', async ({
    page,
  }) => {
    await page.goto(`${t.svc.url}/p/${id}/storyboard#token=${t.svc.token}`);
    const hook = section(page, 'sec_hook');
    await expect.poll(() => titles(hook)).toEqual(['Perfect parry', 'Forest run']);

    await hook.getByRole('button', { name: 'Comment on Hook' }).click();
    await hook.getByRole('combobox', { name: /^On/ }).selectOption({ label: '#2 Forest run' });
    await hook.getByLabel('Comment', { exact: true }).fill('Too calm, add enemies');
    await hook.getByRole('button', { name: 'Add comment' }).click();
    await hook.getByRole('button', { name: 'Comment on Hook' }).click();
    await hook.getByLabel('Comment', { exact: true }).fill('Open faster');
    await hook.getByRole('button', { name: 'Add comment' }).click();
    await expect(page.getByTestId('comments-sec_hook')).toHaveText('2 comments');
    const list = hook.getByRole('list', { name: 'Open comments on Hook' });
    await expect(list).toContainText('#2 Forest run');
    await expect(list).toContainText('Whole section');

    const axe = await new AxeBuilder({ page }).include('.sections').analyze();
    expect(axe.violations).toEqual([]);

    await page.getByRole('button', { name: /Refine from comments \(1 section\)/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Refine the storyboard from your comments' });
    await expect(dialog).toContainText('Too calm, add enemies');
    await dialog.getByRole('button', { name: 'Rewrite 1 section' }).click();

    await expect.poll(() => titles(hook)).toEqual(['Warden lands', 'Forest ambush']);
    await expect(page.getByText(/Rewrote “Hook v2” from your comments/)).toBeVisible();
    const prompt = t.prompts.at(-1)!;
    expect(prompt).toContain('- on slot #2 "Forest run": Too calm, add enemies');
    expect(prompt).toContain('- on the whole section: Open faster');

    await expect(page.getByTestId('comments-sec_hook')).toHaveCount(0);
    await hook.getByRole('button', { name: 'Show 2 resolved' }).click();
    const resolved = hook.getByRole('list', { name: 'Resolved comments on Hook v2' });
    await expect(resolved).toContainText('Forest run (replaced)');
    await expect(resolved).toContainText('addressed by a rewrite');

    // One undo brings back the old section and its open comments.
    await page.getByRole('button', { name: /Undo/ }).first().click();
    await expect.poll(() => titles(hook)).toEqual(['Perfect parry', 'Forest run']);
    await expect(page.getByTestId('comments-sec_hook')).toHaveText('2 comments');

    // The section's own Rewrite dialog sends them too, and can leave them out.
    await hook.getByRole('button', { name: 'Rewrite from 2 comments…' }).click();
    const rewrite = page.getByRole('dialog', { name: 'Rewrite “Hook”' });
    await rewrite.getByLabel(/Work from the 2 open comments/).uncheck();
    await rewrite.getByRole('button', { name: 'Rewrite section' }).click();
    await expect.poll(() => titles(hook)).toEqual(['Warden lands', 'Forest ambush']);
    expect(t.prompts.at(-1)!).not.toContain('Too calm');
    await expect(page.getByTestId('comments-sec_hook')).toHaveText('2 comments');
  });
});
