import { z } from 'zod';
import { FlicksSchema, RationalSchema } from '../time';

/*
 * Media metadata, as parsed from ffprobe and snapshotted onto an Asset at import
 * (docs/MEDIA-PIPELINE.md §3.1). Actual probing arrives in Phase 3; the shape is needed
 * now because Asset.info is part of the Phase 2 project schema.
 */

export const VideoStreamInfoSchema = z.strictObject({
  streamIndex: z.number().int().nonnegative(),
  codec: z.string().min(1),
  profile: z.string().min(1).nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sampleAspectRatio: RationalSchema,
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  frameRate: RationalSchema,
  avgFrameRate: RationalSchema,
  isVariableFrameRate: z.boolean(),
  pixelFormat: z.string().min(1),
  bitDepth: z.number().int().positive(),
  colorPrimaries: z.string().min(1).nullable(),
  colorTransfer: z.string().min(1).nullable(),
  colorSpace: z.string().min(1).nullable(),
  colorRange: z.enum(['tv', 'pc']).nullable(),
  isHdr: z.boolean(),
  hasAlpha: z.boolean(),
  startOffsetFlicks: FlicksSchema,
  durationFlicks: FlicksSchema,
});
export type VideoStreamInfo = z.infer<typeof VideoStreamInfoSchema>;

export const AudioStreamInfoSchema = z.strictObject({
  streamIndex: z.number().int().nonnegative(),
  codec: z.string().min(1),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
  channelLayout: z.string().min(1).nullable(),
  language: z.string().min(1).nullable(),
  startOffsetFlicks: FlicksSchema,
  durationFlicks: FlicksSchema,
});
export type AudioStreamInfo = z.infer<typeof AudioStreamInfoSchema>;

export const ImageInfoSchema = z.strictObject({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  hasAlpha: z.boolean(),
});
export type ImageInfo = z.infer<typeof ImageInfoSchema>;

export const MediaInfoSchema = z.strictObject({
  container: z.string().min(1),
  durationFlicks: FlicksSchema,
  sizeBytes: z.number().int().nonnegative(),
  bitRate: z.number().int().nonnegative().nullable(),
  video: VideoStreamInfoSchema.nullable(),
  audio: z.array(AudioStreamInfoSchema),
  image: ImageInfoSchema.nullable(),
  probedWith: z.string().min(1),
});
export type MediaInfo = z.infer<typeof MediaInfoSchema>;
