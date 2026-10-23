import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractorContext, RepoAccessError } from './context.js';
import { genericExtractor, parseCsv } from './generic.js';
import { nodeRepoFs, scanRepo, type RepoFs } from './scan.js';
import { isSecretPath } from './secrets.js';

const SECRET = 'TOP-SECRET-VALUE';

/** A small game repo, written fresh for each run so no secret-looking files live in git. */
const FILES: Record<string, string | Buffer> = {
  'README.md':
    '# Ember Knight\n\n![logo](logo.png)\n\nA soulslike about parrying fire.\n\n## Bosses\n- **The Ash Warden** — second-act boss with two phases\n',
  '.gitignore': 'Builds/\n*.log\n',
  'docs/GDD.md':
    '# Design\n\n## Levels\n- Cinder Forest: burning woods\n- Glass Caverns\n\n## Abilities\n### Perfect Parry\nDeflect any blow.\n\n## Story\n- Not an entity list\n',
  'docs/notes/.gitignore': 'drafts/\n',
  'docs/notes/drafts/idea.md': '## Bosses\n- Draft Boss\n',
  'Localization/strings.csv':
    'Key,English,French\nboss.ash_warden.name,The Ash Warden,Le Gardien\nboss.ash_warden.desc,"Guards the forest, ""burns""",\nui.menu.title,Main Menu,Menu\nlevel.forest.title,Cinder Forest,Forêt\n',
  'Localization/en.json': JSON.stringify({
    items: { ember_blade: { name: 'Ember Blade', description: 'A sword' } },
  }),
  'Localization/fr.json': JSON.stringify({ items: { ember_blade: { name: 'Lame de braise' } } }),
  'Localization/game.po': 'msgctxt "enemy.husk.name"\nmsgid "Ash Husk"\nmsgstr "Cosse"\n',
  'Data/achievements.json': JSON.stringify({
    achievements: [{ displayName: 'Untouchable', description: 'Beat a boss without damage' }],
  }),
  'Assets/Scripts/Player.cs': 'class Player {}',
  'Builds/game.txt': 'ignored build output',
  'debug.log': 'ignored log',
  'Art/huge.txt': 'x'.repeat(2048),
  'Art/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  'Art/blob.dat2': Buffer.from([1, 0, 2, 3]),
  'Audio/theme.ogg.txt': 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n',
  'Vendor/lib.txt': 'excluded by glob',
  // Secrets: must never be opened.
  '.env': `API=${SECRET}`,
  'config/.env.production': SECRET,
  'config/steam_api_key.txt': SECRET,
  'Keys/release.keystore': SECRET,
  'Keys/signing.pem': SECRET,
  'ci/credentials.json': SECRET,
  '.ssh/id_ed25519': SECRET,
  'secrets/anything.md': SECRET,
  'Assets/google-services.json': SECRET,
};

let root: string;
let outside: string;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'tforge-repo-'));
  root = join(base, 'game');
  outside = join(base, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'private.md'), SECRET);
  for (const [p, content] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), content);
  }
  await symlink(outside, join(root, 'linked'));
});

/** Wraps the real fs and records every path whose metadata or contents were touched. */
function recordingFs() {
  const touched: string[] = [];
  const reads: string[] = [];
  const rel = (p: string) => relative(root, p).split('\\').join('/');
  const fs: RepoFs = {
    readdir: (p) => nodeRepoFs.readdir(p),
    lstat: (p) => (touched.push(rel(p)), nodeRepoFs.lstat(p)),
    readFile: (p) => (touched.push(rel(p)), reads.push(rel(p)), nodeRepoFs.readFile(p)),
    readHead: (p, n) => (touched.push(rel(p)), reads.push(rel(p)), nodeRepoFs.readHead(p, n)),
  };
  return { fs, touched, reads };
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    out[relative(dir, p)] = `${(await stat(p)).mtimeMs}:${await readFile(p, 'base64')}`;
  }
  return out;
}

const opts = { exclude: ['Vendor/**'], maxFileBytes: 1024 };

