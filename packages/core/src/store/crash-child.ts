/**
 * Test helper for crash-safety.test.ts: opens a project and saves in a tight loop until killed.
 * Each save grows a large extension blob so writes take long enough to be interrupted.
 */
import { coreCommands, setProjectExtension } from '../project-commands.js';
import { ProjectStore } from './project-store.js';

const dir = process.argv[2]!;
const store = await ProjectStore.open(dir, { commands: coreCommands(), autosaveMs: 0 });
const blob = 'x'.repeat(256 * 1024);
process.stdout.write('ready\n');
for (let i = 0; ; i++) {
  store.run(setProjectExtension, { pluginId: 'crash-test', value: { i, blob } });
  await store.save();
}
