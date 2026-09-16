import type { Draft } from 'immer';
import { z } from 'zod';
import { err, ok, type Result } from '../../lib/result';
import type { EditContext } from '../editContext';
import type { EditError } from '../editError';
import {
  AssetIdSchema,
  ClipIdSchema,
  SequenceIdSchema,
  TrackIdSchema,
  newClipId,
  newLinkId,
  type ClipId,
  type LinkId,
  type TrackId,
} from '../ids';
import { produce } from '../immer';
import type { AudioClip, Project, Sequence, Track, VideoClip } from '../model';
import { flicks, flicksPerFrame, roundToFrame, FlicksSchema } from '../time';
import { dissolveOrphanedLinks } from './linkGroups';
import {
  collectRippleIndices,
  collectRippleSet,
  mergeRanges,
  rippleShift,
  shiftClips,
  shiftClipsByIndex,
  type TimeRange,
} from './ripple';

/*
 * Clip-level edit ops (docs/TIMELINE.md §5): insertClips, moveClips, trimClip,
 * splitClips, deleteClips (lift), rippleDelete, closeGap, rollEdit. Track structure ops
 * live in ./tracks. slipClip (P7) and slideClip (P9) are out of scope here.
 */

type Clip = VideoClip | AudioClip;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * `Track` is a discriminated union on `kind`, so Immer's `Draft<Track>['clips']` is a
 * union of two differently-typed arrays — TS can't see that a clip's own `type` always
 * matches its track's `kind` (checked at every call site that builds or moves a clip),
 * so these two helpers cross that gap with a single, localized cast.
 */
function clipsOf(track: Draft<Track>): Clip[] {
  return track.clips;
}
function setClips(track: Draft<Track>, clips: Clip[]): void {
  track.clips = clips as unknown as Draft<Track>['clips'];
}

function locateClip(
  sequence: Sequence,
  clipId: ClipId,
): { track: Track; clip: Clip; index: number } | undefined {
  for (const track of Object.values(sequence.tracks)) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index !== -1) {
      const clip = track.clips[index];
      if (clip) return { track, clip, index };
    }
  }
  return undefined;
}

/**
 * Clears `[rangeStart, rangeEnd)` on `track`, trimming or splitting whatever overlaps it
 * (docs/TIMELINE.md §5's `insertClips`/`moveClips` 'overwrite' mode). Returns whether it
 * actually removed or shrank any existing clip — callers use this to skip
 * `dissolveOrphanedLinks` when there was nothing to orphan.
 */
function overwriteRange(
  track: Draft<Track>,
  rangeStart: number,
  rangeEnd: number,
  ctx: EditContext,
): boolean {
  // Fast path: appending past every existing clip (the common case — placing a new
  // clip at the end of a track) can't overwrite anything, so skip scanning the rest of
  // the array. `at(-1)` is one indexed read regardless of the track's length; the loop
  // below reads every element, which costs roughly 2µs/element through an Immer draft.
  const lastClip = track.clips.at(-1);
  if (!lastClip || lastClip.start + lastClip.duration <= rangeStart) return false;

  const next: Clip[] = [];
  for (const clip of clipsOf(track)) {
    const clipStart = clip.start;
    const clipEnd = clip.start + clip.duration;
    if (clipEnd <= rangeStart || clipStart >= rangeEnd) {
      next.push(clip);
    } else if (clipStart < rangeStart && clipEnd > rangeEnd) {
      const rightSourceIn = clip.sourceIn + (rangeEnd - clipStart);
      next.push({ ...clip, duration: flicks(rangeStart - clipStart) });
      next.push({
        ...clip,
        id: newClipId(ctx.ids),
        start: flicks(rangeEnd),
        sourceIn: flicks(rightSourceIn),
        duration: flicks(clipEnd - rangeEnd),
        linkId: null,
      });
    } else if (clipStart < rangeStart) {
      next.push({ ...clip, duration: flicks(rangeStart - clipStart) });
    } else if (clipEnd > rangeEnd) {
      const trimmedFront = rangeEnd - clipStart;
      next.push({
        ...clip,
        start: flicks(rangeEnd),
        sourceIn: flicks(clip.sourceIn + trimmedFront),
        duration: flicks(clipEnd - rangeEnd),
      });
    }
    // else: fully inside the range — dropped.
  }
  setClips(track, next);
  return true;
}

/**
 * Inserts `clip` into `trackId`, either overwriting whatever's underneath or rippling
 * later clips (and their linked partners) right to make room. Returns whether an
 * existing clip was removed or shrunk (see `overwriteRange`'s doc comment) — ripple
 * mode never does, so it always returns false.
 */
