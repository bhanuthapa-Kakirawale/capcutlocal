import process from 'node:process';
import { defineConfig } from '@playwright/test';

// Two kinds of spec share this config (ADR-014's dual-mode strategy):
// - e2e/app-smoke.spec.ts drives the real, built app over CDP and manages its own
//   browser/process lifecycle, so it ignores `use`/`webServer` entirely.
// - e2e/timeline-flow.spec.ts drives the real app in a plain browser tab against the
//   Vite dev server, with every Tauri command answered by e2e/mock-ipc.ts instead of
//   the Rust core — fast UI flow coverage that needs no Rust build.
// Both run serially against shared app/dev-server state.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  use: { trace: 'retain-on-failure', baseURL: 'http://localhost:1420' },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:1420/e2e/mock-app.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
