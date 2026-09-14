import process from 'node:process';
import { defineConfig } from '@playwright/test';

// E2E tests drive the real, built application (see e2e/app-smoke.spec.ts), so they run serially.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
