import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';

// Drives the real, built application by attaching to its WebView2 over the Chrome DevTools
// Protocol (ADR-014). Build it first with `pnpm tauri build --no-bundle`.
const CDP_PORT = 9333;
const APP_PATH = process.env.KRITI_APP_PATH ?? path.resolve('src-tauri/target/release/kriti.exe');
const TIMEOUT_MS = 30_000;

test.skip(process.platform !== 'win32', 'Attaching over CDP relies on WebView2 (Windows).');

let app: ChildProcess | undefined;
let browser: Browser | undefined;

test.beforeAll(async () => {
  if (!existsSync(APP_PATH)) {
    throw new Error(`No built app at ${APP_PATH}. Run "pnpm tauri build --no-bundle" first.`);
  }
  app = spawn(APP_PATH, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: 'ignore',
  });
  browser = await retry(() => chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`));
});

test.afterAll(async () => {
  await browser?.close();
  app?.kill();
});

test('launches and answers app_info', async () => {
  const page = await mainPage();

  await expect(page).toHaveTitle('Kriti');
  await expect(page.getByTestId('app-version')).toHaveText(/^\d+\.\d+\.\d+/);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('forwards uncaught UI errors into the core log file', async () => {
  const page = await mainPage();
  const logDir = (await page.getByTestId('log-dir').textContent())?.trim() ?? '';
  const probe = `e2e log probe ${Date.now()}`;

  await page.evaluate((message) => {
    setTimeout(() => {
      throw new Error(message);
    }, 0);
  }, probe);

  // The UI logger batches for 500 ms before calling log_write.
  await expect.poll(() => readLogs(logDir), { timeout: 10_000 }).toContain(probe);
  expect(readLogs(logDir)).toContain('application started');
});

async function mainPage(): Promise<Page> {
  const connected = browser;
  if (!connected) throw new Error('Not connected to the app');
  return retry(() => {
    const page = connected
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith('http://tauri.localhost'));
    if (!page) throw new Error('The app window has not loaded http://tauri.localhost yet');
    return Promise.resolve(page);
  });
}

function readLogs(logDir: string): string {
  if (!existsSync(logDir)) return '';
  return readdirSync(logDir)
    .filter((name) => name.startsWith('kriti.') && name.endsWith('.log'))
    .map((name) => readFileSync(path.join(logDir, name), 'utf8'))
    .join('\n');
}

async function retry<T>(attempt: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await delay(250);
    }
  }
}
