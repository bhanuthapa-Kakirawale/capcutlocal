import { z } from 'zod';
import { SequenceIdSchema, TrackIdSchema } from '../ids';
import { RationalSchema, isStandardFrameRate } from '../time';
import { TrackSchema } from './track';

/*
 * Sequences (docs/TIMELINE.md §2). Caption tracks (P8) and markers (P4) join later.
 */

const DimensionSchema = z
  .number()
  .int()
  .min(16)
  .max(8192)
  .refine((value) => value % 2 === 0, { message: 'must be even' });

export const SequenceFormatSchema = z.strictObject({
  width: DimensionSchema,
  height: DimensionSchema,
  frameRate: RationalSchema.refine(isStandardFrameRate, {
    message: 'frameRate must be one of the standard rates in STANDARD_FRAME_RATES',
  }),
  sampleRate: z.literal(48000),
  audioChannels: z.literal(2),
});
export type SequenceFormat = z.infer<typeof SequenceFormatSchema>;

export const SequenceSchema = z.strictObject({
  id: SequenceIdSchema,
  name: z.string().min(1),
  format: SequenceFormatSchema,
  tracks: z.record(TrackIdSchema, TrackSchema),
  /** Compositing order: index 0 is the bottom layer. */
  videoTracks: z.array(TrackIdSchema),
  /** Display order; mixing itself is order-independent. */
  audioTracks: z.array(TrackIdSchema),
});
export type Sequence = z.infer<typeof SequenceSchema>;

/** Presets offered by "New sequence" (docs/TIMELINE.md §2). All default to 30 fps. */
export const SEQUENCE_FORMAT_PRESETS = {
  youtube1080p: {
    width: 1920,
    height: 1080,
    frameRate: { num: 30, den: 1 },
    sampleRate: 48000,
    audioChannels: 2,
  },
  shorts: {
    width: 1080,
    height: 1920,
    frameRate: { num: 30, den: 1 },
    sampleRate: 48000,
    audioChannels: 2,
  },
  uhd4k: {
    width: 3840,
    height: 2160,
    frameRate: { num: 30, den: 1 },
    sampleRate: 48000,
    audioChannels: 2,
  },
  square: {
    width: 1080,
    height: 1080,
    frameRate: { num: 30, den: 1 },
    sampleRate: 48000,
    audioChannels: 2,
  },
} as const satisfies Record<string, SequenceFormat>;
export type SequenceFormatPreset = keyof typeof SEQUENCE_FORMAT_PRESETS;
