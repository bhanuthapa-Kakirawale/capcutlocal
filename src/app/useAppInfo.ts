import { useEffect, useState } from 'react';
import { appInfo } from '../ipc/commands';
import type { AppInfo } from '../ipc/contracts';
import { describeIpcError } from '../ipc/invoke';
import { logger } from './logger';

export type AppInfoState =
  { status: 'loading' } | { status: 'ready'; info: AppInfo } | { status: 'error'; message: string };

/** Fetches build and platform information from the Rust core once. */
export function useAppInfo(): AppInfoState {
  const [state, setState] = useState<AppInfoState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    void appInfo().then((result) => {
      if (!active) return;
      if (result.ok) {
        setState({ status: 'ready', info: result.value });
        return;
      }
      const message = describeIpcError(result.error);
      logger.error(`app_info failed: ${message}`);
      setState({ status: 'error', message });
    });
    return () => {
      active = false;
    };
  }, []);

  return state;
}
