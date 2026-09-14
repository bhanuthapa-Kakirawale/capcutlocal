import process from 'node:process';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const host = process.env.TAURI_DEV_HOST;

// Server options follow Tauri's recommended Vite setup.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Keep Rust compiler output visible when running under `tauri dev`.
  clearScreen: false,
  server: {
    // Tauri loads the fixed `devUrl` from tauri.conf.json, so the port must not drift.
    port: 1420,
    strictPort: true,
    host: host ?? false,
    ...(host ? { hmr: { protocol: 'ws', host, port: 1421 } } : {}),
    watch: { ignored: ['**/src-tauri/**'] },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
  },
});
