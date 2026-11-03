import { defineConfig } from 'vitest/config';

// Every test starts stand-in CLI processes (node), which is slow when packages test in parallel.
export default defineConfig({ test: { testTimeout: 60_000 } });
