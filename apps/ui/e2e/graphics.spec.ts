import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { hashText } from '../src/graphics-view.js';
import { ServiceClient } from '@trailerforge/service/client';
import { startTestService, type TestService } from './support.js';

test.describe.configure({ mode: 'serial' });

let t: TestService;
let client: ServiceClient;
const ID = 'proj_sample';

test.beforeAll(async () => {
  t = await startTestService();
  const store = await t.engine.createProject(
    join(t.root, 'Graphics.tforge'),
    sampleProject() as never,
  );
  // The sample's master timeline stands in for a rough cut (the Cut tab edits `tl_rough`).
  const master = store.state.timelines.find((x) => x.id === 'tl_master')!;
  // (Ids are unique across the project, so the copy's items, tracks and markers get a prefix.)
  const copy = JSON.parse(
    JSON.stringify(master).replace(/"(it_|trk_|tr_|mk_)([a-z0-9_]+)"/g, '"r$1$2"'),
  );
  store.dispatch('core/timeline.set', {
    timeline: { ...copy, id: 'tl_rough', name: 'Rough cut' },
  });
  // The sample's closing section is locked; the editors are disabled while a section is.
  for (const sec of store.state.storyboard!.sections)
    if (sec.locked)
      store.dispatch('core/storyboard.set-section-locked', { sectionId: sec.id, locked: false });
  client = new ServiceClient({ baseUrl: t.svc.url, token: t.svc.token });
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

const undoButton = (page: Page) =>
  page.getByRole('group', { name: 'History' }).getByRole('button', { name: /Undo/ });

test('graphics: pick a template, edit the words, scrub the animation, and the preview is the final frame', async ({
  page,
}) => {
  await page.goto(`${t.svc.url}/p/${ID}/graphics#token=${t.svc.token}`);
  await expect(page.getByRole('heading', { name: 'Graphics', level: 1 })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Cards and on-screen text' });
  await expect(nav.getByRole('button')).toHaveCount(2); // the closing card and the boss name label

  // The closing card: change its template and its words.
  await nav.getByRole('button').first().click();
  const template = page.getByLabel('Template');
  await expect(template).toHaveValue('core/end-slate');
  await template.selectOption('core/cta-card');
  await expect(template).toHaveValue('core/cta-card');
  await page.getByLabel('Text', { exact: true }).fill('Wishlist now');
  await page.getByLabel('Text', { exact: true }).blur();
  await page.getByLabel('Detail').fill('on Steam');
  await page.getByLabel('Detail').blur();
  const frame = page.getByTestId('gfx-preview');
  const scrub = page.getByLabel(/^Time \(/);

  // Early in the animation nothing is on screen yet; later the words are.
  await scrub.fill('0');
  await expect(frame.locator('text')).toHaveCount(0);
  await scrub.fill('1.5');
  await expect(frame).toContainText('Wishlist now');
  await expect(frame).toContainText('on Steam');

  // The preview is the engine's frame: same SVG, at a few times, in each shape.
  for (const at of [0.3, 1.5, 2.8]) {
    await scrub.fill(String(at));
    const mine = await frame.getAttribute('data-frame-hash');
    const theirs = await client.previewTemplate(ID, {
      templateId: 'core/cta-card',
      params: { text: 'Wishlist now', detail: 'on Steam' },
      at,
      seconds: 3,
      size: { width: 1920, height: 1080 },
    });
    expect(mine, `at ${at} s`).toBe(hashText(theirs.svg));
  }
  const shape = page.getByLabel('Shape');
  await shape.selectOption({ label: 'TikTok 9:16' });
  await scrub.fill('1.5');
  const vertical = await client.previewTemplate(ID, {
    templateId: 'core/cta-card',
    params: { text: 'Wishlist now', detail: 'on Steam' },
    at: 1.5,
    seconds: 3,
    size: { width: 1080, height: 1920 },
  });
  expect(await frame.getAttribute('data-frame-hash')).toBe(hashText(vertical.svg));

  // Text that cannot be read in time is named.
  await nav.getByRole('button').nth(1).click();
  await page
    .getByLabel('Text', { exact: true })
    .fill('Parry the Warden at the last possible moment to counter it');
  await page.getByLabel('Text', { exact: true }).blur();
  await expect(page.getByRole('list', { name: 'Problems with this graphic' })).toContainText(
    /reading it takes|set smaller|safe area/,
  );

  expect(await axe(page)).toEqual([]);

  // Everything was a command: undo takes the last edit back.
  await undoButton(page).click();
  await expect(page.getByLabel('Text', { exact: true })).toHaveValue('The Ash Warden');
});

test('cut: effects, a transition into a clip and a sound, all undoable', async ({ page }) => {
  await page.goto(`${t.svc.url}/p/${ID}/cut#token=${t.svc.token}`);
  await page.getByRole('button', { name: /^clip, clip, 0:00\.00 to 0:02\.00$/ }).click();
  const panel = page.getByRole('region', { name: 'Effects, transition and sounds' });

  // An effect from the installed list.
  await panel.getByLabel('Add an effect').selectOption({ label: 'Vignette' });
  await panel.getByRole('button', { name: 'Add effect' }).click();
  await expect(panel.getByRole('button', { name: 'Remove vignette' })).toBeVisible();
  expect(
    (await t.engine.openProject(join(t.root, 'Graphics.tforge'))).state.timelines.find(
      (x) => x.id === 'tl_rough',
    )!.tracks[0]!.items[0],
  ).toMatchObject({ effects: [{ effectId: 'core/vignette' }] });

  // The first clip has nothing before it; the second can take a transition.
  await expect(panel.getByLabel('Transition')).toBeDisabled();
  await page.getByRole('button', { name: /^placeholder, placeholder,/ }).click();
  const second = page.getByRole('region', { name: 'Effects, transition and sounds' });
  await expect(second.getByLabel('Transition')).toHaveValue('core/flash'); // the sample's flash cut
  await second.getByLabel('Transition').selectOption({ label: 'Crossfade' });
  await expect(second.getByLabel('Transition')).toHaveValue('core/crossfade');
  await second.getByLabel('Transition').selectOption({ label: 'Hard cut' });
  await expect(second.getByLabel('Transition')).toHaveValue('');

  // A glitch that flickers fast is refused (the default is slow enough to be allowed).
  await second.getByLabel('Transition').selectOption({ label: 'Glitch' });
  await expect(second.getByLabel('Transition')).toHaveValue('core/glitch');

  // A sound on the shot, placed when the cut is rebuilt.
  await second.getByRole('combobox', { name: 'Sound', exact: true }).selectOption('whoosh');
  await second.getByRole('button', { name: 'Add sound' }).click();
  await expect(second.getByRole('button', { name: 'Remove whoosh sound' }).first()).toBeVisible();
  await expect(second).toContainText('placed on the cut when you rebuild it');

  expect(await axe(page)).toEqual([]);

  await undoButton(page).click();
  await expect(second.getByRole('button', { name: 'Remove whoosh sound' })).toHaveCount(1); // the sample's own cue stays
});
