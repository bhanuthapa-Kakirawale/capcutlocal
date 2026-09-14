import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import appErrorFixture from '../../fixtures/ipc/app_error.json';
import appInfoFixture from '../../fixtures/ipc/app_info.json';
import logEntriesFixture from '../../fixtures/ipc/log_write_entries.json';
import { AppErrorSchema, AppInfoSchema, UiLogEntrySchema } from './contracts';

// The same fixture files are checked by the Rust test suite (src-tauri/src/test_support.rs),
// so these tests fail as soon as the TS and Rust shapes drift apart (ADR-008).
describe('IPC contract fixtures', () => {
  it('app_info.json matches AppInfoSchema', () => {
    expect(() => AppInfoSchema.parse(appInfoFixture)).not.toThrow();
  });

  it('app_error.json matches AppErrorSchema', () => {
    expect(() => AppErrorSchema.parse(appErrorFixture)).not.toThrow();
  });

  it('log_write_entries.json matches UiLogEntrySchema', () => {
    expect(() => z.array(UiLogEntrySchema).parse(logEntriesFixture)).not.toThrow();
  });

  it('rejects fields the Rust side does not send', () => {
    expect(AppInfoSchema.safeParse({ ...appInfoFixture, extra: true }).success).toBe(false);
  });
});
