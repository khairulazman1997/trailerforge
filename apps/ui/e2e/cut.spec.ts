import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FLICKS_PER_SECOND } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { ServiceClient } from '@trailerforge/service';
import { startTestService, type TestService } from './support.js';

let t: TestService;
let client: ServiceClient;
const ID = 'proj_sample';

const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

test.beforeAll(async () => {
  t = await startTestService();
  client = new ServiceClient({ baseUrl: t.svc.url, token: t.svc.token });
  await t.engine.createProject(join(t.root, 'Cut.tforge'), sampleProject() as never);
  const rec = join(t.root, 'rec');
  mkdirSync(rec);
  for (const [name, title] of [
    ['alpha.mp4', 'a'],
    ['bravo.mp4', 'b'],
  ] as const) {
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x180:r=30:d=8',
      '-metadata',
      `title=${title}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      join(rec, name),
    ]);
  }
  ff([
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='if(lt(mod(t-0.25\\,0.5)\\,0.01)*gte(t\\,0.25)\\,sin(2*PI*2000*t)\\,0)':s=44100:d=30",
    join(rec, 'song.wav'),
  ]);
  await client.importFootage(ID, [rec]);
  for (let i = 0; i < 600; i++) {
    const s = await client.footage(ID);
    if (s.footage.length === 2 && s.music.length === 1 && s.jobs.running + s.jobs.queued === 0) {
      // both recordings are takes of the first shot
      for (const f of s.footage)
        await client.command(ID, 'core/takes.attach', {
          slotId: 'shot_parry',
          assetId: f.assetId,
          matchedBy: 'manual',
        });
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('import did not finish');
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

test('choose music, analyse, build the cut, inspect, trim, swap, lock, rebuild, play, undo', async ({
  page,
}) => {
  await page.goto(`${t.svc.url}/p/${ID}/cut#token=${t.svc.token}`);
  await expect(page.getByRole('heading', { name: 'Cut', level: 1 })).toBeVisible();
  const status = page.getByTestId('cut-status');
  await expect(status).toContainText('Choose the music track');
  await expect(page.getByRole('button', { name: 'Build the cut' })).toBeDisabled();

  await page.getByLabel('Music track').selectOption({ label: 'song.wav' });
  await expect(status).toContainText('has not been analysed');
  await page.getByRole('button', { name: 'Analyse the music and recordings' }).click();
  await expect(status).toContainText('Music analysed', { timeout: 90_000 });
  await page.getByRole('button', { name: 'Build the cut' }).click();

  // The picture: the shot with takes is a clip, the unrecorded one a placeholder, plus the card.
  const picture = page.getByRole('group', { name: 'Picture track' });
  const parry = picture.getByRole('button', { name: /^Perfect parry, clip,/ });
  await expect(parry).toBeVisible();
  await expect(picture.getByRole('button', { name: /^Boss reveal, placeholder,/ })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Music track' })).toBeVisible();
  // The boss shot's on-screen text from the storyboard sits over it, and shows in the preview.
  const captions = page.getByRole('group', { name: 'Captions track' });
  await expect(captions.getByRole('button', { name: /^The Ash Warden, caption,/ })).toBeVisible();
  const cut = [...t.engine.projects.values()]
    .find((s) => s.state.id === ID)!
    .state.timelines.find((x) => x.tracks.some((k) => k.kind === 'caption'))!;
  const cap = cut.tracks.flatMap((k) => k.items).find((i) => i.kind === 'caption')!;
  const perFrame = (FLICKS_PER_SECOND * cut.frameRate.den) / cut.frameRate.num;
  await page.getByLabel('Playhead').fill(String(Math.round(cap.start / perFrame) + 1));
  await expect(page.getByTestId('cut-caption')).toHaveText('The Ash Warden');
  await page.getByLabel('Playhead').fill('0');
  await expect(page.getByTestId('cut-caption')).toHaveCount(0);
  const before = await parry.getAttribute('aria-label');

  // Why: the reason the cut gave, in words.
  await parry.click();
  await expect(page.getByRole('heading', { name: 'Perfect parry', level: 2 })).toBeVisible();
  await expect(page.getByTestId('cut-why')).toContainText('best of 2 takes');
  // Picking it moves the preview to its start.
  const parryItem = cut.tracks.flatMap((k) => k.items).find((i) => i.label === 'Perfect parry')!;
  await expect(page.getByLabel('Playhead')).toHaveValue(
    String(Math.round(parryItem.start / perFrame)),
  );

  // The source recording: slip the used part a frame later, keeping the clip in place; a
  // frame off its end handle trims the clip. Undo walks both back.
  const source = page.getByRole('group', { name: 'Source recording' });
  const used = source.getByTestId('src-window');
  const usedBefore = await used.textContent();
  await source.getByRole('slider', { name: 'Used part of the recording' }).press('ArrowRight');
  await expect(used).not.toHaveText(usedBefore!);
  await expect(parry).toHaveAttribute('aria-label', before!);
  await source.getByRole('slider', { name: 'Source end' }).press('ArrowLeft');
  await expect(parry).not.toHaveAttribute('aria-label', before!);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(parry).toHaveAttribute('aria-label', before!);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(used).toHaveText(usedBefore!);

  // The trimmer stages a re-cut: Cancel leaves the cut alone, Done applies it as one undo step.
  await source.getByRole('button', { name: 'Open the trimmer…' }).click();
  let trimmer = page.getByRole('dialog', { name: 'Trim Perfect parry' });
  await trimmer.getByRole('slider', { name: 'Source end' }).press('Shift+ArrowLeft');
  await expect(trimmer.getByTestId('trim-length')).toContainText('(was');
  expect(await axe(page)).toEqual([]);
  await trimmer.getByRole('button', { name: 'Cancel' }).click();
  await expect(trimmer).toHaveCount(0);
  await expect(parry).toHaveAttribute('aria-label', before!);
  await source.getByRole('button', { name: 'Open the trimmer…' }).click();
  trimmer = page.getByRole('dialog', { name: 'Trim Perfect parry' });
  await trimmer.getByRole('slider', { name: 'Source start' }).press('ArrowRight');
  await trimmer.getByRole('slider', { name: 'Source end' }).press('Shift+ArrowLeft');
  await trimmer.getByRole('button', { name: 'Done' }).click();
  await expect(trimmer).toHaveCount(0);
  await expect(parry).not.toHaveAttribute('aria-label', before!);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(parry).toHaveAttribute('aria-label', before!);
  await expect(used).toHaveText(usedBefore!);

  // Longer: typed in seconds, it takes the time from the next item, so the end of the cut stays.
  const length = page.getByRole('group', { name: 'Length' });
  const seconds = length.getByLabel('Seconds');
  const was = Number(await seconds.inputValue());
  const lastEnd = async () =>
    (await picture.getByRole('button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')))).at(-1)?.split(' to ')[1]; // prettier-ignore
  const endBefore = await lastEnd();
  await seconds.fill(String(was + 0.5));
  await seconds.press('Enter');
  await expect(parry).not.toHaveAttribute('aria-label', before!);
  await expect(length.getByLabel('Seconds')).toHaveValue(String(+(was + 0.5).toFixed(3)));
  expect(await lastEnd()).toBe(endBefore);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(parry).toHaveAttribute('aria-label', before!);

  // Trim the end by a frame: the clip's timecode changes; undo puts it back.
  await page
    .getByRole('group', { name: 'Trim the end' })
    .getByRole('button', { name: '1 frame earlier' })
    .click();
  await expect(parry).not.toHaveAttribute('aria-label', before!);
  const trimmed = await parry.getAttribute('aria-label');
  await page
    .getByRole('group', { name: 'Trim the end' })
    .getByRole('button', { name: 'To the next beat' })
    .click();
  await expect(parry).not.toHaveAttribute('aria-label', trimmed!);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  // quick trims of the same edge are one undo step, so this goes back to how the cut was built
  await expect(parry).toHaveAttribute('aria-label', before!);

  // Swap to the other take.
  const take = page.getByLabel(/^Take/);
  const current = await take.inputValue();
  const other = (
    await take.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))
  ).find((v) => v !== current)!;
  await take.selectOption(other);
  await expect(take).toHaveValue(other);

  // A locked track cannot be edited.
  await picture.getByRole('button', { name: /^Lock/ }).click();
  await expect(
    page
      .getByRole('group', { name: 'Trim the end' })
      .getByRole('button', { name: '1 frame earlier' }),
  ).toBeDisabled();
  await picture.getByRole('button', { name: /^Unlock/ }).click();
  await expect(
    page
      .getByRole('group', { name: 'Trim the end' })
      .getByRole('button', { name: '1 frame earlier' }),
  ).toBeEnabled();

  // Rebuilding keeps the hand edit.
  const preEdit = await parry.getAttribute('aria-label');
  await page
    .getByRole('group', { name: 'Trim the end' })
    .getByRole('button', { name: '1 frame earlier' })
    .click();
  await expect(parry).not.toHaveAttribute('aria-label', preEdit!); // wait for the trim to land
  const edited = await parry.getAttribute('aria-label');
  // More of the song: the music runs a bar past the picture, and a rebuild keeps that.
  const musicItem = page
    .getByRole('group', { name: 'Music track' })
    .getByRole('button', { name: /^Music, clip,/ });
  const musicBefore = await musicItem.getAttribute('aria-label');
  await musicItem.click();
  const musicLength = page.getByRole('group', { name: 'Music length' });
  await musicLength.getByRole('button', { name: 'Longer by a bar' }).click();
  await expect(musicItem).not.toHaveAttribute('aria-label', musicBefore!);
  await expect(musicLength.getByTestId('music-past-picture')).toBeVisible();
  const musicLonger = await musicItem.getAttribute('aria-label');
  await page.getByRole('button', { name: 'Rebuild the cut' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Rebuild' }).click();
  await expect(page.getByTestId('cut-status')).toBeVisible();
  await expect(parry).toHaveAttribute('aria-label', edited!);
  await expect(musicItem).toHaveAttribute('aria-label', musicLonger!);
  await musicLength.getByRole('button', { name: 'End with the picture' }).click();
  await expect(musicItem).toHaveAttribute('aria-label', musicBefore!);

  // Play: the clock follows the music.
  const time = page.getByTestId('cut-time');
  await page.getByLabel('Playhead').fill('0');
  await expect(time).toContainText('0:00.00 /');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect
    .poll(async () => (await time.textContent())!.split(' / ')[0], { timeout: 10_000 })
    .not.toBe('0:00.00');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  expect(await axe(page)).toEqual([]);
});

test('without a storyboard or music the page says what to do first', async ({ page }) => {
  await t.engine.createProject(join(t.root, 'Bare.tforge'), {
    name: 'Bare',
    id: 'proj_bare',
  } as never);
  await page.goto(`${t.svc.url}/p/proj_bare/cut#token=${t.svc.token}`);
  await expect(page.getByText('Make a storyboard first')).toBeVisible();
});
