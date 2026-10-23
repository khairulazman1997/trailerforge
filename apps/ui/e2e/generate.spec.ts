import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { ServiceClient } from '@trailerforge/service';
import { startTestService, type TestService } from './support.js';

const open = (t: TestService, id: string, tab = 'storyboard') =>
  `${t.svc.url}/p/${id}/${tab}#token=${t.svc.token}`;
const clientOf = (t: TestService) => new ServiceClient({ baseUrl: t.svc.url, token: t.svc.token });
const titles = (scope: Locator) =>
  scope
    .locator('input.slot-title')
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
const section = (page: Page, id: string) => page.locator(`[data-section="${id}"]`);

test.describe.serial('generate and rewrite with a provider that stays on this computer', () => {
  let t: TestService;
  let id: string;

  test.beforeAll(async () => {
    t = await startTestService();
    const client = clientOf(t);
    id = (
      await client.createProject({
        dir: join(t.root, 'Gen.tforge'),
        name: 'Gen',
        videoTypeId: 'game-trailer/release-trailer',
      })
    ).id;
    await client.command(id, 'core/knowledge.add-entity', {
      id: 'ent_ash',
      kind: 'boss',
      name: 'Ash Warden',
    });
    await client.command(id, 'core/knowledge.add-entity', {
      id: 'ent_hid',
      kind: 'level',
      name: 'Hidden Level',
    });
    await client.command(id, 'core/knowledge.set-excluded', { id: 'ent_hid', excluded: true });
  });
  test.afterAll(async () => {
    await t.close();
  });

  test('generate: shows what is sent, needs the brief or an explicit assumption, then writes it', async ({
    page,
  }) => {
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));

    await page.goto(open(t, id));
    await expect(page.getByText('No storyboard yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Generate storyboard…' }).click();

    const dialog = page.getByRole('dialog', { name: 'Generate a storyboard' });
    const disclosure = dialog.getByTestId('disclosure');
    await expect(disclosure).toContainText('Mock');
    await expect(disclosure).toContainText('this stays on your computer');
    await expect(disclosure).toContainText('Game facts: 1');
    await expect(disclosure).toContainText('1 you excluded are not sent');
    await disclosure.getByText('Show the names').click();
    await expect(disclosure).toContainText('Ash Warden');
    await expect(disclosure).not.toContainText('Hidden Level');
    await expect(dialog.getByLabel('Template')).toHaveValue('');

    // An incomplete brief blocks generating until the user chooses to proceed with assumptions.
    await expect(dialog.getByRole('alert')).toContainText('missing 8 required details');
    const generate = dialog.getByRole('button', { name: 'Generate', exact: true });
    await expect(generate).toBeDisabled();
    await dialog.getByLabel(/Proceed with assumptions/).check();
    await expect(generate).toBeEnabled();
    await dialog.getByLabel('Length (seconds)').fill('30');
    await generate.click();

    await expect(section(page, 'sec_hook')).toBeVisible();
    await expect(page.getByTestId('timing-actual')).toHaveText('30 s');
    await expect(page.getByText(/Storyboard written with core\/mock/)).toBeVisible();

    // What was shown is what was sent: the shared fact is in the prompt, the excluded one is not.
    const prompt = t.prompts.at(-1)!;
    expect(prompt).toContain('Ash Warden');
    expect(prompt).not.toContain('Hidden Level');
    // The assumptions that let it proceed are recorded, not hidden.
    expect((await clientOf(t).getProject(id)).project.brief.assumptions.length).toBeGreaterThan(0);

    // The reason is on record.
    await page.getByRole('button', { name: 'Why this storyboard?' }).click();
    await expect(page.getByRole('complementary', { name: 'Why this storyboard' })).toContainText(
      'Generated the storyboard',
    );
    expect(problems).toEqual([]);
  });

  test('generating again warns about what it replaces, and cancelling sends nothing', async ({
    page,
  }) => {
    await page.goto(open(t, id));
    const before = t.prompts.length;
    await page.getByRole('button', { name: 'Generate again…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Generate the storyboard again?' });
    await expect(dialog).toContainText('This replaces every unlocked section');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(t.prompts.length).toBe(before);
  });

  test('rewrite one section: your instruction is sent, hand-edited slots are kept unless you say otherwise', async ({
    page,
  }) => {
    await page.goto(open(t, id));
    const hook = section(page, 'sec_hook');
    await expect.poll(() => titles(hook)).toEqual(['Perfect parry', 'Forest run']);
    const title = hook.getByLabel('Title of Perfect parry', { exact: true });
    await title.fill('Hand parry');
    await title.press('Enter');
    await expect(hook.locator('.slot').first()).toContainText('Edited');

    await page.getByRole('button', { name: 'Rewrite Hook' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rewrite “Hook”' });
    await expect(dialog.getByLabel(/Keep the 1 slot I edited by hand/)).toBeChecked();
    await dialog.getByLabel('What should change?').fill('more forest');
    await dialog.getByRole('button', { name: 'Rewrite section' }).click();

    // The edited slot stays where it was; the model's slots fill the rest.
    await expect.poll(() => titles(hook)).toEqual(['Hand parry', 'Warden lands', 'Forest ambush']);
    await expect(page.getByText('Rewrote “Hook v2” with core/mock')).toBeVisible();
    const prompt = t.prompts.at(-1)!;
    expect(prompt).toContain('more forest');
    expect(prompt).toContain('Hand parry'); // told to leave it alone

    // Untick "keep" and it is rewritten too.
    await page.getByRole('button', { name: 'Rewrite Hook v2' }).click();
    const again = page.getByRole('dialog', { name: 'Rewrite “Hook v2”' });
    await again.getByLabel(/Keep the 1 slot I edited by hand/).uncheck();
    await again.getByRole('button', { name: 'Rewrite section' }).click();
    await expect.poll(() => titles(hook)).toEqual(['Warden lands', 'Forest ambush']);

    // One undo returns to the version that kept the hand edit.
    await page.getByRole('button', { name: /Undo/ }).first().click();
    await expect.poll(() => titles(hook)).toEqual(['Hand parry', 'Warden lands', 'Forest ambush']);
  });
});

