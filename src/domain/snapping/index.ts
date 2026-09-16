import type { ClipId } from '../ids';
import type { Sequence } from '../model';

/*
 * Snapping (docs/TIMELINE.md §6): pure functions, no React or Tauri. The UI collects
 * targets once at drag start, then calls `snap` on every pointer move — each call is
 * O(k log n) in the number of dragged edges, independent of sequence size.
 *
 * Because clip starts/ends and marker times are always frame-aligned (an invariant of
 * every op in ../ops), any target this module returns is already frame-aligned. When
 * `snap` finds nothing within the threshold, the caller still owes the drag position a
 * final `roundToFrame` (../time) — frame quantization applies even with snapping off.
 */

export type SnapTargetOptions = {
  /** Clips being dragged are never snap targets for their own drag. */
  excludeClipIds?: ReadonlySet<ClipId>;
  /** The playhead position, if it should be offered as a target. */
  playhead?: number;
};

/** Collects every snap target in `sequence` — 0 (sequence start), clip edges, markers,
 * and optionally the playhead — as a sorted, deduplicated array of flicks. */
export function collectSnapTargets(sequence: Sequence, options: SnapTargetOptions = {}): number[] {
  const targets = new Set<number>([0]);
  if (options.playhead !== undefined) targets.add(options.playhead);

  for (const track of Object.values(sequence.tracks)) {
    for (const clip of track.clips) {
      if (options.excludeClipIds?.has(clip.id)) continue;
      targets.add(clip.start);
      targets.add(clip.start + clip.duration);
    }
  }
  for (const marker of sequence.markers) targets.add(marker.time);

  return [...targets].sort((a, b) => a - b);
}

/** Binary search for the target in a sorted array nearest to `value`. */
function nearestTarget(sortedTargets: readonly number[], value: number): number | undefined {
  if (sortedTargets.length === 0) return undefined;
  let low = 0;
  let high = sortedTargets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((sortedTargets[mid] ?? Infinity) < value) low = mid + 1;
    else high = mid;
  }
  const after = sortedTargets[low];
  const before = sortedTargets[low - 1];
  if (after === undefined) return before;
  if (before === undefined) return after;
  return value - before <= after - value ? before : after;
}

/** One edge being dragged, identified by an opaque id the caller assigns (e.g. a clip
 * id plus 'start' or 'end') so it can tell which edge a result came from. */
export type SnapEdge = { id: string; time: number };
export type SnapResult = { edgeId: string; target: number; delta: number };

/**
 * Finds the dragged edge and target pair with the smallest snap distance, within
 * `threshold` flicks. Returns `null` if no edge has a target within range.
 */
export function snap(
  edges: readonly SnapEdge[],
  sortedTargets: readonly number[],
  threshold: number,
): SnapResult | null {
  let best: SnapResult | null = null;
  for (const edge of edges) {
    const target = nearestTarget(sortedTargets, edge.time);
    if (target === undefined) continue;
    const delta = target - edge.time;
    if (Math.abs(delta) > threshold) continue;
    if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { edgeId: edge.id, target, delta };
  }
  return best;
}
