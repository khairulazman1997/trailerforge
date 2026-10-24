/** Runs one footage analysis job until the test SIGKILLs this process mid-way. */
import { join } from 'node:path';
import { JobQueue } from '@trailerforge/jobs';
import { FOOTAGE_JOB, registerAnalysisJobs } from './jobs.js';

const [home, video, analysisDir] = process.argv.slice(2) as [string, string, string];
const queue = new JobQueue({
  dbPath: join(home, 'jobs.sqlite'),
  tempRoot: join(home, 'tmp'),
  progressThrottleMs: 0,
});
registerAnalysisJobs(queue);
queue.subscribe((e) => {
  if (e.kind === 'progress' && e.job.progress > 0) console.log(`progress ${e.job.progress}`);
});
queue.enqueue(FOOTAGE_JOB, { path: video, quickHash: 'd'.repeat(64), analysisDir });
queue.start();
