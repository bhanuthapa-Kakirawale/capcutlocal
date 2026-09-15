import { z } from 'zod';
import type { Result } from '../lib/result';
import {
  AppInfoSchema,
  FfmpegDiagnosticsSchema,
  ImportOutcomeSchema,
  OpenedProjectSchema,
  RecentProjectSchema,
  RecoveryInfoSchema,
  type AppInfo,
  type FfmpegDiagnostics,
  type ImportOutcome,
  type OpenedProject,
  type RecentProject,
  type RecoveryInfo,
  type UiLogEntry,
} from './contracts';
import { invokeCommand, type IpcError } from './invoke';

/* Typed wrappers for the Rust commands registered in src-tauri/src/lib.rs. */

export function appInfo(): Promise<Result<AppInfo, IpcError>> {
  return invokeCommand('app_info', AppInfoSchema);
}

export function logWrite(entries: readonly UiLogEntry[]): Promise<Result<null, IpcError>> {
  return invokeCommand('log_write', z.null(), { entries });
}

export function projectSave(path: string, contents: string): Promise<Result<null, IpcError>> {
  return invokeCommand('project_save', z.null(), { path, contents });
}

export function projectOpen(path: string): Promise<Result<OpenedProject, IpcError>> {
  return invokeCommand('project_open', OpenedProjectSchema, { path });
}

export function projectAutosave(
  projectId: string,
  contents: string,
): Promise<Result<null, IpcError>> {
  return invokeCommand('project_autosave', z.null(), { projectId, contents });
}

export function recentProjectsList(): Promise<Result<RecentProject[], IpcError>> {
  return invokeCommand('recent_projects_list', z.array(RecentProjectSchema));
}

export function sessionCheckRecovery(): Promise<Result<RecoveryInfo | null, IpcError>> {
  return invokeCommand('session_check_recovery', RecoveryInfoSchema.nullable());
}

export function sessionSetActiveProject(
  projectId: string,
  path: string | null,
): Promise<Result<null, IpcError>> {
  return invokeCommand('session_set_active_project', z.null(), { projectId, path });
}

export function mediaImport(paths: readonly string[]): Promise<Result<ImportOutcome[], IpcError>> {
  return invokeCommand('media_import', z.array(ImportOutcomeSchema), { paths });
}

export function mediaGeneratePoster(
  path: string,
  fingerprint: string,
  durationFlicks: number,
): Promise<Result<string, IpcError>> {
  return invokeCommand('media_generate_poster', z.string().min(1), {
    path,
    fingerprint,
    durationFlicks,
  });
}

export function jobCancel(jobId: string): Promise<Result<boolean, IpcError>> {
  return invokeCommand('job_cancel', z.boolean(), { jobId });
}

export function ffmpegDiagnostics(): Promise<Result<FfmpegDiagnostics, IpcError>> {
  return invokeCommand('ffmpeg_diagnostics', FfmpegDiagnosticsSchema);
}
