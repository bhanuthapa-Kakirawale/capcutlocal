import { z } from 'zod';
import { FingerprintSchema } from '../domain/model/asset';
import { MediaInfoSchema } from '../domain/model/media';

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
  'FFMPEG_UNAVAILABLE',
  'FFMPEG_FAILED',
  'CANCELLED',
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

/** Mirrors `MediaKind` in src-tauri/src/ffmpeg/probe.rs. */
export const MediaKindSchema = z.enum(['video', 'audio', 'image']);
export type MediaKind = z.infer<typeof MediaKindSchema>;

/** One `media_import` result. Mirrors `ImportOutcome` in src-tauri/src/commands/media.rs.
 * The `imported` branch reuses the domain's own Fingerprint/MediaInfo schemas: Rust
 * produces exactly that shape, so this is the single definition, not a second one to
 * keep in sync by hand. */
export const ImportOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('imported'),
    path: z.string().min(1),
    kind: MediaKindSchema,
    suggestedName: z.string().min(1),
    fingerprint: FingerprintSchema,
    info: MediaInfoSchema,
  }),
  z.strictObject({
    status: z.literal('failed'),
    path: z.string().min(1),
    error: AppErrorSchema,
  }),
]);
export type ImportOutcome = z.infer<typeof ImportOutcomeSchema>;

/** Response of `ffmpeg_diagnostics`. Mirrors `FfmpegDiagnostics` in src-tauri/src/commands/media.rs. */
export const FfmpegDiagnosticsSchema = z.strictObject({
  available: z.boolean(),
  ffmpegVersion: z.string().min(1).nullable(),
  ffprobeVersion: z.string().min(1).nullable(),
  error: z.string().optional(),
});
export type FfmpegDiagnostics = z.infer<typeof FfmpegDiagnosticsSchema>;