function placeClipOnTrack(
  sequence: Draft<Sequence>,
  trackId: TrackId,
  clip: Clip,
  mode: 'overwrite' | 'insert',
  ctx: EditContext,
): boolean {
  const track = sequence.tracks[trackId];
  if (!track) return false;
  const rangeStart = clip.start;
  const rangeEnd = clip.start + clip.duration;

  let overwrote = false;
  if (mode === 'overwrite') {
    overwrote = overwriteRange(track, rangeStart, rangeEnd, ctx);
  } else {
    const rippleSet = collectRippleSet(sequence, new Set([trackId]), rangeStart);
    shiftClips(sequence, rippleSet, clip.duration);
  }

  // Fast path: appending past every existing clip skips scanning for an insert point
  // (same reasoning as overwriteRange's fast path above).
  const clips = clipsOf(track);
  const last = clips.at(-1);
  if (!last || last.start < rangeStart) {
    clips.push(clip);
  } else {
    const insertIndex = clips.findIndex((c) => c.start >= rangeStart);
    if (insertIndex === -1) clips.push(clip);
    else clips.splice(insertIndex, 0, clip);
  }
  return overwrote;
}

const ClipPlacementSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('video'),
    trackId: TrackIdSchema,
    assetId: AssetIdSchema,
    sourceIn: FlicksSchema,
    duration: FlicksSchema,
  }),
  z.strictObject({
    type: z.literal('audio'),
    trackId: TrackIdSchema,
    assetId: AssetIdSchema,
    sourceIn: FlicksSchema,
    duration: FlicksSchema,
    streamIndex: z.number().int().nonnegative(),
    gainDb: z.number(),
  }),
]);

export const InsertClipsArgsSchema = z.strictObject({
  sequenceId: SequenceIdSchema,
  at: FlicksSchema,
  mode: z.enum(['overwrite', 'insert']),
  placements: z.array(ClipPlacementSchema).min(1),
  /** Mints one shared linkId across every placement in this call (A/V sync, §3.3). */
  link: z.boolean().optional(),
});
export type InsertClipsArgs = z.infer<typeof InsertClipsArgsSchema>;

/** Places one or more clips at `at` on their target tracks, from a media asset
 * (docs/TIMELINE.md §5; ADR-002 — this op is where new ClipIds are minted). */
export function insertClips(
  project: Project,
  args: InsertClipsArgs,
  ctx: EditContext,
): Result<Project, EditError> {
  const parsed = InsertClipsArgsSchema.safeParse(args);
  if (!parsed.success) return err({ code: 'VALIDATION', message: z.prettifyError(parsed.error) });
  const { sequenceId, mode, placements, link } = parsed.data;

  const sequence = project.sequences[sequenceId];
  if (!sequence)
    return err({ code: 'NOT_FOUND', message: `sequence ${sequenceId} does not exist` });

  for (const placement of placements) {
    const track = sequence.tracks[placement.trackId];
    if (!track)
      return err({ code: 'NOT_FOUND', message: `track ${placement.trackId} does not exist` });
    if (track.locked) {
      return err({ code: 'TRACK_LOCKED', message: `track ${placement.trackId} is locked` });
    }
    if (placement.type !== track.kind) {
      return err({
        code: 'COLLISION',
        message: `cannot place a ${placement.type} clip on a ${track.kind} track`,
      });
    }
  }

  const frameDuration = flicksPerFrame(sequence.format.frameRate);
  const alignedAt = roundToFrame(parsed.data.at, frameDuration);
  const sharedLinkId = link && placements.length > 1 ? newLinkId(ctx.ids) : null;

  return ok(
    produce(project, (draft) => {
      const draftSequence = draft.sequences[sequenceId];
      if (!draftSequence) return;
      let overwroteAny = false;
      for (const placement of placements) {
        const id = newClipId(ctx.ids);
        const clip: Clip =
          placement.type === 'video'
            ? {
                id,
                start: alignedAt,
                duration: placement.duration,
                sourceIn: placement.sourceIn,
                linkId: sharedLinkId,
                enabled: true,
                type: 'video',
                assetId: placement.assetId,
              }
            : {
                id,
                start: alignedAt,
                duration: placement.duration,
                sourceIn: placement.sourceIn,
                linkId: sharedLinkId,
                enabled: true,
                type: 'audio',
                assetId: placement.assetId,
                streamIndex: placement.streamIndex,
                gainDb: placement.gainDb,
              };
        overwroteAny =
          placeClipOnTrack(draftSequence, placement.trackId, clip, mode, ctx) || overwroteAny;
      }
      // Ripple mode never orphans a link (it only shifts clips), so this is skipped
      // unless an overwrite actually removed or shrank something.
      if (overwroteAny) dissolveOrphanedLinks(draftSequence);
    }),
  );
}

