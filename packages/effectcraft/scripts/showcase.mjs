// Renders the worked effect examples (the ones the author prompt shows the model) with the
// installed EffectCraft, through the same path an AI-written effect takes (`effectCommands` →
// `EffectCraftRenderer.authorProject` → `render`), and writes a few PNG frames of each so the
// looks can be checked by eye. Each example is rendered twice and the frames compared, so the
// summary also says whether it is deterministic (the render cache assumes it is).
//
//   TFORGE_EFFECTCRAFT=<path to effectcraft-cli> node packages/effectcraft/scripts/showcase.mjs [out] [--presets] [--no-build]
//
// `out` defaults to ./effectcraft-showcase. `--presets` also renders every built-in preset the
// prompt names, twice each, to see which are deterministic. The script builds the effectcraft
// package and its dependencies first (turbo, cached) unless `--no-build` is given.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(pkg, '..', '..');
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const out = resolve(args.find((a) => !a.startsWith('--')) ?? 'effectcraft-showcase');

if (!process.env.TFORGE_EFFECTCRAFT?.trim()) {
  console.error('Set TFORGE_EFFECTCRAFT to your effectcraft-cli (e.g. C:\\Program Files\\EffectCraft\\effectcraft-cli.exe).'); // prettier-ignore
  process.exit(1);
}

if (!flags.has('--no-build')) {
  console.log('Building @trailerforge/effectcraft and its dependencies (cached after the first time)…'); // prettier-ignore
  const r = spawnSync('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@trailerforge/effectcraft...', '--output-logs=errors-only'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }); // prettier-ignore
  if (r.status !== 0) {
    console.error('The build failed; fix it or run with --no-build after `pnpm build`.');
    process.exit(1);
  }
}

const ec = await import(pathToFileURL(join(pkg, 'dist', 'index.js')).href);
const { FLICKS_PER_SECOND } = await import('@trailerforge/schema');
const {
  EFFECT_EXAMPLES,
  EXAMPLE_FRAME_RATE,
  EXAMPLE_SECONDS,
  EXAMPLE_SIZE,
  EFFECT_COMP,
  EffectCraftRenderer,
  PROJECT_TEMPLATE_ID,
  effectCommands,
  effectProblems,
  locateCli,
} = ec;

/** The presets the author prompt names (the real list has more). */
const PRESETS = {
  background: ['emberHaze', 'darkSmoke', 'slowFog', 'sweepingLight', 'bokehDrift', 'auroraVeil', 'grainyWash'], // prettier-ignore
  transition: ['fadeIn', 'wipeInFromLeft', 'diagonalSweepIn', 'lineSweepIn', 'lensPopIn', 'clockReveal'], // prettier-ignore
  behaviour: ['wiggleSoft', 'floatUpDown', 'breathe'],
  text: ['typewriter', 'fadeUpCharacters', 'trackingIn', 'blurIn', 'dropInLines'],
};
const SAMPLE_TIMES = [0.3, 0.8, 1.3, 1.8, 2.7];

await mkdir(out, { recursive: true });
const work = await mkdtemp(join(tmpdir(), 'tforge-showcase-'));
const renderer = new EffectCraftRenderer({ cli: locateCli(), workRoot: join(work, 'runs') });
const signal = new globalThis.AbortController().signal;
const summary = [];