test.describe.serial('a provider that sends data off this computer', () => {
  let t: TestService;

  test.beforeAll(async () => {
    t = await startTestService({ offDevice: true });
    await t.engine.createProject(join(t.root, 'Away.tforge'), sampleProject() as never);
  });
  test.afterAll(async () => {
    await t.close();
  });

  test('needs an explicit acknowledgement once per session, and says what leaves', async ({
    page,
  }) => {
    await page.goto(open(t, 'proj_sample'));
    await page.getByRole('button', { name: 'Generate again…' }).click();
    let dialog = page.getByRole('dialog', { name: 'Generate the storyboard again?' });
    await expect(dialog.getByTestId('disclosure')).toContainText('this leaves your computer');

    // The sample's brief may need assumptions to proceed; that is a separate gate from consent.
    const assume = dialog.getByLabel(/Proceed with assumptions/);
    if (await assume.count()) await assume.check();
    const generate = dialog.getByRole('button', { name: 'Generate', exact: true });
    await expect(generate).toBeDisabled(); // not yet acknowledged

    // Cancelling sends nothing.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(t.prompts).toHaveLength(0);

    // Acknowledge, and it goes.
    await page.getByRole('button', { name: 'Generate again…' }).click();
    dialog = page.getByRole('dialog', { name: 'Generate the storyboard again?' });
    if (await dialog.getByLabel(/Proceed with assumptions/).count())
      await dialog.getByLabel(/Proceed with assumptions/).check();
    await dialog.getByLabel(/this information is sent to Mock/).check();
    await expect(generate).toBeEnabled();
    await generate.click();
    await expect(page.getByText(/Storyboard written with core\/mock/)).toBeVisible();
    expect(t.prompts).toHaveLength(1);

    // Agreed for this session: the next dialog still discloses, but does not nag.
    await page.getByRole('button', { name: 'Generate again…' }).click();
    dialog = page.getByRole('dialog', { name: 'Generate the storyboard again?' });
    await expect(dialog.getByTestId('disclosure')).toContainText('this leaves your computer');
    await expect(dialog.getByLabel(/this information is sent to/)).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });
});
