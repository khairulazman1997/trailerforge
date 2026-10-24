/** Starts an import and stops dead right after the file is registered, until the test SIGKILLs it. */
import { join } from 'node:path';
import { LibraryStore } from '@trailerforge/core';
import { JobQueue } from '@trailerforge/jobs';
import { Ingestor } from './ingestor.js';
import { registerIngestJobs } from './jobs.js';

const [home, source] = process.argv.slice(2) as [string, string];
const library = await LibraryStore.open(home);
const queue = new JobQueue({
  dbPath: join(home, 'jobs.sqlite'),
  tempRoot: join(home, 'tmp'),
  progressThrottleMs: 0,
});
registerIngestJobs({
  library,
  queue,
  home,
  growthCheckMs: 20,
  onStage: async (stage) => {
    if (stage !== 'registered') return;
    console.log('registered');
    await new Promise(() => undefined);
  },
});
await new Ingestor({ queue }).importPaths([source]);
queue.start();
