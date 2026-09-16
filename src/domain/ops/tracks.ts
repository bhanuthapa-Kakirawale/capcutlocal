import { z } from 'zod';
import { err, ok, type Result } from '../../lib/result';
import type { EditContext } from '../editContext';
import type { EditError } from '../editError';
import { SequenceIdSchema, TrackIdSchema, newTrackId } from '../ids';
import { produce } from '../immer';
import type { Project, Track } from '../model';
import { dissolveOrphanedLinks } from './linkGroups';

/*
 * Track structure ops (docs/TIMELINE.md §5): addTrack, removeTrack, reorderTrack,
 * setTrackFlags. Clip-level ops (insertClips, moveClips, ...) live in ./clips.
 */

export const AddTrackArgsSchema = z.strictObject({
  sequenceId: SequenceIdSchema,
  kind: z.enum(['video', 'audio']),
  name: z.string().trim().min(1).max(200).optional(),
});
export type AddTrackArgs = z.infer<typeof AddTrackArgsSchema>;

/** Adds a new, empty track at the top of its kind's order (index 0 is the bottom layer
 * for video, first in display order for audio — docs/TIMELINE.md §2). */
export function addTrack(
  project: Project,
  args: AddTrackArgs,
  ctx: EditContext,
): Result<Project, EditError> {
  const parsed = AddTrackArgsSchema.safeParse(args);
  if (!parsed.success) return err({ code: 'VALIDATION', message: z.prettifyError(parsed.error) });
  const { sequenceId, kind, name } = parsed.data;

  const sequence = project.sequences[sequenceId];
  if (!sequence)
    return err({ code: 'NOT_FOUND', message: `sequence ${sequenceId} does not exist` });

  return ok(
    produce(project, (draft) => {
      const draftSequence = draft.sequences[sequenceId];
      if (!draftSequence) return;
      const id = newTrackId(ctx.ids);
      const order = kind === 'video' ? draftSequence.videoTracks : draftSequence.audioTracks;
      const trackName = name ?? `${kind === 'video' ? 'V' : 'A'}${(order.length + 1).toString()}`;
      const track: Track =
        kind === 'video'
          ? { id, name: trackName, locked: false, kind: 'video', hidden: false, clips: [] }
          : { id, name: trackName, locked: false, kind: 'audio', muted: false, clips: [] };
      draftSequence.tracks[id] = track;
      order.push(id);
    }),
  );
}

export const RemoveTrackArgsSchema = z.strictObject({
  sequenceId: SequenceIdSchema,
  trackId: TrackIdSchema,
  force: z.boolean().optional(),
});
export type RemoveTrackArgs = z.infer<typeof RemoveTrackArgsSchema>;

/**
 * Removes a track. A non-empty track requires `force` (the UI confirms first). Removing
 * a track can leave a linked clip alone on the other track, so link groups are
 * re-checked afterwards and dissolved if they drop below 2 members (§3.3).
 */
export function removeTrack(
  project: Project,
  args: RemoveTrackArgs,
  _ctx: EditContext,
): Result<Project, EditError> {
  const parsed = RemoveTrackArgsSchema.safeParse(args);
  if (!parsed.success) return err({ code: 'VALIDATION', message: z.prettifyError(parsed.error) });
  const { sequenceId, trackId, force } = parsed.data;

  const sequence = project.sequences[sequenceId];
  const track = sequence?.tracks[trackId];
  if (!sequence || !track)
    return err({ code: 'NOT_FOUND', message: `track ${trackId} does not exist` });
  if (track.clips.length > 0 && !force) {
    return err({
      code: 'TRACK_NOT_EMPTY',
      message: `track ${trackId} has ${track.clips.length.toString()} clip(s); pass force to remove it anyway`,
    });
  }

  return ok(
    produce(project, (draft) => {
      const draftSequence = draft.sequences[sequenceId];
      if (!draftSequence) return;
      // Deleting a key from an Immer draft record is the documented way to remove it.
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete draftSequence.tracks[trackId];
      draftSequence.videoTracks = draftSequence.videoTracks.filter((id) => id !== trackId);
      draftSequence.audioTracks = draftSequence.audioTracks.filter((id) => id !== trackId);
      dissolveOrphanedLinks(draftSequence);
    }),
  );
}

