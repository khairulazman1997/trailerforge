import { defineConfig } from '@playwright/test';

/**
 * Browser tests drive the built UI against a real engine service (see e2e/*.spec.ts).
 * On machines without Playwright's own browser download, point TFORGE_CHROMIUM at any
 * Chromium/Chrome executable.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  workers: 1,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    headless: true,
    ...(process.env.TFORGE_CHROMIUM
      ? { launchOptions: { executablePath: process.env.TFORGE_CHROMIUM } }
      : {}),
  },
});
