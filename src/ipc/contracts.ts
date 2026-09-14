import { z } from 'zod';

/*
 * Zod mirrors of the Rust IPC types in src-tauri/src. Every response is parsed with these
 * schemas, and fixtures/ipc/*.json pins both sides to the same shapes (ADR-008).
 */

/** Closed set of error codes. Mirrors `ErrorCode` in src-tauri/src/error.rs. */
export const ErrorCodeSchema = z.enum(['INTERNAL', 'INVALID_ARGUMENT']);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** Envelope every failing command rejects with. Mirrors `AppError` in src-tauri/src/error.rs. */
export const AppErrorSchema = z.strictObject({
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type AppError = z.infer<typeof AppErrorSchema>;

/** Response of `app_info`. Mirrors `AppInfo` in src-tauri/src/commands/app.rs. */
export const AppInfoSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  tauriVersion: z.string().min(1),
  os: z.string().min(1),
  arch: z.string().min(1),
  debugBuild: z.boolean(),
  logDir: z.string().min(1),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

/** One entry of the `log_write` argument. Mirrors `UiLogEntry` in src-tauri/src/commands/log.rs. */
export const UiLogEntrySchema = z.strictObject({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  context: z.string().optional(),
});
export type UiLogEntry = z.infer<typeof UiLogEntrySchema>;