export const MoveClipsArgsSchema = z.strictObject({
  sequenceId: SequenceIdSchema,
  moves: z.array(z.strictObject({ clipId: ClipIdSchema, toTrackId: TrackIdSchema })).min(1),
  deltaTime: FlicksSchema,
  mode: z.enum(['overwrite', 'insert']),
});
export type MoveClipsArgs = z.infer<typeof MoveClipsArgsSchema>;

/**
 * Moves a selection by `deltaTime`, keeping relative positions (the delta is clamped so
 * no clip's `start` goes negative). Linked partners not explicitly listed follow in
 * time without changing track. Same `overwrite`/`insert` modes as `insertClips`.
 */
export function moveClips(
  project: Project,
  args: MoveClipsArgs,
  ctx: EditContext,
): Result<Project, EditError> {
  const parsed = MoveClipsArgsSchema.safeParse(args);
  if (!parsed.success) return err({ code: 'VALIDATION', message: z.prettifyError(parsed.error) });
  const { sequenceId, moves, mode } = parsed.data;

  const sequence = project.sequences[sequenceId];
  if (!sequence)
    return err({ code: 'NOT_FOUND', message: `sequence ${sequenceId} does not exist` });

  const resolved = new Map<
    ClipId,
    { clip: Clip; fromTrackId: TrackId; fromIndex: number; toTrackId: TrackId }
  >();
  for (const move of moves) {
    const located = locateClip(sequence, move.clipId);
    if (!located) return err({ code: 'NOT_FOUND', message: `clip ${move.clipId} does not exist` });
    const destTrack = sequence.tracks[move.toTrackId];
    if (!destTrack)
      return err({ code: 'NOT_FOUND', message: `track ${move.toTrackId} does not exist` });
    if (located.track.locked || destTrack.locked) {
      return err({ code: 'TRACK_LOCKED', message: 'cannot move a clip on or onto a locked track' });
    }
    if (located.clip.type !== destTrack.kind) {
      return err({
        code: 'COLLISION',
        message: `cannot move a ${located.clip.type} clip onto a ${destTrack.kind} track`,
      });
    }
    resolved.set(located.clip.id, {
      clip: located.clip,
      fromTrackId: located.track.id,
      fromIndex: located.index,
      toTrackId: move.toTrackId,
    });
  }

  for (const track of Object.values(sequence.tracks)) {
    track.clips.forEach((clip, index) => {
      const already = resolved.get(clip.id);
      if (already || clip.linkId === null) return;
      const isLinkedToMoving = [...resolved.values()].some((r) => r.clip.linkId === clip.linkId);
      if (isLinkedToMoving)
        resolved.set(clip.id, {
          clip,
          fromTrackId: track.id,
          fromIndex: index,
          toTrackId: track.id,
        });
    });
  }
  for (const { clip, fromTrackId } of resolved.values()) {
    if (sequence.tracks[fromTrackId]?.locked) {
      return err({
        code: 'TRACK_LOCKED',
        message: `linked partner ${clip.id} is on a locked track`,
      });
    }
  }

  const frameDuration = flicksPerFrame(sequence.format.frameRate);
  const roundedDelta = roundToFrame(parsed.data.deltaTime, frameDuration);
  const minStart = Math.min(...[...resolved.values()].map((r) => r.clip.start));
  const effectiveDelta = Math.max(roundedDelta, -minStart);
  const changesTrack = [...resolved.values()].some((r) => r.toTrackId !== r.fromTrackId);
  if (effectiveDelta === 0 && !changesTrack) return ok(project);

  return ok(
    produce(project, (draft) => {
      const draftSequence = draft.sequences[sequenceId];
      if (!draftSequence) return;

      // Grouped by source track and removed in descending index order (known from the
      // plain pre-image, so no `.findIndex` re-scan of the draft) so that removing one
      // clip never invalidates another still-pending index on the same track.
      const byFromTrack = new Map<
        TrackId,
        { clipId: ClipId; index: number; toTrackId: TrackId }[]
      >();
      for (const { clip, fromTrackId, fromIndex, toTrackId } of resolved.values()) {
        const list = byFromTrack.get(fromTrackId) ?? [];
        list.push({ clipId: clip.id, index: fromIndex, toTrackId });
        byFromTrack.set(fromTrackId, list);
      }

      const moving: { clip: Clip; toTrackId: TrackId }[] = [];
      for (const [fromTrackId, entries] of byFromTrack) {
        const draftTrack = draftSequence.tracks[fromTrackId];
        if (!draftTrack) continue;
        for (const { index, toTrackId } of [...entries].sort((a, b) => b.index - a.index)) {
          const [removed] = draftTrack.clips.splice(index, 1);
          if (!removed) continue;
          moving.push({
            clip: { ...removed, start: flicks(removed.start + effectiveDelta) },
            toTrackId,
          });
        }
      }

      moving.sort((a, b) => a.clip.start - b.clip.start);
      let overwroteAny = false;
      for (const { clip, toTrackId } of moving) {
        overwroteAny = placeClipOnTrack(draftSequence, toTrackId, clip, mode, ctx) || overwroteAny;
      }
      if (overwroteAny) dissolveOrphanedLinks(draftSequence);
    }),
  );
}

