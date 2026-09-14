// @vitest-environment jsdom
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import appErrorFixture from '../../fixtures/ipc/app_error.json';
import { invokeCommand } from './invoke';

const EchoSchema = z.object({ value: z.number() });

afterEach(() => {
  clearMocks();
});

describe('invokeCommand', () => {
  it('returns the validated response', async () => {
    mockIPC((command) => (command === 'echo' ? { value: 42 } : null));

    await expect(invokeCommand('echo', EchoSchema)).resolves.toEqual({
      ok: true,
      value: { value: 42 },
    });
  });

  it('maps an AppError rejection to kind "app"', async () => {
    // The Rust core rejects with a plain serialized AppError object, not an Error instance.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    mockIPC(() => Promise.reject(appErrorFixture));

    await expect(invokeCommand('echo', EchoSchema)).resolves.toEqual({
      ok: false,
      error: { kind: 'app', ...appErrorFixture },
    });
  });

  it('maps any other rejection to kind "transport"', async () => {
    mockIPC(() => Promise.reject(new Error('IPC unavailable')));

    await expect(invokeCommand('echo', EchoSchema)).resolves.toEqual({
      ok: false,
      error: { kind: 'transport', command: 'echo', message: 'IPC unavailable' },
    });
  });

  it('maps a response that fails its schema to kind "contract"', async () => {
    mockIPC(() => ({ value: 'not a number' }));

    const result = await invokeCommand('echo', EchoSchema);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('contract');
  });
});
