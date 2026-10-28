/** Runs one video render from a spec file and reports each finished segment, until the test SIGKILLs it. */
import { readFileSync } from 'node:fs';
import { renderVideo, type RenderSpec } from './video.js';

const [specFile, workRoot] = process.argv.slice(2) as [string, string];
const spec = JSON.parse(readFileSync(specFile, 'utf8')) as RenderSpec;
await renderVideo(spec, {
  workRoot,
  onProgress: (p) => process.stdout.write(`segments ${p.segmentsDone}\n`),
});
process.stdout.write('done\n');