export const TrimClipArgsSchema = z.strictObject({
  sequenceId: SequenceIdSchema,
  clipId: ClipIdSchema,
  edge: z.enum(['head', 'tail']),
  delta: FlicksSchema,
  ripple: z.boolean().optional(),
});
export type TrimClipArgs = z.infer<typeof TrimClipArgsSchema>;

/**
 * Trims `clipId`'s head (moves `start`/`sourceIn`, shrinks/grows `duration` from the
 * front) or tail (grows/shrinks `duration`). The requested `delta` is rounded to the
 * frame grid, then clamped by media bounds and (unless `ripple`) the neighboring clip;
 * inspect the returned project to see how much was actually applied. `ripple: true`
 * shifts later clips (and their linked partners) instead of leaving or overlapping a gap.
 */
export function trimClip(
  project: Project,
  args: TrimClipArgs,
  _ctx: EditContext,
): Result<Project, EditError> {
  const parsed = TrimClipArgsSchema.safeParse(args);
  if (!parsed.success) return err({ code: 'VALIDATION', message: z.prettifyError(parsed.error) });
  const { sequenceId, clipId, edge, ripple } = parsed.data;

  const sequence = project.sequences[sequenceId];
  if (!sequence)
    return err({ code: 'NOT_FOUND', message: `sequence ${sequenceId} does not exist` });
  const located = locateClip(sequence, clipId);
  if (!located) return err({ code: 'NOT_FOUND', message: `clip ${clipId} does not exist` });
  if (located.track.locked)
    return err({ code: 'TRACK_LOCKED', message: `track ${located.track.id} is locked` });

  const asset = project.assets[located.clip.assetId];
  if (!asset)
    return err({ code: 'NOT_FOUND', message: `asset ${located.clip.assetId} does not exist` });
  const mediaBound = asset.kind === 'image' ? null : asset.info.durationFlicks;

  const frameDuration = flicksPerFrame(sequence.format.frameRate);
  const roundedDelta = roundToFrame(parsed.data.delta, frameDuration);
  const { clip, track, index } = located;
  const prev = index > 0 ? track.clips[index - 1] : undefined;
  const next = index < track.clips.length - 1 ? track.clips[index + 1] : undefined;

  let clampedDelta: number;
  if (edge === 'head') {
    let minDelta = mediaBound !== null ? 0 - clip.sourceIn : -Infinity;
    const maxDelta = clip.duration - frameDuration;
    if (!ripple) {
      const prevEnd = prev ? prev.start + prev.duration : 0;
      minDelta = Math.max(minDelta, prevEnd - clip.start);
    }
    clampedDelta = clamp(roundedDelta, minDelta, maxDelta);
  } else {
    const minDelta = -(clip.duration - frameDuration);
    let maxDelta = mediaBound !== null ? mediaBound - clip.sourceIn - clip.duration : Infinity;
    if (!ripple) {
      const nextStart = next ? next.start : Infinity;
      maxDelta = Math.min(maxDelta, nextStart - (clip.start + clip.duration));
    }
    clampedDelta = clamp(roundedDelta, minDelta, maxDelta);
  }
  if (clampedDelta === 0) return ok(project);

  // Computed from the plain pre-image (fast) rather than inside produce (see
  // collectRippleIndices's doc comment) so this stays fast on a large sequence.
  const oldEnd = clip.start + clip.duration;
  const rippleIndices = ripple ? collectRippleIndices(sequence, new Set([track.id]), oldEnd) : null;

  return ok(
    produce(project, (draft) => {
      const draftSequence = draft.sequences[sequenceId];
      const draftTrack = draftSequence?.tracks[track.id];
      const draftClip = draftTrack?.clips[index];
      if (!draftSequence || !draftTrack || !draftClip) return;

      if (edge === 'head') {
        draftClip.sourceIn = flicks(draftClip.sourceIn + clampedDelta);
        draftClip.duration = flicks(draftClip.duration - clampedDelta);
        if (rippleIndices) {
          shiftClipsByIndex(draftSequence, rippleIndices, -clampedDelta);
        } else {
          draftClip.start = flicks(draftClip.start + clampedDelta);
        }
      } else {
        draftClip.duration = flicks(draftClip.duration + clampedDelta);
        if (rippleIndices) {
          shiftClipsByIndex(draftSequence, rippleIndices, clampedDelta);
        }
      }
    }),
  );
}

