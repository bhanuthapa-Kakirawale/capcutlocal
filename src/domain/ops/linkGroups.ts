import type { Draft } from 'immer';
import type { Sequence } from '../model';

/**
 * After an op removes clips (or the track they were on), a link group can drop to one
 * member. §3.3 of docs/TIMELINE.md: "a link group of one member is dissolved
 * automatically." Clearing `linkId` here is what keeps invariant 6 (every link has ≥ 2
 * members) holding after such an op, instead of leaving the project momentarily invalid.
 */
export function dissolveOrphanedLinks(sequence: Draft<Sequence>): void {
  const counts = new Map<string, number>();
  for (const track of Object.values(sequence.tracks)) {
    for (const clip of track.clips) {
      if (clip.linkId !== null) counts.set(clip.linkId, (counts.get(clip.linkId) ?? 0) + 1);
    }
  }
  for (const track of Object.values(sequence.tracks)) {
    for (const clip of track.clips) {
      if (clip.linkId !== null && (counts.get(clip.linkId) ?? 0) < 2) {
        clip.linkId = null;
      }
    }
  }
}
