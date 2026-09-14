// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureUncaughtErrors, createLogger, type LogEntry } from './logger';

function setup() {
  const batches: LogEntry[][] = [];
  const logger = createLogger({
    sink: (entries) => {
      batches.push(entries);
      return Promise.resolve();
    },
    sinkLevel: 'info',
    mirrorToConsole: false,
    flushDelayMs: 500,
    maxBatchSize: 3,
  });
  return { logger, batches };
}

describe('createLogger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('batches entries until the flush delay elapses', () => {
    const { logger, batches } = setup();
    logger.info('opened');
    logger.warn('slow', 'took 900 ms');

    expect(batches).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(batches).toEqual([
      [
        { level: 'info', message: 'opened' },
        { level: 'warn', message: 'slow', context: 'took 900 ms' },
      ],
    ]);
  });

  it('sends a full batch immediately', () => {
    const { logger, batches } = setup();
    logger.info('1');
    logger.info('2');
    logger.info('3');

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  it('does not send entries below the sink level', () => {
    const { logger, batches } = setup();
    logger.debug('noise');
    vi.advanceTimersByTime(500);

    expect(batches).toEqual([]);
  });

  it('flush() sends pending entries without waiting for the delay', async () => {
    const { logger, batches } = setup();
    logger.error('failed');
    await logger.flush();

    expect(batches).toEqual([[{ level: 'error', message: 'failed' }]]);
    vi.advanceTimersByTime(500);
    expect(batches).toHaveLength(1);
  });
});

describe('captureUncaughtErrors', () => {
  it('logs an uncaught error with its stack, without adding a second prefix', async () => {
    const { logger, batches } = setup();
    captureUncaughtErrors(logger, window);
    const error = new Error('boom');

    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught Error: boom', error }));
    await logger.flush();

    expect(batches).toEqual([
      [{ level: 'error', message: 'Uncaught Error: boom', context: error.stack }],
    ]);
  });

  it('logs an unhandled promise rejection with its reason', async () => {
    const { logger, batches } = setup();
    captureUncaughtErrors(logger, window);

    window.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), { reason: new Error('save failed') }),
    );
    await logger.flush();

    expect(batches[0]?.[0]?.message).toBe('Unhandled promise rejection: save failed');
  });
});
