import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.js';

let home: string;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tforge-cliplan-'));
  home = join(root, 'home');
});

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...args, '--home', home], { out: (l) => out.push(l), err: (l) => err.push(l) }); // prettier-ignore
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('tforge planner and projects', { timeout: 60_000 }, () => {
  it('starts empty and says how to begin', async () => {
    const r = await run(['planner', 'show']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Nothing planned yet/);
    expect((await run(['projects'])).out).toBe('No projects yet.');
  });

  it('plans a campaign and a video, moves it, and makes the project', async () => {
    expect((await run(['planner', 'campaign-add', 'cmp_cli', '--name', 'CLI launch'])).code).toBe(
      0,
    );
    const add = await run([
      'planner', 'slot-add', 'cal_cli',
      '--title', 'CLI trailer', '--date', '2026-12-01',
      '--campaign', 'cmp_cli', '--platform', 'core/youtube,core/tiktok',
    ]); // prettier-ignore
    expect(add.code).toBe(0);
    expect(add.out).toMatch(
      /2026-12-01 {2}cal_cli {2}CLI trailer {2}core\/youtube, core\/tiktok {2}cmp_cli {2}no project yet/,
    );
    expect((await run(['planner', 'slot-move', 'cal_cli', '--date', '2026-12-08'])).out).toMatch(
      /2026-12-08 {2}cal_cli/,
    );

    const dir = join(root, 'Planned.tforge');
    const made = await run(['planner', 'create-project', 'cal_cli', '--dir', dir]);
    expect(made.code).toBe(0);
    expect(made.out).toMatch(/versions: fmt_core_youtube, fmt_core_tiktok/);

    const shown = await run(['planner', 'show', '--json']);
    const view = JSON.parse(shown.out) as {
      slots: { project: { name: string; status: string; scheduledDate: string } | null }[];
    };
    expect(view.slots[0]!.project).toMatchObject({
      name: 'CLI trailer',
      status: 'idea',
      scheduledDate: '2026-12-08',
    });
    expect((await run(['projects'])).out).toContain(`CLI trailer  ${dir.replace(/\//g, '\\')}`.replace(/\\/g, process.platform === 'win32' ? '\\' : '/')); // prettier-ignore
  });

  it('explains mistakes with exit 2 and forgets a project without touching it', async () => {
    const noTitle = await run(['planner', 'slot-add', '--date', '2026-12-01']);
    expect(noTitle.code).toBe(2);
    expect(noTitle.err).toMatch(/--title is required/);
    const unknown = await run(['planner', 'nope']);
    expect(unknown.code).toBe(2);
    expect((await run(['planner', 'create-project', 'cal_none'])).code).toBe(1);
    expect((await run(['planner', 'create-project'])).code).toBe(2);

    const dir = join(root, 'Planned.tforge');
    expect((await run(['projects', 'forget', dir])).code).toBe(0);
    expect((await run(['projects'])).out).toBe('No projects yet.');
    expect((await run(['projects', 'forget', dir])).code).toBe(1);
  });
});
