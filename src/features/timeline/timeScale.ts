import type { Sequence } from '../../domain/model';
import { FLICKS_PER_SECOND } from '../../domain/time';

/** Converts between sequence time (flicks) and on-screen pixels at the timeline's
 * current zoom (docs/TIMELINE.md §11: the only place this math happens). */
export function flicksToPixels(time: number, pixelsPerSecond: number): number {
  return (time / FLICKS_PER_SECOND) * pixelsPerSecond;
}

export function pixelsToFlicks(pixels: number, pixelsPerSecond: number): number {
  return (pixels / pixelsPerSecond) * FLICKS_PER_SECOND;
}

/** The end of the last clip or marker — sequence duration is derived, never stored
 * (docs/TIMELINE.md §2). Used only to size the scrollable timeline viewport. */
export function sequenceContentDuration(sequence: Sequence): number {
  let end = 0;
  for (const track of Object.values(sequence.tracks)) {
    for (const clip of track.clips) end = Math.max(end, clip.start + clip.duration);
  }
  for (const marker of sequence.markers) end = Math.max(end, marker.time);
  return end;
}
