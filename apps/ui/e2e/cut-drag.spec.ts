import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Timeline, flicksPerFrame, type Timeline as T } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { ServiceClient } from '@trailerforge/service';
import { startTestService, type TestService } from './support.js';

/** Drag editing on the Cut timeline: moves, trims, ripple, snapping, refusals, keys and undo. */

let t: TestService;
let client: ServiceClient;
const ID = 'proj_sample';
const R = { num: 30, den: 1 };
const FPF = flicksPerFrame(R);
const fr = (n: number) => n * FPF;

// Three placeholders on the picture track, an empty second picture track and a bar at 4.5 s
// (its cut point, one frame ahead, is frame 134).
const start = () =>
  Timeline.parse({
    id: 'tl_rough', name: 'Rough cut', frameRate: R, resolution: { width: 1920, height: 1080 },
    tracks: [
      { id: 'v1', kind: 'video', name: 'Picture', items: [
        { id: 'a', kind: 'placeholder', label: 'Parry', start: 0, duration: fr(60), reason: 'missing-footage' },
        { id: 'b', kind: 'placeholder', label: 'Boss', start: fr(60), duration: fr(60), reason: 'missing-footage' },
        { id: 'c', kind: 'placeholder', label: 'Fall', start: fr(150), duration: fr(60), reason: 'missing-footage' },
      ] },
      { id: 'v2', kind: 'video', name: 'Over', items: [] },
    ],
    markers: [{ id: 'm1', at: fr(135), kind: 'downbeat', label: '' }],
  }); // prettier-ignore

test.beforeAll(async () => {
  t = await startTestService();
  client = new ServiceClient({ baseUrl: t.svc.url, token: t.svc.token });
  await t.engine.createProject(join(t.root, 'Drag.tforge'), sampleProject() as never);
  await client.command(ID, 'core/timeline.set', { timeline: start() });
});
test.afterAll(async () => {
  await t.close();
});

async function timeline(): Promise<T> {
  const store = [...t.engine.projects.values()].find((s) => s.state.id === ID)!;
  return Promise.resolve(store.state.timelines.find((x) => x.id === 'tl_rough')!);
}
/** Wait until the timeline differs from `before` (the drop or key press reached the engine). */
const changedFrom = async (before: string) =>
  expect.poll(async () => JSON.stringify(await timeline())).not.toBe(before);
const at = (tl: T, id: string) => {
  for (const track of tl.tracks) {
    const it = track.items.find((i) => i.id === id);
    if (it) return { track: track.id, start: it.start / FPF, end: (it.start + it.duration) / FPF };
  }
  throw new Error(`no ${id}`);
};

/** The screen x of a timeline position (frames) on a track's lane, with the current length. */
async function xOf(page: Page, frames: number, track = 'v1'): Promise<{ x: number; y: number }> {
  const tl = await timeline();
  const total = Math.max(...tl.tracks.flatMap((k) => k.items.map((i) => i.start + i.duration)));
  const lane = page.locator(`[data-track-id="${track}"]`);
  await lane.scrollIntoViewIfNeeded();
  const box = (await lane.boundingBox())!;
  return { x: box.x + (box.width * fr(frames)) / total, y: box.y + box.height / 2 };
}

async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  key?: 'Shift' | 'Alt',
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  if (key) await page.keyboard.down(key);
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  if (key) await page.keyboard.up(key);
}

test('drag to a bar, trim an edge, ripple, refused overlap, another track, keys, undo', async ({
  page,
}) => {
  await page.goto(`${t.svc.url}/p/${ID}/cut#token=${t.svc.token}`);
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible();
  const note = page.getByTestId('cut-drag-note');
  let snap = JSON.stringify(await timeline());
  const settled = async () => {
    await changedFrom(snap);
    snap = JSON.stringify(await timeline());
  };

  // 1. Move "Fall" left near the bar: it snaps to the bar's cut point (frame 134).
  await drag(page, await xOf(page, 180), await xOf(page, 180 - 15.4));
  await settled();
  expect(at(await timeline(), 'c')).toEqual({ track: 'v1', start: 134, end: 194 });
  await expect(note).toContainText('on a bar');

  // 2. Trim the end of "Parry" back freely (Alt): it gets shorter, nothing else moves.
  await drag(page, await xOf(page, 59.6), await xOf(page, 40), 'Alt');
  await settled();
  let tl = await timeline();
  expect(at(tl, 'a').start).toBe(0);
  expect(at(tl, 'a').end).toBeGreaterThan(30);
  expect(at(tl, 'a').end).toBeLessThan(55);
  expect(at(tl, 'b')).toMatchObject({ start: 60, end: 120 });

  // 3. Ripple-trim the end of "Boss" later (Shift + Alt for a free length): "Fall" moves along.
  const gap = at(tl, 'c').start - at(tl, 'b').end;
  await page.keyboard.down('Alt');
  await drag(page, await xOf(page, 119.6), await xOf(page, 128), 'Shift');
  await page.keyboard.up('Alt');
  await settled();
  tl = await timeline();
  expect(at(tl, 'b').end).toBeGreaterThan(120);
  expect(at(tl, 'c').start - at(tl, 'b').end).toBe(gap);

  // 4. Without ripple, dropping "Boss" onto "Fall" is refused and says why; nothing changes.
  const before = JSON.stringify(await timeline());
  const b = at(tl, 'b');
  await drag(page, await xOf(page, (b.start + b.end) / 2), await xOf(page, at(tl, 'c').start + 10), 'Alt'); // prettier-ignore
  await expect(note).toContainText(`Can't drop "Boss" there: it would overlap "Fall"`);
  expect(JSON.stringify(await timeline())).toBe(before);

  // 5. Drag "Parry" down onto the "Over" track.
  const a = at(tl, 'a');
  const from = await xOf(page, (a.start + a.end) / 2);
  await drag(page, from, { x: from.x, y: (await xOf(page, 0, 'v2')).y });
  await settled();
  expect(at(await timeline(), 'a').track).toBe('v2');

  // 6. Keys: select "Fall", one frame right, then Shift+left to the bar's cut point.
  const fall = page.locator('[data-item-id="c"]');
  await fall.click();
  await fall.focus();
  const c0 = at(await timeline(), 'c').start;
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => at(await timeline(), 'c').start).toBe(c0 + 1);
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(async () => at(await timeline(), 'c').start).toBe(134);

  expect(await axe(page)).toEqual([]);

  // 7. Undo walks the changes back to the start (the two quick key moves are one step).
  let steps = 0;
  while (JSON.stringify(await timeline()) !== JSON.stringify(start()) && steps < 8) {
    const was = JSON.stringify(await timeline());
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await changedFrom(was);
    steps++;
  }
  expect(steps).toBeGreaterThanOrEqual(5);
  expect(steps).toBeLessThanOrEqual(6);
  expect(await timeline()).toEqual(start());
});

async function axe(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical' || v.id === 'heading-order')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}