export const ReorderTrackArgsSchema = z.strictObject({
  sequenceId: SequenceIdSchema,
  trackId: TrackIdSchema,
  toIndex: z.number().int().nonnegative(),
});
export type ReorderTrackArgs = z.infer<typeof ReorderTrackArgsSchema>;

/** Moves a track to `toIndex` within its own kind's order. Out-of-range indexes clamp to
 * the end. A no-op (already at that index) returns the same project reference. */
export function reorderTrack(
  project: Project,
  args: ReorderTrackArgs,
  _ctx: EditContext,
): Result<Project, EditError> {
  const parsed = ReorderTrackArgsSchema.safeParse(args);
  if (!parsed.success) return err({ code: 'VALIDATION', message: z.prettifyError(parsed.error) });
  const { sequenceId, trackId, toIndex } = parsed.data;

  const sequence = project.sequences[sequenceId];
  const track = sequence?.tracks[trackId];
  if (!sequence || !track)
    return err({ code: 'NOT_FOUND', message: `track ${trackId} does not exist` });

  const order = track.kind === 'video' ? sequence.videoTracks : sequence.audioTracks;
  const fromIndex = order.indexOf(trackId);
  const clampedToIndex = Math.min(toIndex, order.length - 1);
  if (fromIndex === clampedToIndex) return ok(project);

  return ok(
    produce(project, (draft) => {
      const draftSequence = draft.sequences[sequenceId];
      if (!draftSequence) return;
      const draftOrder =
        track.kind === 'video' ? draftSequence.videoTracks : draftSequence.audioTracks;
      draftOrder.splice(fromIndex, 1);
      draftOrder.splice(clampedToIndex, 0, trackId);
    }),
  );
}

export const SetTrackFlagsArgsSchema = z.strictObject({
  sequenceId: SequenceIdSchema,
  trackId: TrackIdSchema,
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  muted: z.boolean().optional(),
});
export type SetTrackFlagsArgs = z.infer<typeof SetTrackFlagsArgsSchema>;

/** Sets `locked` (any track), `hidden` (video tracks only) or `muted` (audio tracks
 * only). Passing a flag that doesn't exist on the track's kind is a VALIDATION error. */
export function setTrackFlags(
  project: Project,
  args: SetTrackFlagsArgs,
  _ctx: EditContext,
): Result<Project, EditError> {
  const parsed = SetTrackFlagsArgsSchema.safeParse(args);
  if (!parsed.success) return err({ code: 'VALIDATION', message: z.prettifyError(parsed.error) });
  const { sequenceId, trackId, locked, hidden, muted } = parsed.data;

  const sequence = project.sequences[sequenceId];
  const track = sequence?.tracks[trackId];
  if (!sequence || !track)
    return err({ code: 'NOT_FOUND', message: `track ${trackId} does not exist` });
  if (hidden !== undefined && track.kind !== 'video') {
    return err({ code: 'VALIDATION', message: '`hidden` only applies to video tracks' });
  }
  if (muted !== undefined && track.kind !== 'audio') {
    return err({ code: 'VALIDATION', message: '`muted` only applies to audio tracks' });
  }

  return ok(
    produce(project, (draft) => {
      const draftTrack = draft.sequences[sequenceId]?.tracks[trackId];
      if (!draftTrack) return;
      if (locked !== undefined) draftTrack.locked = locked;
      if (draftTrack.kind === 'video' && hidden !== undefined) draftTrack.hidden = hidden;
      if (draftTrack.kind === 'audio' && muted !== undefined) draftTrack.muted = muted;
    }),
  );
}