describe('scanRepo', () => {
  it('accepts only readable text files and says why everything else was skipped', async () => {
    const r = await scanRepo(root, opts);
    expect(r.files).toEqual([
      'Assets/Scripts/Player.cs',
      'Data/achievements.json',
      'Localization/en.json',
      'Localization/fr.json',
      'Localization/game.po',
      'Localization/strings.csv',
      'README.md',
      'docs/GDD.md',
    ]);
    const reason = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
    expect(reason).toMatchObject({
      'Builds/': 'gitignored',
      'debug.log': 'gitignored',
      'docs/notes/drafts/': 'gitignored', // nested .gitignore
      'Vendor/': 'excluded',
      'Art/huge.txt': 'too-large',
      'Art/logo.png': 'binary',
      'Art/blob.dat2': 'binary', // NUL byte sniffed
      'Audio/theme.ogg.txt': 'lfs-pointer',
      linked: 'symlink',
      '.env': 'secret',
      'config/.env.production': 'secret',
      'config/steam_api_key.txt': 'secret',
      'Keys/release.keystore': 'secret',
      'Keys/signing.pem': 'secret',
      'ci/credentials.json': 'secret',
      '.ssh/': 'secret',
      'secrets/': 'secret',
      'Assets/google-services.json': 'secret',
    });
    expect(r.changed).toEqual(r.files);
    expect(r.digestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('never opens or stats secret files, even when include globs ask for them', async () => {
    const { fs, touched } = recordingFs();
    const r = await scanRepo(root, { ...opts, include: ['**'], fs });
    expect(r.files.some(isSecretPath)).toBe(false);
    const leaked = touched.filter((p) => isSecretPath(p) || p.startsWith('..'));
    expect(leaked).toEqual([]);
    expect(touched).not.toContain('Art/logo.png'); // binary by extension: never opened
    // Nothing that was read can contain the secret marker.
    for (const p of touched.filter((t) => !t.endsWith('.gitignore'))) {
      expect((await readFile(join(root, p), 'utf8')).includes(SECRET)).toBe(false);
    }
  });

  it('is read-only', async () => {
    const before = await snapshot(root);
    await scanRepo(root, opts);
    expect(await snapshot(root)).toEqual(before);
  });

  it('applies include globs', async () => {
    const r = await scanRepo(root, { ...opts, include: ['docs/**', 'README.md'] });
    expect(r.files).toEqual(['README.md', 'docs/GDD.md']);
  });

  it('re-scans incrementally: unchanged files are not read again', async () => {
    const first = await scanRepo(root, opts);
    const { fs, reads } = recordingFs();
    const again = await scanRepo(root, { ...opts, previous: first.manifest, fs });
    expect(again.changed).toEqual([]);
    expect(again.removed).toEqual([]);
    expect(again.digestHash).toBe(first.digestHash);
    // Accepted, unchanged files are only stat'ed, never read.
    expect(reads.filter((p) => first.files.includes(p))).toEqual([]);

    const player = join(root, 'Assets/Scripts/Player.cs');
    await writeFile(player, 'class Player { int hp; }');
    await utimes(player, new Date(), new Date(Date.now() + 5000));
    await unlink(join(root, 'Localization/fr.json'));
    const third = await scanRepo(root, { ...opts, previous: again.manifest });
    expect(third.changed).toEqual(['Assets/Scripts/Player.cs']);
    expect(third.removed).toEqual(['Localization/fr.json']);
    expect(third.digestHash).not.toBe(first.digestHash);
    await writeFile(join(root, 'Localization/fr.json'), FILES['Localization/fr.json']!);
  });

  it('honours cancellation and the file cap', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(scanRepo(root, { ...opts, signal: ac.signal })).rejects.toThrow();
    const capped = await scanRepo(root, { ...opts, maxFiles: 2 });
    expect(capped.files).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });
});

describe('extractor context', () => {
  it('serves scanned files only', async () => {
    const ctx = extractorContext(await scanRepo(root, opts), new AbortController().signal);
    expect(await ctx.readText('README.md')).toMatch(/Ember Knight/);
    for (const p of [
      '.env',
      '../outside/private.md',
      'linked/private.md',
      'Builds/game.txt',
      '/etc/passwd',
    ]) {
      await expect(ctx.readText(p)).rejects.toBeInstanceOf(RepoAccessError);
    }
  });
});

describe('generic extractor', () => {
  it('pulls the title, design-doc lists, localization names and achievements', async () => {
    const ctx = extractorContext(await scanRepo(root, opts), new AbortController().signal);
    const found = await genericExtractor.extract(ctx);
    const by = (kind: string) =>
      found
        .filter((e) => e.kind === kind)
        .map((e) => e.name)
        .sort();
    expect(by('title')).toEqual(['Ember Knight']);
    expect(found.find((e) => e.kind === 'title')?.description).toBe(
      'A soulslike about parrying fire.',
    );
    expect(by('boss')).toEqual(['The Ash Warden']); // README + CSV merged, draft boss gitignored
    expect(by('level')).toEqual(['Cinder Forest', 'Glass Caverns']);
    expect(by('ability')).toEqual(['Perfect Parry']);
    expect(by('item')).toEqual(['Ember Blade']); // fr.json ignored
    expect(by('enemy')).toEqual(['Ash Husk']);
    expect(by('achievement')).toEqual(['Untouchable']);
    expect(found.some((e) => e.name === 'Main Menu' || e.name.includes('Not an entity'))).toBe(
      false,
    );

    const warden = found.find((e) => e.name === 'The Ash Warden')!;
    expect(warden.sourcePaths.sort()).toEqual(['Localization/strings.csv', 'README.md']);
    expect(warden.description).toBe('second-act boss with two phases');
    expect(warden.confidence).toBe(0.8);
    expect(JSON.stringify(found)).not.toContain(SECRET);
    expect(await genericExtractor.detect(ctx)).toBeGreaterThan(0);
  });

  it('parses quoted CSV', () => {
    expect(parseCsv('a,"b ""c"", d"\r\n1,2\n')).toEqual([
      ['a', 'b "c", d'],
      ['1', '2'],
    ]);
  });
});