try {
  const a = await renderer.available();
  if (!a.ok) {
    console.error(`EffectCraft cannot be used: ${a.reason}`);
    process.exit(1);
  }
  const set = await renderer.effectCommandSet();
  const missing = ec.EFFECT_COMMANDS.filter((c) => !set.offered.includes(c));
  await writeFile(
    join(out, 'commands.txt'),
    [
      `EffectCraft ${a.version}${a.note ? ` (${a.note})` : ''}`,
      '',
      `Offered to the model (${set.offered.length}): ${set.offered.join(', ')}`,
      `Allowed but not in this build: ${missing.join(', ') || 'none'}`,
      '',
      'How this build describes them:',
      ...(set.described.length
        ? set.described
        : ['(no parameter descriptions in `commands --json`)']),
      '',
    ].join('\n'),
  );
  summary.push(`# EffectCraft showcase`, '', `EffectCraft ${a.version}. Frames at ${SAMPLE_TIMES.join(', ')} s.`, ''); // prettier-ignore
  summary.push('| Effect | Built | Deterministic | Notes |', '| --- | --- | --- | --- |');

  for (const { id, effect } of EFFECT_EXAMPLES) {
    const o = { ...EXAMPLE_SIZE, frameRate: EXAMPLE_FRAME_RATE, seconds: EXAMPLE_SECONDS };
    console.log(`${id}: ${effect.name}`);
    const r = await renderTwice(id, effectCommands(effect, o), o, effectProblems(effect.commands, { listed: set.listed })); // prettier-ignore
    summary.push(`| ${id} | ${r.built} | ${r.same} | ${r.note} |`);
  }

  if (flags.has('--presets')) {
    summary.push('', '## Presets', '', '| Preset | Kind | Built | Deterministic | Notes |', '| --- | --- | --- | --- | --- |'); // prettier-ignore
    const o = { width: 960, height: 540, frameRate: 30, seconds: 2 };
    for (const [kind, names] of Object.entries(PRESETS))
      for (const preset of names) {
        console.log(`preset ${preset}`);
        const r = await renderTwice(`preset-${preset}`, presetCommands(kind, preset, o), o, []);
        summary.push(`| ${preset} | ${kind} | ${r.built} | ${r.same} | ${r.note} |`);
      }
  }
  await writeFile(join(out, 'summary.md'), summary.join('\n') + '\n');
  console.log(`\nDone: ${join(out, 'summary.md')}`);
} finally {
  await rm(work, { recursive: true, force: true });
}

/** Builds and renders `commands` twice; keeps the project, sample frames and any error. */
async function renderTwice(id, commands, o, problems) {
  const note = problems.length ? `check: ${problems.join('; ')}` : '';
  const project = join(out, `${id}.ecproj`);
  try {
    await renderer.authorProject(commands, project, signal);
  } catch (e) {
    await writeFile(join(out, `${id}.error.txt`), `${e.message}\n`);
    console.log(`  build failed: ${e.message}`);
    return { built: 'no', same: '-', note: `${note} ${oneLine(e.message)}`.trim() };
  }
  try {
    const hashes = [];
    for (const pass of [1, 2]) {
      const dir = join(work, `${id}-${pass}`);
      const r = await renderer.render(
        {
          templateId: PROJECT_TEMPLATE_ID,
          params: { project, comp: EFFECT_COMP },
          duration: Math.round(o.seconds * FLICKS_PER_SECOND),
          resolution: { width: o.width, height: o.height },
          frameRate: { num: o.frameRate, den: 1 },
          outDir: dir,
        },
        signal,
      );
      hashes.push(await folderHash(dir));
      if (pass === 1)
        for (const t of SAMPLE_TIMES.filter((t) => t < o.seconds)) {
          const n = Math.min(r.frames - 1, Math.round(t * o.frameRate));
          const name = `frame_${String(n).padStart(6, '0')}.png`;
          await copyFile(join(dir, name), join(out, `${id}_${t.toFixed(1)}s.png`));
        }
      await rm(dir, { recursive: true, force: true });
    }
    const same = hashes[0] === hashes[1] ? 'yes' : '**no**';
    console.log(`  rendered; deterministic: ${same}`);
    return { built: 'yes', same, note };
  } catch (e) {
    await writeFile(join(out, `${id}.error.txt`), `${e.message}\n`);
    console.log(`  render failed: ${e.message}`);
    return { built: 'yes', same: '-', note: `${note} render: ${oneLine(e.message)}`.trim() };
  }
}

function presetCommands(kind, preset, o) {
  const comp = { command: 'comp.new', params: { name: EFFECT_COMP, width: o.width, height: o.height, frameRate: o.frameRate, duration: o.seconds } }; // prettier-ignore
  if (kind === 'background')
    return [
      comp,
      { command: 'layer.newSolid', params: { name: 'Bg', color: '#000000', width: o.width, height: o.height } }, // prettier-ignore
      { command: 'anim.applyBuiltinPreset', params: { preset, layers: ['Bg'] } },
    ];
  const text = { command: 'layer.newText', params: { name: 'T', text: 'EMBER KNIGHT', position: [o.width / 2, o.height / 2], font: 'Inter', style: 'Bold', size: 72, fill: '#F4F1EA', justify: 'center', tracking: 200 } }; // prettier-ignore
  return kind === 'text'
    ? [comp, text, { command: 'layer.applyTextPreset', params: { layer: 'T', preset } }]
    : [comp, text, { command: 'anim.applyBuiltinPreset', params: { preset, layers: ['T'] } }];
}

async function folderHash(dir) {
  const h = createHash('sha256');
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.png')).sort())
    h.update(f).update(await readFile(join(dir, f)));
  return h.digest('hex');
}

function oneLine(s) {
  return s.replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 200);
}
