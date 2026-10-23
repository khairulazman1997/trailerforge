#!/usr/bin/env node
// node:sqlite (job queue) is stable in practice but still flagged experimental; hide only that
// warning so CLI output stays clean. Must run before the module graph loads node:sqlite.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

const { main } = await import('./main.js');
process.exitCode = await main(process.argv.slice(2), {
  out: (line) => process.stdout.write(line + '\n'),
  err: (line) => process.stderr.write(line + '\n'),
});
