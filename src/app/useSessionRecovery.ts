import { useEffect, useState } from 'react';
import { sessionCheckRecovery } from '../ipc/commands';
import type { RecoveryInfo } from '../ipc/contracts';
import { describeIpcError } from '../ipc/invoke';
import { logger } from './logger';

/** Checks once, on mount, whether the previous session left a newer autosave behind
 * (docs/PROJECT-MODEL.md §6). `dismiss()` hides the banner without touching any files. */
export function useSessionRecovery(): { recovery: RecoveryInfo | null; dismiss: () => void } {
  const [recovery, setRecovery] = useState<RecoveryInfo | null>(null);

  useEffect(() => {
    let active = true;
    void sessionCheckRecovery().then((result) => {
      if (!active) return;
      if (result.ok) {
        setRecovery(result.value);
      } else {
        logger.warn(`session_check_recovery failed: ${describeIpcError(result.error)}`);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  return {
    recovery,
    dismiss: () => {
      setRecovery(null);
    },
  };
}