export const SplitClipsArgsSchema = z.strictObject({
  sequenceId: SequenceIdSchema,
  at: FlicksSchema,
  /** Omit to split every clip under `at` on every unlocked track. */
  clipIds: z.array(ClipIdSchema).optional(),
});
export type SplitClipsArgs = z.infer<typeof SplitClipsArgsSchema>;

/** Razors the given clips (or, if omitted, every clip under `at`) at `at`. Each split
 * produces a new right-hand clip with a fresh id; right halves of clips that were
 * linked to each other in this same call share a new linkId (docs/TIMELINE.md §3.3, §5). */
export function splitClips(
  project: Project,
  args: SplitClipsArgs,
  ctx: EditContext,
): Result<Project, EditError> {
  const parsed = SplitClipsArgsSchema.safeParse(args);
  if (!parsed.success) return err({ code: 'VALIDATION', message: z.prettifyError(parsed.error) });
  const { sequenceId, clipIds } = parsed.data;

  const sequence = project.sequences[sequenceId];
  if (!sequence)
    return err({ code: 'NOT_FOUND', message: `sequence ${sequenceId} does not exist` });

  const frameDuration = flicksPerFrame(sequence.format.frameRate);
  const at = roundToFrame(parsed.data.at, frameDuration);

  const targets: { trackId: TrackId; clip: Clip; index: number }[] = [];
  if (clipIds) {
    for (const clipId of clipIds) {
      const located = locateClip(sequence, clipId);
      if (!located) return err({ code: 'NOT_FOUND', message: `clip ${clipId} does not exist` });
      if (located.track.locked) {
        return err({ code: 'TRACK_LOCKED', message: `track ${located.track.id} is locked` });
      }
      if (!(located.clip.start < at && at < located.clip.start + located.clip.duration)) {
        return err({
          code: 'VALIDATION',
          message: `clip ${clipId} does not span time ${at.toString()}`,
        });
      }
      targets.push({ trackId: located.track.id, clip: located.clip, index: located.index });
    }
  } else {
    for (const track of Object.values(sequence.tracks)) {
      if (track.locked) continue;
      track.clips.forEach((clip, index) => {
        if (clip.start < at && at < clip.start + clip.duration) {
          targets.push({ trackId: track.id, clip, index });
        }
      });
    }
  }
  if (targets.length === 0) return ok(project);

  const newLinkIdByOriginal = new Map<LinkId, LinkId>();
  for (const target of targets) {
    const originalLinkId = target.clip.linkId;
    if (originalLinkId === null || newLinkIdByOriginal.has(originalLinkId)) continue;
    const groupSize = targets.filter((t) => t.clip.linkId === originalLinkId).length;
    if (groupSize >= 2) newLinkIdByOriginal.set(originalLinkId, newLinkId(ctx.ids));
  }

  // Sorted so that, within a track, earlier splits are applied first — each one
  // inserts a clip after it, which is why later same-track targets need their
  // pre-image index bumped by how many insertions on that track came before them.
  const sortedTargets = [...targets].sort((a, b) => a.index - b.index);
  const insertionsSoFar = new Map<TrackId, number>();

  return ok(
    produce(project, (draft) => {
      const draftSequence = draft.sequences[sequenceId];
      if (!draftSequence) return;
      for (const { trackId, clip, index } of sortedTargets) {
        const draftTrack = draftSequence.tracks[trackId];
        if (!draftTrack) continue;
        const adjustedIndex = index + (insertionsSoFar.get(trackId) ?? 0);
        const original = draftTrack.clips[adjustedIndex];
        if (!original || original.id !== clip.id) continue;

        const rightLinkId =
          original.linkId !== null ? (newLinkIdByOriginal.get(original.linkId) ?? null) : null;
        const right: Clip = {
          ...original,
          id: newClipId(ctx.ids),
          start: flicks(at),
          sourceIn: flicks(original.sourceIn + (at - original.start)),
          duration: flicks(original.start + original.duration - at),
          linkId: rightLinkId,
        };
        original.duration = flicks(at - original.start);
        clipsOf(draftTrack).splice(adjustedIndex + 1, 0, right);
        insertionsSoFar.set(trackId, (insertionsSoFar.get(trackId) ?? 0) + 1);
      }
      // No dissolveOrphanedLinks call needed here (unlike insertClips/moveClips): a
      // split never drops a link group below 2 members. The left half keeps the
      // original id and linkId, so any untouched partner elsewhere is unaffected; the
      // right half either gets a freshly-shared linkId (when 2+ targets shared one, set
      // up above) or null (a lone split, correctly unlinked from the start).
    }),
  );
}

