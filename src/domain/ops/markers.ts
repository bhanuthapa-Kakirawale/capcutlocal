import { z } from 'zod';
import { err, ok, type Result } from '../../lib/result';
import type { EditContext } from '../editContext';
import type { EditError } from '../editError';
import { MarkerIdSchema, SequenceIdSchema, newMarkerId } from '../ids';
import { produce } from '../immer';
import { MarkerColorSchema } from '../model';
import type { Project } from '../model';
import { flicksPerFrame, roundToFrame, FlicksSchema } from '../time';

/*
 * Marker ops (docs/TIMELINE.md §10): addMarker, removeMarker, updateMarker. Markers are
 * snap targets (§6) and are kept sorted by time, same as clips within a track.
 */

export const AddMarkerArgsSchema = z.strictObject({
  sequenceId: SequenceIdSchema,
  time: FlicksSchema,
  label: z.string().trim().min(1).max(200),
  color: MarkerColorSchema,
});
export type AddMarkerArgs = z.infer<typeof AddMarkerArgsSchema>;

/** Adds a marker, minting its id (ADR-002). Kept sorted by time. */
export function addMarker(
  project: Project,
  args: AddMarkerArgs,
  ctx: EditContext,
): Result<Project, EditError> {
  const parsed = AddMarkerArgsSchema.safeParse(args);
  if (!parsed.success) return err({ code: 'VALIDATION', message: z.prettifyError(parsed.error) });
  const { sequenceId, time, label, color } = parsed.data;

  const sequence = project.sequences[sequenceId];
  if (!sequence)
    return err({ code: 'NOT_FOUND', message: `sequence ${sequenceId} does not exist` });

  const frameDuration = flicksPerFrame(sequence.format.frameRate);
  const alignedTime = roundToFrame(time, frameDuration);

  return ok(
    produce(project, (draft) => {
      const draftSequence = draft.sequences[sequenceId];
      if (!draftSequence) return;
      const id = newMarkerId(ctx.ids);
      const insertIndex = draftSequence.markers.findIndex((m) => m.time >= alignedTime);
      const marker = { id, time: alignedTime, label, color };
      if (insertIndex === -1) draftSequence.markers.push(marker);
      else draftSequence.markers.splice(insertIndex, 0, marker);
    }),
  );
}

export const RemoveMarkerArgsSchema = z.strictObject({
  sequenceId: SequenceIdSchema,
  markerId: MarkerIdSchema,
});
export type RemoveMarkerArgs = z.infer<typeof RemoveMarkerArgsSchema>;

/** Removes a marker. */
export function removeMarker(
  project: Project,
  args: RemoveMarkerArgs,
  _ctx: EditContext,
): Result<Project, EditError> {
  const parsed = RemoveMarkerArgsSchema.safeParse(args);
  if (!parsed.success) return err({ code: 'VALIDATION', message: z.prettifyError(parsed.error) });
  const { sequenceId, markerId } = parsed.data;

  const sequence = project.sequences[sequenceId];
  const exists = sequence?.markers.some((m) => m.id === markerId);
  if (!sequence || !exists)
    return err({ code: 'NOT_FOUND', message: `marker ${markerId} does not exist` });

  return ok(
    produce(project, (draft) => {
      const draftSequence = draft.sequences[sequenceId];
      if (!draftSequence) return;
      draftSequence.markers = draftSequence.markers.filter((m) => m.id !== markerId);
    }),
  );
}

export const UpdateMarkerArgsSchema = z.strictObject({
  sequenceId: SequenceIdSchema,
  markerId: MarkerIdSchema,
  time: FlicksSchema.optional(),
  label: z.string().trim().min(1).max(200).optional(),
  color: MarkerColorSchema.optional(),
});
export type UpdateMarkerArgs = z.infer<typeof UpdateMarkerArgsSchema>;

/** Updates a marker's time, label and/or color. Re-sorts by time only when `time` changes. */
export function updateMarker(
  project: Project,
  args: UpdateMarkerArgs,
  _ctx: EditContext,
): Result<Project, EditError> {
  const parsed = UpdateMarkerArgsSchema.safeParse(args);
  if (!parsed.success) return err({ code: 'VALIDATION', message: z.prettifyError(parsed.error) });
  const { sequenceId, markerId, time, label, color } = parsed.data;

  const sequence = project.sequences[sequenceId];
  const marker = sequence?.markers.find((m) => m.id === markerId);
  if (!sequence || !marker)
    return err({ code: 'NOT_FOUND', message: `marker ${markerId} does not exist` });

  const frameDuration = flicksPerFrame(sequence.format.frameRate);
  const alignedTime = time !== undefined ? roundToFrame(time, frameDuration) : undefined;

  return ok(
    produce(project, (draft) => {
      const draftSequence = draft.sequences[sequenceId];
      const draftMarker = draftSequence?.markers.find((m) => m.id === markerId);
      if (!draftSequence || !draftMarker) return;
      if (label !== undefined) draftMarker.label = label;
      if (color !== undefined) draftMarker.color = color;
      if (alignedTime !== undefined && alignedTime !== draftMarker.time) {
        draftMarker.time = alignedTime;
        draftSequence.markers.sort((a, b) => a.time - b.time);
      }
    }),
  );
}
