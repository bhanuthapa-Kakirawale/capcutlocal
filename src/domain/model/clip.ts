import { z } from 'zod';
import { AssetIdSchema, ClipIdSchema, LinkIdSchema } from '../ids';
import { FlicksSchema } from '../time';

/*
 * Clips (docs/TIMELINE.md §3.1). Schema v2 (P4): adds `enabled`. Transform, opacity and
 * effects (P7/P9) and text clips (P7) are not implemented yet and join via a migration
 * in the phase that adds the operations to use them.
 */

const ClipBaseShape = {
  id: ClipIdSchema,
  start: FlicksSchema,
  duration: FlicksSchema,
  sourceIn: FlicksSchema,
  /** Clips sharing a linkId are selected, moved, split and deleted together (A/V sync). */
  linkId: LinkIdSchema.nullable(),
  /** A disabled clip is skipped by render but stays in place, for A/B comparisons. */
  enabled: z.boolean(),
};

export const VideoClipSchema = z.strictObject({
  ...ClipBaseShape,
  type: z.literal('video'),
  assetId: AssetIdSchema,
});
export type VideoClip = z.infer<typeof VideoClipSchema>;

export const AudioClipSchema = z.strictObject({
  ...ClipBaseShape,
  type: z.literal('audio'),
  assetId: AssetIdSchema,
  streamIndex: z.number().int().nonnegative(),
  /** Static in v1; becomes an animated envelope when audio keyframes arrive (P10). */
  gainDb: z.number(),
});
export type AudioClip = z.infer<typeof AudioClipSchema>;