type ResolvedClips = {
  clipIds: Set<ClipId>;
  /** Ascending indices per affected track, from the plain pre-image (fast to scan) —
   * lets callers `splice` each track by index instead of `.filter`ing the whole draft
   * array (which must read every element regardless of how few are actually removed). */
  indicesByTrack: Map<TrackId, number[]>;
};

/** Resolves an explicit clip selection to the full set including linked siblings
 * (§3.3: linked clips are deleted together), rejecting anything on a locked track. */
function resolveClipsWithLinkedSiblings(
  sequence: Sequence,
  clipIds: readonly ClipId[],
): Result<ResolvedClips, EditError> {
  const resolvedIds = new Set<ClipId>();
  const targetLinkIds = new Set<LinkId>();
  for (const clipId of clipIds) {
    const located = locateClip(sequence, clipId);
    if (!located) return err({ code: 'NOT_FOUND', message: `clip ${clipId} does not exist` });
    if (located.track.locked) {
      return err({ code: 'TRACK_LOCKED', message: `track ${located.track.id} is locked` });
    }
    resolvedIds.add(located.clip.id);
    if (located.clip.linkId !== null) targetLinkIds.add(located.clip.linkId);
  }

  const indicesByTrack = new Map<TrackId, number[]>();
  for (const track of Object.values(sequence.tracks)) {
    const indices: number[] = [];
    for (let index = 0; index < track.clips.length; index += 1) {
      const clip = track.clips[index];
      if (!clip) continue;
      const isLinkedSibling =
        clip.linkId !== null && targetLinkIds.has(clip.linkId) && !resolvedIds.has(clip.id);
      if (!resolvedIds.has(clip.id) && !isLinkedSibling) continue;
      if (isLinkedSibling) {
        if (track.locked)
          return err({ code: 'TRACK_LOCKED', message: `track ${track.id} is locked` });
        resolvedIds.add(clip.id);
      }
      indices.push(index);
    }
    if (indices.length > 0) indicesByTrack.set(track.id, indices);
  }
  return ok({ clipIds: resolvedIds, indicesByTrack });
}

export const DeleteClipsArgsSchema = z.strictObject({
  sequenceId: SequenceIdSchema,
  clipIds: z.array(ClipIdSchema).min(1),
});
export type DeleteClipsArgs = z.infer<typeof DeleteClipsArgsSchema>;

/** Lifts the given clips (and their linked partners) out, leaving a gap behind. */
export function deleteClips(
  project: Project,
  args: DeleteClipsArgs,
  _ctx: EditContext,
): Result<Project, EditError> {
  const parsed = DeleteClipsArgsSchema.safeParse(args);
  if (!parsed.success) return err({ code: 'VALIDATION', message: z.prettifyError(parsed.error) });

  const sequence = project.sequences[parsed.data.sequenceId];
  if (!sequence)
    return err({ code: 'NOT_FOUND', message: `sequence ${parsed.data.sequenceId} does not exist` });
  const resolved = resolveClipsWithLinkedSiblings(sequence, parsed.data.clipIds);
  if (!resolved.ok) return resolved;

  return ok(
    produce(project, (draft) => {
      const draftSequence = draft.sequences[parsed.data.sequenceId];
      if (!draftSequence) return;
      for (const [trackId, indices] of resolved.value.indicesByTrack) {
        const draftTrack = draftSequence.tracks[trackId];
        if (!draftTrack) continue;
        // Descending, so removing one index never shifts the ones still to come.
        for (let i = indices.length - 1; i >= 0; i -= 1) {
          const index = indices[i];
          if (index !== undefined) draftTrack.clips.splice(index, 1);
        }
      }
    }),
  );
}

