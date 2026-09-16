import { z } from 'zod';
import { MarkerIdSchema } from '../ids';
import { FlicksSchema } from '../time';

/** Sequence markers (docs/TIMELINE.md §10): snap targets, and a chapter-list source once
 * a marker is flagged as a chapter (P6+ — not implemented yet, so no `isChapter` field
 * until an export feature actually reads it). */
export const MarkerColorSchema = z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'purple']);
export type MarkerColor = z.infer<typeof MarkerColorSchema>;

export const MarkerSchema = z.strictObject({
  id: MarkerIdSchema,
  time: FlicksSchema,
  label: z.string(),
  color: MarkerColorSchema,
});
export type Marker = z.infer<typeof MarkerSchema>;
