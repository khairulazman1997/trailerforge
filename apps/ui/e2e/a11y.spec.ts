import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Timeline, flicksPerFrame } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { ServiceClient } from '@trailerforge/service';
import { startTestService, type TestService } from './support.js';

/**
 * The usability pass: every page axe clean (an empty project and a full one), the skip link,
 * the shortcut list against the handlers, errors that say what to do next, and a large project
 * (200 shots, 30 minutes of music) that opens and scrolls without long tasks over 200 ms.
 */

let t: TestService;
test.beforeAll(async () => {
  t = await startTestService();
});
test.afterAll(async () => {
  await t.close();
});

const TABS = [
  '',
  '/brief',
  '/knowledge',
  '/storyboard',
  '/capture',
  '/footage',
  '/cut',
  '/variants',
  '/brand',
  '/graphics',
  '/review',
  '/export',
];

async function axe(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical' || v.id === 'heading-order')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

async function walk(page: Page, base: string, label: string) {
  for (const tab of TABS) {
    await page.goto(`${t.svc.url}${base}${tab}#token=${t.svc.token}`);
    await expect(page.locator('main h1').first()).toBeVisible();
    await page.waitForTimeout(400); // let the tab's own requests settle
    expect(await axe(page), `${label} ${tab || 'overview'}`).toEqual([]);
  }
}

test('every page is axe clean on an empty project and on a full one', async ({ page }) => {
  test.setTimeout(240_000);
  const empty = await t.engine.createProject(join(t.root, 'Empty.tforge'), { name: 'Empty' });
  const full = await t.engine.createProject(join(t.root, 'Full.tforge'), {
    ...sampleProject(),
    id: 'proj_full',
  } as never);
  for (const route of ['/', '/setup', '/settings']) {
    await page.goto(`${t.svc.url}${route}#token=${t.svc.token}`);
    await expect(page.locator('main h1').first()).toBeVisible();
    await page.waitForTimeout(300);
    expect(await axe(page), route).toEqual([]);
  }
  await walk(page, `/p/${empty.state.id}`, 'empty');
  await walk(page, `/p/${full.state.id}`, 'full');
});

test('empty tabs say what to do next, with a link', async ({ page }) => {
  const p = await t.engine.createProject(join(t.root, 'Next.tforge'), { name: 'Next' });
  const base = `${t.svc.url}/p/${p.state.id}`;
  const expectLink = async (tab: string, name: string, lands: string) => {
    await page.goto(`${base}/${tab}#token=${t.svc.token}`);
    await page.getByRole('main').getByRole('link', { name }).first().click();
    await expect(page).toHaveURL(new RegExp(`${lands}$`));
  };
  await expectLink('capture', 'Write the storyboard', 'storyboard');
  await expectLink('cut', 'Open the storyboard', 'storyboard');
  await expectLink('variants', 'Write the storyboard', 'storyboard');
  await expectLink('review', 'Open the Cut tab', 'cut');
  await expectLink('export', 'Open the Cut tab', 'cut');
});

test('the skip link moves focus into the page; shortcuts match the handlers', async ({ page }) => {
  const p = await t.engine.createProject(join(t.root, 'Keys.tforge'), {
    ...sampleProject(),
    id: 'proj_keys',
  } as never);
  const base = `${t.svc.url}/p/${p.state.id}`;
  await page.goto(`${base}#token=${t.svc.token}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // First Tab lands on the skip link, Enter moves focus into the page.
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to the page' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();

  // "?" opens the list; it shows the global keys and, on the Cut tab, the Cut ones.
  await page.locator('main').press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Undo the last change')).toBeVisible();
  await expect(dialog.getByText('Move the selected clip one frame')).toHaveCount(0);
  expect(await axe(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // "?" typed into a text field is just a character.
  await page.goto(`${base}/brief#token=${t.svc.token}`);
  const field = page.getByRole('textbox').first();
  await field.focus();
  await page.keyboard.type('?');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Undo and redo by key, as listed: rename the project (a command), then Ctrl+Z / Ctrl+Y.
  await page.goto(`${base}#token=${t.svc.token}`);
  const title = page.locator('h1 input');
  const name0 = await title.inputValue();
  await new ServiceClient({ baseUrl: t.svc.url, token: t.svc.token }).command(
    p.state.id,
    'core/project.rename',
    { name: 'Renamed' },
  );
  await expect(title).toHaveValue('Renamed');
  await page.locator('main').focus();
  await page.keyboard.press('Control+z');
  await expect(title).toHaveValue(name0);
  await page.keyboard.press('Control+y');
  await expect(title).toHaveValue('Renamed');
  await page.keyboard.press('Control+z');
  await expect(title).toHaveValue(name0);
  await page.keyboard.press('Control+Shift+z');
  await expect(title).toHaveValue('Renamed');

  // The Cut tab's list is the one shown there (the arrow keys themselves: cut-drag.spec.ts).
  await page.goto(`${base}/cut#token=${t.svc.token}`);
  await page.getByRole('button', { name: 'Shortcuts' }).click();
  const cut = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(cut.getByText('Move the selected clip one frame')).toBeVisible();
  await expect(cut.getByText('to the previous or next beat')).toBeVisible();
  await expect(cut.getByText('and the clips after it along').first()).toBeVisible();
});

// ---- a large project ----

const R = { num: 30, den: 1 };
const FPF = flicksPerFrame(R);
const SHOTS = 200;

function largeProject() {
  const base = sampleProject();
  const sb = base.storyboard!;
  sb.sections!.splice(1, 0, {
    id: 'sec_big',
    name: 'Gameplay',
    role: 'escalation',
    slots: Array.from({ length: SHOTS }, (_, i) => ({
      id: `shot_big_${i}`,
      kind: 'shot' as const,
      title: `Shot ${i + 1}`,
      purpose: 'A moment of play',
      duration: { min: 1, ideal: 1.5, max: 3 },
      captureInstruction: 'Record about ten seconds.',
      location: 'Forest',
      hud: 'off' as const,
    })),
  } as never);
  const music = 1800 * 30 * FPF; // 30 minutes
  const timeline = Timeline.parse({
    id: 'tl_rough',
    name: 'Rough cut',
    frameRate: R,
    resolution: { width: 1920, height: 1080 },
    tracks: [
      {
        id: 'v1',
        kind: 'video',
        name: 'Picture',
        items: Array.from({ length: SHOTS }, (_, i) => ({
          id: `it_${i}`,
          kind: 'placeholder',
          label: `Shot ${i + 1}`,
          start: i * 30 * FPF,
          duration: 30 * FPF,
          reason: 'missing-footage',
        })),
      },
      {
        id: 'a1',
        kind: 'audio',
        name: 'Music',
        items: [
          {
            id: 'it_music',
            kind: 'clip',
            assetId: 'asset_music',
            start: 0,
            duration: music,
            sourceIn: 0,
          },
        ],
      },
    ],
    markers: Array.from({ length: 900 }, (_, i) => ({
      id: `mk_${i}`,
      at: i * 60 * FPF,
      kind: 'downbeat',
      label: '',
    })),
  });
  return { ...base, id: 'proj_large', storyboard: sb, timelines: [timeline] };
}

test('a large project opens and scrolls without a long task over 200 ms', async ({ page }) => {
  test.setTimeout(240_000);
  const p = await t.engine.createProject(join(t.root, 'Large.tforge'), largeProject() as never);
  await page.addInitScript(() => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__long.push(Math.round(e.duration));
    }).observe({ type: 'longtask', buffered: true });
  });
  const base = `/p/${p.state.id}`;
  await page.goto(`${t.svc.url}${base}#token=${t.svc.token}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForTimeout(500);
  const long = () =>
    page.evaluate(() => (window as unknown as { __long: number[] }).__long.splice(0));
  await long(); // the first load is the bundle, not the project

  const report: Record<string, number> = {};
  const labels: Record<string, string> = { variants: 'versions' };
  for (const tab of ['storyboard', 'capture', 'footage', 'cut', 'variants', 'graphics']) {
    const label = labels[tab] ?? tab;
    await page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: new RegExp(`^${label}`, 'i') }).first().click(); // prettier-ignore
    await expect(page.locator('main h1').first()).toBeVisible();
    await page.waitForTimeout(600);
    // Scroll to the bottom in steps, as a person would.
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(80);
    }
    const found = await long();
    report[tab] = Math.max(0, ...found);
  }
  console.log('longest task per tab (ms):', JSON.stringify(report));
  for (const [tab, ms] of Object.entries(report)) expect(ms, tab).toBeLessThan(200);
  // The cut really has the whole project in it.
  await page
    .getByRole('navigation', { name: 'Project sections' })
    .getByRole('link', { name: /^cut/i })
    .click();
  await expect(page.locator('[data-item-id="it_199"]')).toHaveCount(1);
});
