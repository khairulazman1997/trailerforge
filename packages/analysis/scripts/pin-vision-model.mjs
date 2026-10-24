#!/usr/bin/env node
// Pins the local AI vision model: resolves a Hugging Face revision to its commit, checks the
// licence allows closed-source use, records each file's exact URL, size and sha256, and rewrites
// src/vision-model.ts. Run where huggingface.co is reachable, then commit the result and run the
// live test: TFORGE_VISION_LIVE=1 pnpm --filter @trailerforge/analysis test
//
//   node scripts/pin-vision-model.mjs [repo] [revision]
/* global process, fetch, Buffer, console */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = process.argv[2] ?? 'Xenova/clip-vit-base-patch32';
const revision = process.argv[3] ?? 'main';
const ALLOWED = new Set(['mit', 'apache-2.0', 'bsd-2-clause', 'bsd-3-clause']);
const FILES = {
  'vision.onnx': 'onnx/vision_model_quantized.onnx',
  'text.onnx': 'onnx/text_model_quantized.onnx',
  'tokenizer.json': 'tokenizer.json',
};

const res = await fetch(
  `https://huggingface.co/api/models/${repo}/revision/${revision}?blobs=true`,
);
if (!res.ok) throw new Error(`Hugging Face API: HTTP ${res.status}`);
const info = await res.json();
const license = String(
  info.cardData?.license ?? (info.tags ?? []).find((t) => t.startsWith('license:'))?.slice(8) ?? '',
).toLowerCase();
if (!ALLOWED.has(license))
  throw new Error(`licence "${license || 'unknown'}" is not on the allow list`);

const files = [];
for (const [name, path] of Object.entries(FILES)) {
  const sib = (info.siblings ?? []).find((s) => s.rfilename === path);
  if (!sib) throw new Error(`${repo}@${info.sha} has no ${path}`);
  const url = `https://huggingface.co/${repo}/resolve/${info.sha}/${path}`;
  let { sha256, size: bytes } = sib.lfs ?? {};
  if (!sha256) {
    const body = Buffer.from(await (await fetch(url)).arrayBuffer());
    sha256 = createHash('sha256').update(body).digest('hex');
    bytes = body.length;
  }
  files.push({ name, url, bytes, sha256 });
  console.log(`${name.padEnd(15)} ${String(bytes).padStart(10)}  ${sha256}`);
}

const manifest = {
  id: 'clip-vit-b32',
  title: 'CLIP ViT-B/32 (quantized ONNX)',
  license: license === 'mit' ? 'MIT' : license,
  source: `${repo}@${info.sha}`,
  files,
};
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'vision-model.ts');
writeFileSync(
  out,
  `import type { VisionModelManifest } from './vision.js';

/**
 * The pinned vision model: exact URLs (at a fixed revision), sizes and sha256 of each file.
 * Written by \`node scripts/pin-vision-model.mjs\`; do not edit by hand.
 */
export const PINNED_VISION_MODEL: VisionModelManifest | null = ${JSON.stringify(manifest, null, 2)};
`,
);
console.log(`pinned ${manifest.source} (${manifest.license}) -> ${out}`);
