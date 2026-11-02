// Runs the Unity package tests on the fixture project in batch mode (not part of `pnpm check`).
//   node scripts/unity-test.mjs [--platform EditMode|PlayMode] [--filter <name>] [--nographics] [--no-flow]
// A full run (no --filter) then runs the whole flow: the engine's unity-flow test exports a pack, runs Unity again to
// record from it, and imports, matches and cuts the takes.
// Finds Unity through TFORGE_UNITY (the Unity executable) or the newest 2022.3 install of Unity Hub.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = join(root, 'integrations', 'unity', 'TestProject');
const outDir = join(root, 'integrations', 'unity', 'TestProject', 'Logs', 'tforge');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function findUnity(env = process.env) {
  if (env.TFORGE_UNITY) return existsSync(env.TFORGE_UNITY) ? env.TFORGE_UNITY : undefined;
  const bases = [
    'C:/Program Files/Unity/Hub/Editor',
    '/Applications/Unity/Hub/Editor',
    join(env.HOME ?? '', 'Unity/Hub/Editor'),
  ];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    const versions = readdirSync(base)
      .filter((v) => v.startsWith('2022.3'))
      .sort()
      .reverse();
    for (const v of versions) {
      for (const exe of ['Editor/Unity.exe', 'Unity.app/Contents/MacOS/Unity', 'Editor/Unity']) {
        const p = join(base, v, exe);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

/** Totals from an NUnit 3 result file. */
export function summarize(xml) {
  const tag = /<test-run\b[^>]*>/.exec(xml)?.[0] ?? '';
  const num = (k) => Number(new RegExp(`\\b${k}="(\\d+)"`).exec(tag)?.[1] ?? 0);
  const failures = [
    ...xml.matchAll(/<test-case\b[^>]*\bfullname="([^"]*)"[^>]*\bresult="Failed"/g),
  ].map((m) => m[1]);
  return { total: num('total'), passed: num('passed'), failed: num('failed'), failures };
}

const unity = findUnity();
if (!unity) {
  console.error('Unity 2022.3 was not found. Set TFORGE_UNITY to the Unity executable.');
  process.exit(2);
}
const platform = arg('--platform') ?? 'EditMode';
mkdirSync(outDir, { recursive: true });
const results = join(outDir, `${platform}.xml`);
// never report an earlier run when this one fails before writing results
rmSync(results, { force: true });
const args = [
  '-batchmode',
  ...(process.argv.includes('--nographics') ? ['-nographics'] : []),
  '-projectPath',
  project,
  '-runTests',
  '-testPlatform',
  platform,
  '-testResults',
  results,
  '-logFile',
  join(outDir, `${platform}.log`),
  ...(arg('--filter') ? ['-testFilter', arg('--filter')] : []),
];
console.log(`${unity}\n  ${platform} tests in ${project}`);
const run = spawnSync(unity, args, { stdio: 'inherit' });
if (!existsSync(results)) {
  console.error(
    `Unity produced no results (exit ${run.status}). See ${join(outDir, `${platform}.log`)}`,
  );
  process.exit(run.status || 1);
}
const s = summarize(readFileSync(results, 'utf8'));
console.log(`${s.passed}/${s.total} passed, ${s.failed} failed`);
for (const f of s.failures) console.log(`  FAILED ${f}`);
if (s.failed > 0 || s.total === 0) process.exit(1);
if (arg('--filter') || process.argv.includes('--no-flow') || process.argv.includes('--nographics'))
  process.exit(0);
console.log('\nWhole flow: TrailerForge → Unity → TrailerForge');
const flow = spawnSync(
  'pnpm',
  ['--filter', '@trailerforge/engine', 'exec', 'vitest', 'run', 'src/unity-flow.test.ts'],
  {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, TFORGE_UNITY_FLOW: '1' },
  },
);
process.exit(flow.status ?? 1);
