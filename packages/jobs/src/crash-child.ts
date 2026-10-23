/** Runs the queue with one long step job until the parent test SIGKILLs this process. */
import { JobQueue } from './queue.js';
import { stepJob } from './test-jobs.js';

const [dbPath, tempRoot] = process.argv.slice(2) as [string, string];
const queue = new JobQueue({ dbPath, tempRoot, progressThrottleMs: 0 });
queue.register(stepJob);
queue.enqueue(stepJob, { steps: 20, stepMs: 40 });
queue.start();
