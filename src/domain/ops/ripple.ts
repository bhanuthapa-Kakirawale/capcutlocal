import type { Draft } from 'immer';
import type { ClipId, LinkId, TrackId } from '../ids';
import type { Sequence } from '../model';
import { flicks } from '../time';

/*
 * Shared ripple mechanics (docs/TIMELINE.md §5) used by insertClips/moveClips 'insert'
 * mode, ripple trims, rippleDelete, and closeGap. "Ripple affects only the tracks
 * involved, plus linked partners" (§5's closing note) — a global sync-lock that ripples
 * every unlocked track is explicitly out of scope until a later phase.
 */

/**
 * Every clip id on `directTrackIds` with `start >= from`, plus any linked partner that
 * ALSO already has `start >= from` (never a clip that starts earlier than the pivot —
 * shifting one of those could introduce a new overlap this function has no way to check).
 */
export function collectRippleSet(
  sequence: Draft<Sequence>,
  directTrackIds: ReadonlySet<TrackId>,
  from: number,
): Set<ClipId> {
  const siblingsByLink = new Map<LinkId, ClipId[]>();
  const direct = new Set<ClipId>();

  for (const track of Object.values(sequence.tracks)) {
    for (const clip of track.clips) {
      if (clip.start < from) continue;
      if (directTrackIds.has(track.id)) direct.add(clip.id);
      if (clip.linkId !== null) {
        const siblings = siblingsByLink.get(clip.linkId) ?? [];
        siblings.push(clip.id);
        siblingsByLink.set(clip.linkId, siblings);
      }
    }
  }

  const result = new Set(direct);
  for (const track of Object.values(sequence.tracks)) {
    for (const clip of track.clips) {
      if (direct.has(clip.id) && clip.linkId !== null) {
        for (const sibling of siblingsByLink.get(clip.linkId) ?? []) result.add(sibling);
      }
    }
  }
  return result;
}

/** Shifts every clip whose id is in `clipIds` by `delta`. Callers must ensure the shift
 * cannot introduce an overlap (see `collectRippleSet`'s doc comment). */
export function shiftClips(
  sequence: Draft<Sequence>,
  clipIds: ReadonlySet<ClipId>,
  delta: number,
): void {
  for (const track of Object.values(sequence.tracks)) {
    for (const clip of track.clips) {
      if (clipIds.has(clip.id)) clip.start = flicks(clip.start + delta);
    }
  }
}

/**
 * Same result as `collectRippleSet`, but as per-track array INDICES computed from plain
 * (non-draft) `sequence` data, for callers that shift clips without changing any track's
 * clip count (trimClip's ripple mode, closeGap). Reading through an Immer draft's
 * proxied array costs roughly 2µs per element regardless of what's read, so a full scan
 * of a 5,000-clip track costs ~10 ms even read-only — measured directly, not assumed
 * (docs/ROADMAP.md Phase 4's "< 2 ms" gate). Scanning the plain pre-image instead costs
 * a few hundred microseconds, and `shiftClipsByIndex` then touches the draft only at
 * the exact indices found here, which Immer finalizes in time proportional to the
 * number of clips actually shifted, not the track's length.
 *
 * insertClips/moveClips still use `collectRippleSet` on the draft: a single call can
 * place more than one clip, and a later placement's ripple must see an earlier one's
 * effect within the same call. Those ops already pay an unavoidable O(track length)
 * cost from the array-length-changing splice a placement requires, so reading the
 * (slower) draft for their ripple set costs them nothing extra in practice.
 */
export function collectRippleIndices(
  sequence: Sequence,
  directTrackIds: ReadonlySet<TrackId>,
  from: number,
): Map<TrackId, number[]> {
  const direct = new Map<TrackId, Set<number>>();
  const siblingsByLink = new Map<LinkId, { trackId: TrackId; index: number }[]>();

  for (const track of Object.values(sequence.tracks)) {
    track.clips.forEach((clip, index) => {
      if (clip.start < from) return;
      if (directTrackIds.has(track.id)) {
        const set = direct.get(track.id) ?? new Set<number>();
        set.add(index);
        direct.set(track.id, set);
      }
      if (clip.linkId !== null) {
        const siblings = siblingsByLink.get(clip.linkId) ?? [];
        siblings.push({ trackId: track.id, index });
        siblingsByLink.set(clip.linkId, siblings);
      }
    });
  }

  const result = new Map<TrackId, Set<number>>();
  for (const [trackId, indices] of direct) result.set(trackId, new Set(indices));
  for (const track of Object.values(sequence.tracks)) {
    const eligible = direct.get(track.id);
    if (!eligible) continue;
    for (const index of eligible) {
      const linkId = track.clips[index]?.linkId;
      if (linkId == null) continue;
      for (const sibling of siblingsByLink.get(linkId) ?? []) {
        const set = result.get(sibling.trackId) ?? new Set<number>();
        set.add(sibling.index);
        result.set(sibling.trackId, set);
      }
    }
  }

  const final = new Map<TrackId, number[]>();
  for (const [trackId, set] of result)
    final.set(
      trackId,
      [...set].sort((a, b) => a - b),
    );
  return final;
}

/** Shifts clips at the given per-track indices (from `collectRippleIndices`) by `delta`,
 * accessed directly by index so Immer only finalizes the touched elements. */
export function shiftClipsByIndex(
  sequence: Draft<Sequence>,
  indices: ReadonlyMap<TrackId, readonly number[]>,
  delta: number,
): void {
  for (const [trackId, list] of indices) {
    const track = sequence.tracks[trackId];
    if (!track) continue;
    for (const index of list) {
      const clip = track.clips[index];
      if (clip) clip.start = flicks(clip.start + delta);
    }
  }
}

export type TimeRange = { start: number; end: number };

/** Merges overlapping or touching ranges (including exact duplicates, which linked
 * clips sharing a removed span produce) into the fewest disjoint ranges, sorted by start. */
export function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: TimeRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Maps a time through a ripple-delete of `mergedRanges` (already merged, sorted,
 * disjoint): a time at or after a removed range shifts left by its width; a time inside
 * a removed range collapses to where that range's start ends up. This is how
 * `rippleDelete` moves surviving clip starts and markers (docs/TIMELINE.md §5, §10).
 */
export function rippleShift(mergedRanges: readonly TimeRange[], time: number): number {
  let shift = 0;
  for (const range of mergedRanges) {
    if (time >= range.end) {
      shift += range.end - range.start;
    } else if (time > range.start) {
      return range.start - shift;
    } else {
      break;
    }
  }
  return time - shift;
}
