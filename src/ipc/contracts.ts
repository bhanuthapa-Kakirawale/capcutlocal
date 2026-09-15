import { z } from 'zod';

/*
 * Zod mirrors of the Rust IPC types in src-tauri/src. Every response is parsed with these
 * schemas, and fixtures/ipc/*.json pins both sides to the same shapes (ADR-008).
 */

/** Closed set of error codes. Mirrors `ErrorCode` in src-tauri/src/error.rs. */
export const ErrorCodeSchema = z.enum([
  'INTERNAL',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'TOO_LARGE',
  'INVALID_PROJECT_FILE',
  'DISK_FULL',
  'PERMISSION_DENIED',
]);
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

/** Response of `project_open`. Mirrors `OpenedProject` in src-tauri/src/project/mod.rs. */
export const OpenedProjectSchema = z.strictObject({
  contents: z.string(),
  path: z.string().min(1),
});
export type OpenedProject = z.infer<typeof OpenedProjectSchema>;

/** One entry of `recent_projects_list`. Mirrors `RecentProject` in src-tauri/src/project/recents.rs. */
export const RecentProjectSchema = z.strictObject({
  path: z.string().min(1),
  name: z.string().min(1),
  lastOpenedAtMs: z.number().int().nonnegative(),
});
export type RecentProject = z.infer<typeof RecentProjectSchema>;

/** Response of `session_check_recovery`. Mirrors `RecoveryInfo` in src-tauri/src/project/session.rs. */
export const RecoveryInfoSchema = z.strictObject({
  projectId: z.string().min(1),
  projectPath: z.string().min(1).nullable(),
  autosavePath: z.string().min(1),
});
export type RecoveryInfo = z.infer<typeof RecoveryInfoSchema>;
