// @vitest-environment jsdom
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import appErrorFixture from '../../fixtures/ipc/app_error.json';
import appInfoFixture from '../../fixtures/ipc/app_info.json';
import { App } from './App';
import { logger } from './logger';

afterEach(async () => {
  // Deliver queued log entries while the IPC mock is still installed.
  await logger.flush();
  clearMocks();
});

describe('App', () => {
  it('shows core information once app_info answers', async () => {
    mockIPC((command) => (command === 'app_info' ? appInfoFixture : null));

    render(<App />);

    expect(screen.getByText(/Connecting to the application core/)).toBeInTheDocument();
    expect(await screen.findByTestId('app-version')).toHaveTextContent(appInfoFixture.version);
    expect(screen.getByText(appInfoFixture.logDir)).toBeInTheDocument();
  });

  it('shows the error reported by the core, and logs it back to the core', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // App.tsx fires several independent IPC calls on mount (app_info, session recovery
    // check, recent projects, session bootstrap); every one of them fails here, each
    // logged independently, and the logger may batch them into one or several calls.
    const loggedEntries: unknown[] = [];
    mockIPC((command, args) => {
      if (command === 'log_write') {
        const entries = (args as { entries: unknown[] }).entries;
        loggedEntries.push(...entries);
        return null;
      }
      // The Rust core rejects with a plain serialized AppError object, not an Error instance.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(appErrorFixture);
    });

    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent(appErrorFixture.message);
    await logger.flush();
    expect(
      loggedEntries.some(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          'message' in entry &&
          typeof entry.message === 'string' &&
          entry.message.includes(appErrorFixture.message),
      ),
    ).toBe(true);
  });
});
