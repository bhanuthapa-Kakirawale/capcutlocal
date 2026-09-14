import { logWrite } from '../ipc/commands';
import { describeIpcError } from '../ipc/invoke';
import { createLogger } from '../lib/logger';

/**
 * Application logger. Entries at `info` and above go to the Rust log file
 * (docs/ARCHITECTURE.md §8); development builds also mirror everything to the console.
 */
export const logger = createLogger({
  sink: async (entries) => {
    const result = await logWrite(entries);
    if (!result.ok && import.meta.env.DEV) {
      console.warn(`Log forwarding failed: ${describeIpcError(result.error)}`);
    }
  },
  sinkLevel: 'info',
  mirrorToConsole: import.meta.env.DEV,
});
