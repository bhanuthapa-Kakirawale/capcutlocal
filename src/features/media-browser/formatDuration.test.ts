import { describe, expect, it } from 'vitest';
import { flicks } from '../../domain/time';
import { formatDuration } from './formatDuration';

describe('formatDuration', () => {
  it('formats sub-hour durations as M:SS', () => {
    expect(formatDuration(flicks(0))).toBe('0:00');
    expect(formatDuration(flicks(705_600_000 * 65))).toBe('1:05');
  });

  it('formats durations at or past an hour as H:MM:SS', () => {
    expect(formatDuration(flicks(705_600_000 * 3661))).toBe('1:01:01');
  });

  it('rounds to the nearest second', () => {
    expect(formatDuration(flicks(705_600_000 * 1.6))).toBe('0:02');
  });
});
