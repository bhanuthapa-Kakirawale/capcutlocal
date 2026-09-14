import { z } from 'zod';
import type { Result } from '../lib/result';
import { AppInfoSchema, type AppInfo, type UiLogEntry } from './contracts';
import { invokeCommand, type IpcError } from './invoke';

/* Typed wrappers for the Rust commands registered in src-tauri/src/lib.rs. */

export function appInfo(): Promise<Result<AppInfo, IpcError>> {
  return invokeCommand('app_info', AppInfoSchema);
}

export function logWrite(entries: readonly UiLogEntry[]): Promise<Result<null, IpcError>> {
  return invokeCommand('log_write', z.null(), { entries });
}