export const RippleDeleteArgsSchema = DeleteClipsArgsSchema;
export type RippleDeleteArgs = DeleteClipsArgs;

/**
 * Removes the given clips (and linked partners) and closes the gap on every affected
 * track — only those tracks, plus linked partners, per §5's closing note. Markers after
 * the removed range shift left to stay with their content (§10); a marker inside the
 * removed range collapses to where the cut lands.
 */
export function rippleDelete(
  project: Project,
  args: RippleDeleteArgs,
  _ctx: EditContext,
): Result<Project, EditError> {
  const parsed = RippleDeleteArgsSchema.safeParse(args);
  if (!parsed.success) return err({ code: 'VALIDATION', message: z.prettifyError(parsed.error) });

  const sequence = project.sequences[parsed.data.sequenceId];
  if (!sequence)
    return err({ code: 'NOT_FOUND', message: `sequence ${parsed.data.sequenceId} does not exist` });
  const resolved = resolveClipsWithLinkedSiblings(sequence, parsed.data.clipIds);
  if (!resolved.ok) return resolved;

  const rangesByTrack = new Map<TrackId, TimeRange[]>();
  const allRanges: TimeRange[] = [];
  for (const track of Object.values(sequence.tracks)) {
    for (const clip of track.clips) {
      if (!resolved.value.clipIds.has(clip.id)) continue;
      const range = { start: clip.start, end: clip.start + clip.duration };
      const list = rangesByTrack.get(track.id) ?? [];
      list.push(range);
      rangesByTrack.set(track.id, list);
      allRanges.push(range);
    }
  }
  const globalMerged = mergeRanges(allRanges);

  return ok(
    produce(project, (draft) => {
      const draftSequence = draft.sequences[parsed.data.sequenceId];
      if (!draftSequence) return;
      for (const [trackId, ranges] of rangesByTrack) {
        const draftTrack = draftSequence.tracks[trackId];
        const plainTrack = sequence.tracks[trackId];
        if (!draftTrack || !plainTrack) continue;
        const merged = mergeRanges(ranges);
        const removedIndices = resolved.value.indicesByTrack.get(trackId) ?? [];
        const removedSet = new Set(removedIndices);

        // Computed from the plain pre-image (fast): for each surviving clip, its index
        // AFTER the splices below remove earlier clips, and how much it needs to shift.
        const shifts: { newIndex: number; delta: number }[] = [];
        let removedBefore = 0;
        for (let index = 0; index < plainTrack.clips.length; index += 1) {
          if (removedSet.has(index)) {
            removedBefore += 1;
            continue;
          }
          const clip = plainTrack.clips[index];
          if (!clip) continue;
          const shiftedStart = rippleShift(merged, clip.start);
          if (shiftedStart !== clip.start) {
            shifts.push({ newIndex: index - removedBefore, delta: shiftedStart - clip.start });
          }
        }

        // Descending, so removing one index never shifts the ones still to come.
        for (let i = removedIndices.length - 1; i >= 0; i -= 1) {
          const index = removedIndices[i];
          if (index !== undefined) draftTrack.clips.splice(index, 1);
        }
        for (const { newIndex, delta } of shifts) {
          const clip = draftTrack.clips[newIndex];
          if (clip) clip.start = flicks(clip.start + delta);
        }
      }
      draftSequence.markers = draftSequence.markers
        .map((marker) => ({ ...marker, time: flicks(rippleShift(globalMerged, marker.time)) }))
        .sort((a, b) => a.time - b.time);
    }),
  );
}

export const CloseGapArgsSchema = z.strictObject({
  sequenceId: SequenceIdSchema,
  trackId: TrackIdSchema,
  at: FlicksSchema,
});
export type CloseGapArgs = z.infer<typeof CloseGapArgsSchema>;

/** Ripple-deletes the empty range on `trackId` containing `at` (docs/TIMELINE.md §5). A
 * no-op if `at` is after the last clip (nothing bounded to close). */
