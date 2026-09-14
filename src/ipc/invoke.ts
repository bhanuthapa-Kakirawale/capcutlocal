import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';
import { describeUnknown } from '../lib/describe';
import { err, ok, type Result } from '../lib/result';
import { AppErrorSchema, type AppError } from './contracts';

/**
 * Why a command call failed:
 * - `app`: the core handled the request and rejected it with a typed `AppError`;
 * - `transport`: no response was produced (IPC unavailable, unexpected rejection);
 * - `contract`: the response did not match its schema, i.e. TS and Rust have drifted apart.
 */
export type IpcError =
  | ({ kind: 'app' } & AppError)
  | { kind: 'transport'; command: string; message: string }
  | { kind: 'contract'; command: string; message: string };

/** Calls a Rust command and validates its response. Never throws. */
export async function invokeCommand<T>(
  command: string,
  schema: z.ZodType<T>,
  args?: Record<string, unknown>,
): Promise<Result<T, IpcError>> {
  let response: unknown;
  try {
    response = await invoke(command, args);
  } catch (rejection: unknown) {
    return err(fromRejection(command, rejection));
  }
  const parsed = schema.safeParse(response);
  if (!parsed.success) {
    return err({ kind: 'contract', command, message: z.prettifyError(parsed.error) });
  }
  return ok(parsed.data);
}

function fromRejection(command: string, rejection: unknown): IpcError {
  const appError = AppErrorSchema.safeParse(rejection);
  if (appError.success) return { kind: 'app', ...appError.data };
  return { kind: 'transport', command, message: describeUnknown(rejection) };
}

export function describeIpcError(error: IpcError): string {
  switch (error.kind) {
    case 'app':
      return error.message;
    case 'transport':
      return `Could not reach the application core (${error.command}): ${error.message}`;
    case 'contract':
      return `Unexpected response from the application core (${error.command}): ${error.message}`;
  }
}
