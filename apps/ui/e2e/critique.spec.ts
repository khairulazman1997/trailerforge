import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { startTestService, type TestService } from './support.js';

let t: TestService;
const ID = 'proj_sample';

test.beforeAll(async () => {
  t = await startTestService({ offDevice: true });
  const store = await t.engine.createProject(join(t.root, 'Critique.tforge'), sampleProject() as never); // prettier-ignore
  store.dispatch('core/knowledge.set-excluded', { id: 'ent_warden', excluded: true });
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

const project = () => [...t.engine.projects.values()].find((s) => s.state.id === ID)!;
const hook = () =>
  project()
    .state.storyboard!.sections.flatMap((s) => s.slots)
    .find((s) => s.id === 'shot_parry')!;

test('ask for a critique: see what is sent, agree, read the notes, apply one, dismiss one, undo', async ({
  page,
}) => {
  await page.goto(`${t.svc.url}/p/${ID}/review#token=${t.svc.token}`);
  await page.getByRole('button', { name: 'Ask for a critique' }).click();

  // The disclosure says who gets it, lists what is sent, and counts what stays out.
  const dialog = page.getByRole('dialog');
  const disclosure = dialog.getByTestId('disclosure');
  await expect(disclosure).toContainText('this leaves your computer');
  const sent = dialog.getByTestId('critique-sent');
  await expect(sent).toContainText('shots in order');
  await expect(sent).toContainText('Quality Gate finding');
  await expect(sent).toContainText('Never sent: footage');
  await expect(dialog).toContainText('1 game fact you excluded is left out');
  await dialog.getByText('Show the exact text').click();
  const exact = await dialog.locator('pre.wire').textContent();
  expect(exact).toContain('shot-1');
  expect(exact).not.toMatch(/ash warden/i);
  expect(await axe(page)).toEqual([]);

  const ask = dialog.getByRole('button', { name: 'Ask for a critique' });
  await expect(ask).toBeDisabled(); // needs the explicit yes
  expect(t.prompts.filter((p) => p.includes('reviewing a finished rough cut'))).toHaveLength(0);
  await dialog.getByLabel(/I understand this information is sent to/).check();
  await ask.click();

  // The notes arrive on the Review tab as comments by the critique.
  const list = page.getByRole('list', { name: 'Comments' });
  await expect(list).toContainText('The hook runs long for a parry.', { timeout: 20_000 });
  await expect(list).toContainText('AI critique');
  await expect(list).toContainText('Suggested: Cut the hook to 1.5 seconds');
  const sentPrompt = t.prompts.find((p) => p.includes('reviewing a finished rough cut'))!;
  expect(sentPrompt).not.toMatch(/ash warden/i);
  expect(sentPrompt).not.toContain('shot_parry');
  expect(await axe(page)).toEqual([]);

  // A note has no Edit; applying its fix changes the storyboard and resolves the note.
  await expect(list.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  expect(hook().duration.ideal).toBe(2);
  await page
    .getByRole('button', { name: /^Apply the suggestion at .*Cut the hook to 1.5 seconds/ })
    .click();
  await expect.poll(() => hook().duration.ideal).toBe(1.5);
  await expect(list.locator('.chip.ok')).toHaveText(/resolved/);
  await expect(page.getByTestId('critique-fix')).toHaveCount(0);

  // Dismiss the other note.
  await page
    .getByRole('button', { name: /^Dismiss the note at / })
    .last()
    .click();
  await expect(list).not.toContainText('The pacing does not speed up');

  // Applying was one undo step: the length and the open note come back together.
  project().undo(); // dismiss
  project().undo(); // apply
  await expect.poll(() => hook().duration.ideal).toBe(2);
  await expect(page.getByTestId('critique-fix')).toBeVisible();
  expect(await axe(page)).toEqual([]);
});
