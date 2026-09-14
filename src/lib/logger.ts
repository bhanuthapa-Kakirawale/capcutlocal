import { describeUnknown } from './describe';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogEntry = {
  level: LogLevel;
  message: string;
  context?: string;
};

/** Receives batches of entries. Must not throw: logging failures are never the caller's problem. */
export type LogSink = (entries: LogEntry[]) => Promise<void>;

export type Logger = {
  debug(message: string, context?: string): void;
  info(message: string, context?: string): void;
  warn(message: string, context?: string): void;
  error(message: string, context?: string): void;
  /** Sends everything queued so far without waiting for the batch delay. */
  flush(): Promise<void>;
};

export type LoggerOptions = {
  sink: LogSink;
  /** Entries below this level are not sent to the sink. */
  sinkLevel: LogLevel;
  /** Also write every entry to the console (development builds). */
  mirrorToConsole: boolean;
  flushDelayMs?: number;
  maxBatchSize?: number;
};

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Batching logger. Entries are queued and delivered to the sink after `flushDelayMs`,
 * or immediately once `maxBatchSize` entries are waiting, so bursts cost one IPC call.
 */
export function createLogger(options: LoggerOptions): Logger {
  const { sink, sinkLevel, mirrorToConsole, flushDelayMs = 500, maxBatchSize = 50 } = options;
  let queue: LogEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = async (): Promise<void> => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    await sink(batch);
  };

  const log = (level: LogLevel, message: string, context?: string): void => {
    if (mirrorToConsole) {
      console[level](message, ...(context === undefined ? [] : [context]));
    }
    if (LEVEL_ORDER[level] < LEVEL_ORDER[sinkLevel]) return;
    queue.push(context === undefined ? { level, message } : { level, message, context });
    if (queue.length >= maxBatchSize) {
      void flush();
    } else {
      timer ??= setTimeout(() => void flush(), flushDelayMs);
    }
  };

  return {
    debug: (message, context) => {
      log('debug', message, context);
    },
    info: (message, context) => {
      log('info', message, context);
    },
    warn: (message, context) => {
      log('warn', message, context);
    },
    error: (message, context) => {
      log('error', message, context);
    },
    flush,
  };
}

/** Routes uncaught errors and unhandled promise rejections into the logger. */
export function captureUncaughtErrors(logger: Logger, target: Window): void {
  target.addEventListener('error', (event) => {
    const stack = event.error instanceof Error ? event.error.stack : undefined;
    // Chromium's message is already prefixed ("Uncaught Error: …"), so it is logged as is.
    logger.error(event.message === '' ? 'Uncaught error' : event.message, stack);
  });
  target.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    const stack = reason instanceof Error ? reason.stack : undefined;
    logger.error(`Unhandled promise rejection: ${describeUnknown(reason)}`, stack);
  });
}
