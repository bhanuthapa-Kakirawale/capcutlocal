import { z } from 'zod';
import { TrackIdSchema } from '../ids';
import { AudioClipSchema, VideoClipSchema } from './clip';

/*
 * Tracks (docs/TIMELINE.md §3). Caption tracks (P8) and transitions on video/audio
 * tracks (P9) join later. Clips are stored sorted by `start` inside their track
 * (invariant, checked by `checkInvariants` in src/domain/invariants.ts).
 */

export const VideoTrackSchema = z.strictObject({
  id: TrackIdSchema,
  name: z.string().min(1),
  locked: z.boolean(),
  kind: z.literal('video'),
  hidden: z.boolean(),
  clips: z.array(VideoClipSchema),
});
export type VideoTrack = z.infer<typeof VideoTrackSchema>;

export const AudioTrackSchema = z.strictObject({
  id: TrackIdSchema,
  name: z.string().min(1),
  locked: z.boolean(),
  kind: z.literal('audio'),
  muted: z.boolean(),
  clips: z.array(AudioClipSchema),
});
export type AudioTrack = z.infer<typeof AudioTrackSchema>;

export const TrackSchema = z.discriminatedUnion('kind', [VideoTrackSchema, AudioTrackSchema]);
export type Track = z.infer<typeof TrackSchema>;
