import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  FLICKS_PER_SECOND,
  STANDARD_FRAME_RATES,
  flicks,
  flicksPerFrame,
  flicksToSeconds,
  formatTimecode,
  isStandardFrameRate,
  quantize,
  secondsToFlicks,
} from './time';

// docs/TIMELINE.md §1 table, restated here as an independent check on the formula.
const EXPECTED_FRAME_DURATIONS: Record<string, number> = {
  '23.976': 29_429_400,
  '24': 29_400_000,
  '25': 28_224_000,
  '29.97': 23_543_520,
  '30': 23_520_000,
  '50': 14_112_000,
  '59.94': 11_771_760,
  '60': 11_760_000,
};

describe('flicks', () => {
  it('accepts safe integers', () => {
    expect(flicks(0)).toBe(0);
    expect(flicks(FLICKS_PER_SECOND)).toBe(FLICKS_PER_SECOND);
  });

  it('rejects non-integers and unsafe integers', () => {
    expect(() => flicks(1.5)).toThrow();
    expect(() => flicks(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it('round-trips through seconds only as a lossy display conversion', () => {
    expect(flicksToSeconds(flicks(FLICKS_PER_SECOND / 2))).toBeCloseTo(0.5);
    expect(secondsToFlicks(1)).toBe(FLICKS_PER_SECOND);
  });
});

describe('flicksPerFrame', () => {
  it('matches every documented standard frame rate exactly', () => {
    for (const { label, rate } of STANDARD_FRAME_RATES) {
      expect(flicksPerFrame(rate)).toBe(EXPECTED_FRAME_DURATIONS[label]);
    }
  });

  it('rejects a rate that does not divide flicks evenly', () => {
    // 705,600,000 / 13 is not an integer (unlike 7, which divides evenly).
    expect(() => flicksPerFrame({ num: 13, den: 1 })).toThrow(RangeError);
  });
});

describe('isStandardFrameRate', () => {
  it('accepts every table entry, including non-reduced forms', () => {
    for (const { rate } of STANDARD_FRAME_RATES) {
      expect(isStandardFrameRate(rate)).toBe(true);
    }
    expect(isStandardFrameRate({ num: 48, den: 2 })).toBe(true); // reduces to 24/1
  });

  it('rejects a rate not in the table', () => {
    expect(isStandardFrameRate({ num: 15, den: 1 })).toBe(false);
  });
});

describe('quantize', () => {
  const rate = { num: 30, den: 1 };
  const frame = flicksPerFrame(rate);

  it('rounds down to the containing frame boundary', () => {
    expect(quantize(flicks(0), rate)).toBe(0);
    expect(quantize(flicks(frame - 1), rate)).toBe(0);
    expect(quantize(flicks(frame), rate)).toBe(frame);
    expect(quantize(flicks(frame + 1), rate)).toBe(frame);
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 * frame }), (t) => {
        const once = quantize(flicks(t), rate);
        expect(quantize(once, rate)).toBe(once);
      }),
    );
  });

  it('is monotonically non-decreasing', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 * frame }),
        fc.integer({ min: 0, max: 60 * frame }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(quantize(flicks(lo), rate)).toBeLessThanOrEqual(quantize(flicks(hi), rate));
        },
      ),
    );
  });

  it('never exceeds the input time', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 * frame }), (t) => {
        expect(quantize(flicks(t), rate)).toBeLessThanOrEqual(t);
      }),
    );
  });
});

describe('formatTimecode', () => {
  const rate30 = { num: 30, den: 1 };
  const frame30 = flicksPerFrame(rate30);

  it('formats zero and single-frame offsets', () => {
    expect(formatTimecode(flicks(0), rate30)).toBe('00:00:00:00');
    expect(formatTimecode(flicks(frame30), rate30)).toBe('00:00:00:01');
  });

  it('wraps frames into seconds, seconds into minutes, minutes into hours', () => {
    expect(formatTimecode(flicks(30 * frame30), rate30)).toBe('00:00:01:00');
    expect(formatTimecode(flicks(60 * 30 * frame30), rate30)).toBe('00:01:00:00');
    expect(formatTimecode(flicks(60 * 60 * 30 * frame30), rate30)).toBe('01:00:00:00');
  });

  it('uses the rounded nominal rate as the frame modulus for NTSC rates', () => {
    const rate2997 = { num: 30000, den: 1001 };
    const frame2997 = flicksPerFrame(rate2997);
    // Non-drop-frame: frame 30 always rolls to the next second, even at 29.97.
    expect(formatTimecode(flicks(29 * frame2997), rate2997)).toBe('00:00:00:29');
    expect(formatTimecode(flicks(30 * frame2997), rate2997)).toBe('00:00:01:00');
  });

  it('rejects negative time', () => {
    expect(() => formatTimecode(flicks(-1), rate30)).toThrow(RangeError);
  });
});
