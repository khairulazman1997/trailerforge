import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { ServiceClient } from '@trailerforge/service';
import { startTestService, type TestService } from './support.js';

const ID = 'proj_sample';
const GROUP = 'Forest · The Ash Warden';

/** The sample, with both shots in one group and an excluded level named in a shot's text. */
function project() {
  const p = sampleProject() as unknown as {
    storyboard: { sections: { slots: Record<string, unknown>[] }[] };
    knowledge: { id: string; excludedFromLlm?: boolean }[];
  };
  const parry = p.storyboard.sections[0]!.slots[0]!;
  parry.entityIds = ['ent_warden'];
  parry.captureInstruction = 'Start in the Cinder Forest (ent_forest) and parry the Warden.';
  p.knowledge.find((e) => e.id === 'ent_forest')!.excludedFromLlm = true;
  return p;
}

let t: TestService;
let client: ServiceClient;
const open = (page: Page) => page.goto(`${t.svc.url}/p/${ID}/capture#token=${t.svc.token}`);
const tips = (page: Page) => page.getByRole('region', { name: `Tips for ${GROUP}` });

test.describe('tips and export', () => {
  test.beforeAll(async () => {
    t = await startTestService();
    client = new ServiceClient({ baseUrl: t.svc.url, token: t.svc.token });
    await t.engine.createProject(join(t.root, 'Tips.tforge'), project() as never);
  });
  test.afterAll(async () => {
    await t.close();
  });

  test('write tips after seeing what is sent, edit them, keep edits, go stale, remove', async ({
    page,
  }) => {
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    await open(page);
    await expect(tips(page)).toContainText('No tips yet.');

    // The disclosure describes the recording plan, not the brief, and nothing is sent before Write.
    await page.getByRole('button', { name: 'Write tips for every group…' }).click();
    const dialog = page.getByRole('dialog');
    const disclosure = dialog.getByTestId('disclosure');
    await expect(disclosure).toContainText('Recording plan: 1 group with 2 shots');
    await expect(disclosure).toContainText('this stays on your computer');
    await expect(disclosure).not.toContainText('Brief:');
    expect(t.prompts.filter((p) => p.includes('capture'))).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Write tips' }).click();

    await expect(tips(page)).toContainText('Start from the checkpoint.');
    await expect(tips(page)).toContainText('An autosave popup can ruin a take.');
    await expect(tips(page).locator('.chip')).toHaveText('Up to date');

    // Nothing about the excluded level reached the model.
    const sent = t.prompts.at(-1)!.toLowerCase();
    expect(sent).toContain('[redacted]');
    for (const secret of ['cinder forest', 'ent_forest']) expect(sent).not.toContain(secret);

    // Edit by hand: marked as yours, and writing again keeps it unless you say otherwise.
    await tips(page).getByRole('button', { name: 'Edit' }).click();
    await tips(page)
      .getByLabel('Tips (one per line)')
      .fill('Use the arena checkpoint\nTurn music off');
    await tips(page).getByRole('button', { name: 'Save tips' }).click();
    await expect(tips(page).locator('.chip')).toHaveText('Edited by you');
    await expect(tips(page)).toContainText('Turn music off');

    await tips(page).getByRole('button', { name: 'Write again…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Write tips' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(tips(page)).toContainText('Use the arena checkpoint');

    await tips(page).getByRole('button', { name: 'Write again…' }).click();
    await page.getByLabel('Replace tips I edited by hand').check();
    await page.getByRole('dialog').getByRole('button', { name: 'Write tips' }).click();
    await expect(tips(page)).toContainText('Start from the checkpoint.');
    await expect(tips(page).locator('.chip')).toHaveText('Up to date');

    // Changing a shot in the group makes the tips out of date.
    await client.command(ID, 'core/storyboard.update-slot', {
      slotId: 'shot_boss',
      patch: { captureInstruction: 'Wait for the cinematic, then walk in.' },
    });
    await expect(tips(page).locator('.chip')).toHaveText('Out of date');
    await expect(tips(page)).toContainText('changed since these were written');

    // Remove, and undo brings them back.
    await tips(page).getByRole('button', { name: 'Remove' }).click();
    await expect(tips(page)).toContainText('No tips yet.');
    await page.getByRole('button', { name: /Undo/ }).first().click();
    await expect(tips(page)).toContainText('Start from the checkpoint.');
    expect(problems).toEqual([]);
  });

  test('write the pack to the project folder, or save a copy; sharing leaves excluded facts out', async ({
    page,
  }) => {
    await open(page);
    const panel = page.getByRole('region', { name: 'Share the pack' });

    await panel.getByRole('checkbox', { name: 'Printable page' }).uncheck();
    await panel.getByRole('button', { name: 'Write to the project folder' }).click();
    const result = page.getByTestId('cap-export-result');
    await expect(result).toContainText('exports/capture/capture-pack.md');
    await expect(result).toContainText('exports/capture/capture-pack.json');
    await expect(result).not.toContainText('capture-pack.html');
    const md = await readFile(
      join(t.root, 'Tips.tforge', 'exports', 'capture', 'capture-pack.md'),
      'utf8',
    );
    expect(md).toContain('[ ] **Perfect parry**');

    // Save a copy: the browser's own download, the same path the desktop app's save dialog uses.
    const [full] = await Promise.all([
      page.waitForEvent('download'),
      panel.getByRole('button', { name: 'Download Markdown' }).click(),
    ]);
    expect(full.suggestedFilename()).toBe('capture-pack.md');
    expect(await readFile((await full.path())!, 'utf8')).toContain('Cinder Forest');

    await panel.getByRole('checkbox', { name: /Leave out anything about game facts/ }).check();
    const [shared] = await Promise.all([
      page.waitForEvent('download'),
      panel.getByRole('button', { name: 'Download Data file' }).click(),
    ]);
    expect(shared.suggestedFilename()).toBe('capture-pack.json');
    const json = await readFile((await shared.path())!, 'utf8');
    expect(JSON.parse(json)).toMatchObject({ format: 'trailerforge.capture-pack', version: 1 });
    expect(json).not.toContain('Cinder Forest');
  });
});

test('a provider that sends data off this computer needs an explicit yes before tips are written', async ({
  page,
}) => {
  const remote = await startTestService({ offDevice: true });
  try {
    await remote.engine.createProject(join(remote.root, 'Remote.tforge'), project() as never);
    await page.goto(`${remote.svc.url}/p/${ID}/capture#token=${remote.svc.token}`);
    await page.getByRole('button', { name: 'Write tips for every group…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('disclosure')).toContainText('this leaves your computer');
    const write = dialog.getByRole('button', { name: 'Write tips' });
    await expect(write).toBeDisabled();
    await dialog.getByLabel(/I understand this information is sent to/).check();
    await write.click();
    await expect(page.getByRole('region', { name: `Tips for ${GROUP}` })).toContainText(
      'Start from the checkpoint.',
    );
  } finally {
    await remote.close();
  }
});
