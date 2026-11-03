// A stand-in for `effectcraft-cli` 0.9.2 for the adapter's contract tests:
// `node stub-cli.mjs <mode> <effectcraft-cli args…>`. It speaks the subset TrailerForge uses
// (`--version`, `run`, `info`, `render` of a project or a template) with the real CLI's shapes:
// `{"error": …}` on stdout and exit 1 on failure, numbered PNG frames plus a render log.
// Modes: ok | old (reports 0.8.0) | slow (frames take 150 ms each) | no-alpha | wrong-size |
// fail-render | drift (different frames every run) | env:<file> (writes its environment to <file>).
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

const [mode, ...argv] = process.argv.slice(2);
const KNOWN = new Set([
  'comp.new',
  'layer.newText',
  'layer.newSolid',
  'prop.set',
  'prop.addKey',
  'keys.select',
  'keys.easyEase',
  'keys.toggleHold',
]);

const fail = (msg) => {
  process.stdout.write(JSON.stringify({ error: msg }) + '\n');
  process.exit(1);
};
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (mode.startsWith('env:')) writeFileSync(mode.slice(4), JSON.stringify(process.env));
if (argv[0] === '--version') {
  process.stdout.write(`effectcraft-cli ${mode === 'old' ? '0.8.0' : '0.9.2'}\n`);
  process.exit(0);
}

const VALUED = new Set(['--project', '--save-as', '--comp', '--out', '--format', '--channels']);
for (const v of ['--audio', '--quality', '--resolution', '--fps', '--start', '--end'])
  VALUED.add(v);
VALUED.add('--template');
VALUED.add('--values');
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) i++;
  else if (!argv[i].startsWith('--')) pos.push(argv[i]);
}
const cmd = pos.shift();

const load = (path) => {
  let p;
  try {
    p = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`cannot open ${path}: ${e.message}`);
  }
  if (p.schema !== 2 || !Array.isArray(p.comps)) fail('missing field settings');
  return p;
};

if (cmd === 'run') {
  const project = argv.includes('--empty')
    ? { savedBy: '0.9.2', schema: 2, comps: [], log: [] }
    : load(opt('--project'));
  const results = [];
  for (let i = 0; i < pos.length; i++) {
    const id = pos[i];
    let params = {};
    if (pos[i + 1]?.trimStart().startsWith('{')) params = JSON.parse(pos[++i]);
    if (!KNOWN.has(id)) fail(`${id}: unknown command`);
    if (id === 'comp.new') project.comps.push({ ...params });
    if (id === 'layer.newText' && typeof params.text !== 'string') fail('layer.newText: text');
    project.log.push([id, params]);
    results.push({ command: id, result: {} });
  }
  const out = opt('--save-as') ?? (argv.includes('--save') ? opt('--project') : undefined);
  if (out) writeFileSync(out, JSON.stringify(project, null, 2));
  process.stdout.write(JSON.stringify({ results, saved: out ?? null }) + '\n');
  process.exit(0);
}

if (cmd === 'info') {
  const p = load(pos[0]);
  process.stdout.write(JSON.stringify({ version: '0.9.2', mode: 'headless', project: p }) + '\n');
  process.exit(0);
}

if (cmd === 'render') {
  if (mode === 'fail-render') fail('Title: renderer crashed');
  let comp;
  let seed;
  if (opt('--template')) {
    const t = load(opt('--template'));
    const values = opt('--values') ? JSON.parse(readFileSync(opt('--values'), 'utf8')) : {};
    for (const k of Object.keys(values))
      if (!t.controls.includes(k)) fail(`unknown control ${k}; valid: ${t.controls.join(', ')}`);
    comp = t.comps[0];
    seed = JSON.stringify([t, values]);
  } else {
    const p = load(pos[0]);
    comp = p.comps.find((c) => c.name === opt('--comp')) ?? p.comps[0];
    if (!comp) fail('no composition');
    seed = JSON.stringify(p);
  }
  if (mode === 'drift') seed += `:${process.hrtime.bigint()}`;
  const fps = Number(opt('--fps') ?? comp.frameRate);
  const start = Number(opt('--start') ?? 0);
  const end = Math.min(Number(opt('--end') ?? comp.duration), comp.duration);
  const frames = Math.round((end - start) * fps);
  const out = opt('--out');
  const w = mode === 'wrong-size' ? comp.width + 2 : comp.width;
  for (let k = 0; k < frames; k++) {
    if (mode === 'slow') await sleep(150);
    const digest = createHash('sha256').update(`${seed}:${k}`).digest();
    const png = encodePng(w, comp.height, mode === 'no-alpha' ? 2 : 6, digest);
    const file = out.replace(/\[(#+)\]/, (_, h) => String(k).padStart(h.length, '0'));
    writeFileSync(file, png);
  }
  writeFileSync(join(dirname(out), 'f_RenderLog.txt'), `rendered at ${Date.now()}\n`);
  process.stdout.write(JSON.stringify({ rendered: [{ comp: comp.name, output: out }] }) + '\n');
  process.exit(0);
}

fail(`unknown subcommand ${cmd}`);

/** A real PNG: one colour per frame from `digest`, a translucent band in the middle. */
function encodePng(w, h, colorType, digest) {
  const ch = colorType === 6 ? 4 : 3;
  const raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * ch + 1);
    const band = y > h / 3 && y < (2 * h) / 3;
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * ch;
      raw[o] = digest[0];
      raw[o + 1] = digest[1];
      raw[o + 2] = digest[2];
      if (ch === 4) raw[o + 3] = band ? 255 : 0;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
