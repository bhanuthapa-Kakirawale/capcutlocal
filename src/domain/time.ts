import { z } from 'zod';

/**
 * Timeline and media time, as an integer count of flicks (docs/TIMELINE.md §1).
 * Every common frame duration and audio sample period is an exact integer number of
 * flicks, so times never drift and equality is reliable. Floating-point seconds exist
 * only at display and FFmpeg-argument boundaries.
 */
export const FLICKS_PER_SECOND = 705_600_000;

export const FlicksSchema = z
  .number()
  .refine(Number.isSafeInteger, 'Flicks must be a safe integer')
  .brand<'Flicks'>();
export type Flicks = z.infer<typeof FlicksSchema>;

/** Validates and brands a raw number as `Flicks`. Throws `ZodError` if it is not a safe integer. */
export function flicks(value: number): Flicks {
  return FlicksSchema.parse(value);
}

/** Lossy: for display only. Never round-trip through this for timeline math. */
export function flicksToSeconds(time: Flicks): number {
  return time / FLICKS_PER_SECOND;
}

/** Rounds to the nearest flick. For constructing times from human input (e.g. "3.5s"). */
export function secondsToFlicks(seconds: number): Flicks {
  return flicks(Math.round(seconds * FLICKS_PER_SECOND));
}

export const RationalSchema = z.strictObject({
  num: z.number().int().positive(),
  den: z.number().int().positive(),
});
export type Rational = z.infer<typeof RationalSchema>;

function rationalEquals(a: Rational, b: Rational): boolean {
  return a.num * b.den === b.num * a.den;
}

/**
 * Frame rates whose frame duration is an exact number of flicks (docs/TIMELINE.md §1 table).
 * Sequence frame rates are restricted to this list (see `SequenceFormatSchema`).
 */
export const STANDARD_FRAME_RATES: ReadonlyArray<{
  readonly label: string;
  readonly rate: Rational;
}> = [
  { label: '23.976', rate: { num: 24000, den: 1001 } },
  { label: '24', rate: { num: 24, den: 1 } },
  { label: '25', rate: { num: 25, den: 1 } },
  { label: '29.97', rate: { num: 30000, den: 1001 } },
  { label: '30', rate: { num: 30, den: 1 } },
  { label: '50', rate: { num: 50, den: 1 } },
  { label: '59.94', rate: { num: 60000, den: 1001 } },
  { label: '60', rate: { num: 60, den: 1 } },
];

export function isStandardFrameRate(rate: Rational): boolean {
  return STANDARD_FRAME_RATES.some((entry) => rationalEquals(entry.rate, rate));
}

/**
 * The exact duration of one frame at `rate`, in flicks. Throws `RangeError` if `rate`
 * does not divide evenly into flicks (true for every entry in `STANDARD_FRAME_RATES`).
 */
export function flicksPerFrame(rate: Rational): Flicks {
  const scaled = FLICKS_PER_SECOND * rate.den;
  if (scaled % rate.num !== 0) {
    throw new RangeError(
      `Frame rate ${rate.num.toString()}/${rate.den.toString()} does not divide evenly into flicks`,
    );
  }
  return flicks(scaled / rate.num);
}

/** Rounds `time` down to the start of the frame at `rate` that contains it. */
export function quantize(time: Flicks, rate: Rational): Flicks {
  const frameDuration = flicksPerFrame(rate);
  return flicks(Math.floor(time / frameDuration) * frameDuration);
}

/**
 * Non-drop-frame `HH:MM:SS:FF` timecode at `rate`. `time` is rounded to the nearest
 * frame first, so it need not already be frame-aligned.
 */
export function formatTimecode(time: Flicks, rate: Rational): string {
  if (time < 0) throw new RangeError('formatTimecode: time must be non-negative');
  const frameDuration = flicksPerFrame(rate);
  const framesPerSecond = Math.round(rate.num / rate.den);
  const totalFrames = Math.round(time / frameDuration);

  const frames = totalFrames % framesPerSecond;
  const totalSeconds = Math.floor(totalFrames / framesPerSecond);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}