export function closeGap(
  project: Project,
  args: CloseGapArgs,
  _ctx: EditContext,
): Result<Project, EditError> {
  const parsed = CloseGapArgsSchema.safeParse(args);
  if (!parsed.success) return err({ code: 'VALIDATION', message: z.prettifyError(parsed.error) });
  const { sequenceId, trackId } = parsed.data;

  const sequence = project.sequences[sequenceId];
  const track = sequence?.tracks[trackId];
  if (!sequence || !track)
    return err({ code: 'NOT_FOUND', message: `track ${trackId} does not exist` });
  if (track.locked) return err({ code: 'TRACK_LOCKED', message: `track ${trackId} is locked` });

  const frameDuration = flicksPerFrame(sequence.format.frameRate);
  const at = roundToFrame(parsed.data.at, frameDuration);

  let gapStart = 0;
  let gapEnd: number | null = null;
  for (const clip of track.clips) {
    if (at < clip.start) {
      gapEnd = clip.start;
      break;
    }
    if (at < clip.start + clip.duration) {
      return err({ code: 'VALIDATION', message: `${at.toString()} is inside a clip, not a gap` });
    }
    gapStart = clip.start + clip.duration;
  }
  if (gapEnd === null) return ok(project);
  const gapWidth = gapEnd - gapStart;
  const rippleIndices = collectRippleIndices(sequence, new Set([trackId]), gapEnd);

  return ok(
    produce(project, (draft) => {
      const draftSequence = draft.sequences[sequenceId];
      if (!draftSequence) return;
      shiftClipsByIndex(draftSequence, rippleIndices, -gapWidth);
      draftSequence.markers = draftSequence.markers.map((marker) => ({
        ...marker,
        time: flicks(rippleShift([{ start: gapStart, end: gapEnd }], marker.time)),
      }));
    }),
  );
}

export const RollEditArgsSchema = z.strictObject({
  sequenceId: SequenceIdSchema,
  trackId: TrackIdSchema,
  leftClipId: ClipIdSchema,
  rightClipId: ClipIdSchema,
  delta: FlicksSchema,
});
export type RollEditArgs = z.infer<typeof RollEditArgsSchema>;

/** Moves the cut between two adjacent clips on the same track: the left clip's tail and
 * the right clip's head move together, clamped by both clips' available handles. */
export function rollEdit(
  project: Project,
  args: RollEditArgs,
  _ctx: EditContext,
): Result<Project, EditError> {
  const parsed = RollEditArgsSchema.safeParse(args);
  if (!parsed.success) return err({ code: 'VALIDATION', message: z.prettifyError(parsed.error) });
  const { sequenceId, trackId, leftClipId, rightClipId } = parsed.data;

  const sequence = project.sequences[sequenceId];
  const track = sequence?.tracks[trackId];
  if (!sequence || !track)
    return err({ code: 'NOT_FOUND', message: `track ${trackId} does not exist` });
  if (track.locked) return err({ code: 'TRACK_LOCKED', message: `track ${trackId} is locked` });

  const left = track.clips.find((c) => c.id === leftClipId);
  const right = track.clips.find((c) => c.id === rightClipId);
  if (!left || !right)
    return err({ code: 'NOT_FOUND', message: 'clip does not exist on this track' });
  if (left.start + left.duration !== right.start) {
    return err({ code: 'VALIDATION', message: 'clips are not adjacent' });
  }

  const leftAsset = project.assets[left.assetId];
  const rightAsset = project.assets[right.assetId];
  if (!leftAsset || !rightAsset) return err({ code: 'NOT_FOUND', message: 'asset does not exist' });
  const leftBound =
    leftAsset.kind === 'image'
      ? Infinity
      : leftAsset.info.durationFlicks - left.sourceIn - left.duration;
  const rightBound = rightAsset.kind === 'image' ? Infinity : right.sourceIn;

  const frameDuration = flicksPerFrame(sequence.format.frameRate);
  const roundedDelta = roundToFrame(parsed.data.delta, frameDuration);
  const maxDelta = Math.min(leftBound, right.duration - frameDuration);
  const minDelta = Math.max(-(left.duration - frameDuration), -rightBound);
  const clampedDelta = clamp(roundedDelta, minDelta, maxDelta);
  if (clampedDelta === 0) return ok(project);

  // Adjacent clips are consecutive in the sorted array (docs/TIMELINE.md §4 invariant
  // 2), so the right clip is always at leftIndex + 1 — no second scan needed.
  const leftIndex = track.clips.findIndex((c) => c.id === leftClipId);

  return ok(
    produce(project, (draft) => {
      const draftTrack = draft.sequences[sequenceId]?.tracks[trackId];
      const draftLeft = draftTrack?.clips[leftIndex];
      const draftRight = draftTrack?.clips[leftIndex + 1];
      if (!draftLeft || !draftRight) return;
      draftLeft.duration = flicks(draftLeft.duration + clampedDelta);
      draftRight.start = flicks(draftRight.start + clampedDelta);
      draftRight.sourceIn = flicks(draftRight.sourceIn + clampedDelta);
      draftRight.duration = flicks(draftRight.duration - clampedDelta);
    }),
  );
}
