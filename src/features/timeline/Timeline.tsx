import { useEffect, useMemo, type PointerEvent as ReactPointerEvent } from 'react';
import type { ClipId, TrackId } from '../../domain/ids';
import type { Track } from '../../domain/model';
import {
  deleteClips,
  moveClips,
  rippleDelete,
  splitClips,
  trimClip,
  type MoveClipsArgs,
  type TrimClipArgs,
} from '../../domain/ops/clips';
import { collectSnapTargets, snap } from '../../domain/snapping';
import { flicks, FLICKS_PER_SECOND, flicksPerFrame, roundToFrame } from '../../domain/time';
import { useProjectStore } from '../../state/projectStore';
import { useUiStore } from '../../state/uiStore';
import { SNAP_THRESHOLD_PX } from './constants';
import { Ruler } from './Ruler';
import { TrackLane, type ClipPointerPart } from './TrackLane';
import { flicksToPixels, pixelsToFlicks, sequenceContentDuration } from './timeScale';

const MIN_CONTENT_SECONDS = 30;
const TRAILING_PADDING_SECONDS = 10;

/** Attaches the pointermove/up/Escape lifecycle for one continuous drag gesture. Each
 * move recomputes the DESIRED TOTAL delta from drag start (so snapping and frame
 * rounding never accumulate drift), then applies only the increment since the last
 * move — `updateTransaction` always edits the current (already-updated) document. */
function runDragGesture(options: {
  startClientX: number;
  pixelsPerSecond: number;
  frameDuration: number;
  computeDesiredTotal: (rawDeltaFlicks: number, disableSnap: boolean) => number;
  applyIncrement: (increment: number) => void;
}): void {
  let totalApplied = 0;

  function onMove(e: PointerEvent): void {
    const rawDelta = pixelsToFlicks(e.clientX - options.startClientX, options.pixelsPerSecond);
    const desiredTotal = options.computeDesiredTotal(rawDelta, e.ctrlKey || e.metaKey);
    const finalTotal = roundToFrame(desiredTotal, options.frameDuration);
    const increment = finalTotal - totalApplied;
    if (increment === 0) return;
    options.applyIncrement(increment);
    totalApplied = finalTotal;
  }
  function finish(commit: boolean): void {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('keydown', onKeyDown);
    if (commit) useProjectStore.getState().commitTransaction();
    else useProjectStore.getState().cancelTransaction();
  }
  function onUp(): void {
    finish(true);
  }
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') finish(false);
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('keydown', onKeyDown);
}

function findTrackOf(tracks: Record<string, Track>, clipId: ClipId): Track | undefined {
  return Object.values(tracks).find((track) => track.clips.some((c) => c.id === clipId));
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

/** The interactive timeline (docs/TIMELINE.md, docs/ROADMAP.md Phase 4): track lanes,
 * click-to-select, drag-to-move, edge-drag-to-trim, split/delete/ripple-delete, snapping,
 * zoom/scroll and keyboard shortcuts. Clips render as labeled color blocks — filmstrips
 * and waveforms were deferred from Phase 3 and are not built here either. */
export function Timeline() {
  const project = useProjectStore((s) => s.history.present);
  const sequence = project.sequences[project.activeSequenceId];
  const selectedClipIds = useUiStore((s) => s.selectedClipIds);
  const playhead = useUiStore((s) => s.playhead);
  const pixelsPerSecond = useUiStore((s) => s.pixelsPerSecond);

  const contentWidthPx = useMemo(() => {
    if (!sequence) return 0;
    const seconds = Math.max(
      MIN_CONTENT_SECONDS,
      sequenceContentDuration(sequence) / FLICKS_PER_SECOND + TRAILING_PADDING_SECONDS,
    );
    return flicksToPixels(flicks(Math.round(seconds * FLICKS_PER_SECOND)), pixelsPerSecond);
  }, [sequence, pixelsPerSecond]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (isTypingTarget(e.target) || !sequence) return;
      const selection = [...useUiStore.getState().selectedClipIds];

      if ((e.key === 'Delete' || e.key === 'Backspace') && selection.length > 0) {
        e.preventDefault();
        const op = e.shiftKey ? rippleDelete : deleteClips;
        const label = e.shiftKey ? 'Ripple delete' : 'Delete clip(s)';
        const result = useProjectStore
          .getState()
          .dispatch(op, { sequenceId: sequence.id, clipIds: selection }, label);
        if (result.ok) useUiStore.getState().clearSelection();
      } else if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        useProjectStore
          .getState()
          .dispatch(
            splitClips,
            { sequenceId: sequence.id, at: useUiStore.getState().playhead },
            'Split at playhead',
          );
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [sequence]);

  if (!sequence) {
    return <div className="p-4 text-sm text-fg-muted">No active sequence.</div>;
  }

  const frameDuration = flicksPerFrame(sequence.format.frameRate);

  function startMoveDrag(clipId: ClipId, e: ReactPointerEvent): void {
    if (!sequence) return;
    const track = findTrackOf(sequence.tracks, clipId);
    if (!track || track.locked) return;

    if (e.ctrlKey || e.metaKey) {
      useUiStore.getState().toggleClipSelection(clipId);
      return;
    }
    let selection = useUiStore.getState().selectedClipIds;
    if (!selection.has(clipId)) {
      selection = new Set([clipId]);
      useUiStore.getState().selectClips([clipId]);
    }

    const toTrack = new Map<ClipId, TrackId>();
    let primaryOriginalStart = 0;
    let primaryDuration = 0;
    for (const t of Object.values(sequence.tracks)) {
      for (const clip of t.clips) {
        if (!selection.has(clip.id)) continue;
        toTrack.set(clip.id, t.id);
        if (clip.id === clipId) {
          primaryOriginalStart = clip.start;
          primaryDuration = clip.duration;
        }
      }
    }
    const targets = collectSnapTargets(sequence, { excludeClipIds: selection, playhead });
    const mode: MoveClipsArgs['mode'] = e.shiftKey ? 'insert' : 'overwrite';
    const clipIds = [...selection];

    useProjectStore.getState().beginTransaction('Move clip');
    runDragGesture({
      startClientX: e.clientX,
      pixelsPerSecond,
      frameDuration,
      computeDesiredTotal: (rawDelta, disableSnap) => {
        if (disableSnap) return rawDelta;
        const edges = [
          { id: 'start', time: primaryOriginalStart + rawDelta },
          { id: 'end', time: primaryOriginalStart + primaryDuration + rawDelta },
        ];
        const result = snap(edges, targets, pixelsToFlicks(SNAP_THRESHOLD_PX, pixelsPerSecond));
        return result ? rawDelta + result.delta : rawDelta;
      },
      applyIncrement: (increment) => {
        const args: MoveClipsArgs = {
          sequenceId: sequence.id,
          moves: clipIds.map((id) => ({ clipId: id, toTrackId: toTrack.get(id) ?? track.id })),
          deltaTime: flicks(increment),
          mode,
        };
        useProjectStore.getState().updateTransaction(moveClips, args);
      },
    });
  }

  function startTrimDrag(clipId: ClipId, edge: 'head' | 'tail', e: ReactPointerEvent): void {
    if (!sequence) return;
    const track = findTrackOf(sequence.tracks, clipId);
    const clip = track?.clips.find((c) => c.id === clipId);
    if (!track || track.locked || !clip) return;

    const targets = collectSnapTargets(sequence, { excludeClipIds: new Set([clipId]), playhead });
    const originalStart = clip.start;
    const originalDuration = clip.duration;
    const ripple = e.altKey;

    useProjectStore
      .getState()
      .beginTransaction(edge === 'head' ? 'Trim clip head' : 'Trim clip tail');
    runDragGesture({
      startClientX: e.clientX,
      pixelsPerSecond,
      frameDuration,
      computeDesiredTotal: (rawDelta, disableSnap) => {
        if (disableSnap) return rawDelta;
        const edgeTime =
          edge === 'head' ? originalStart + rawDelta : originalStart + originalDuration + rawDelta;
        const result = snap(
          [{ id: 'edge', time: edgeTime }],
          targets,
          pixelsToFlicks(SNAP_THRESHOLD_PX, pixelsPerSecond),
        );
        return result ? rawDelta + result.delta : rawDelta;
      },
      applyIncrement: (increment) => {
        const args: TrimClipArgs = {
          sequenceId: sequence.id,
          clipId,
          edge,
          delta: flicks(increment),
          ripple,
        };
        useProjectStore.getState().updateTransaction(trimClip, args);
      },
    });
  }

  function handleClipPointerDown(
    clipId: ClipId,
    part: ClipPointerPart,
    e: ReactPointerEvent,
  ): void {
    e.preventDefault();
    if (part === 'body') startMoveDrag(clipId, e);
    else startTrimDrag(clipId, part, e);
  }

  const videoRows = [...sequence.videoTracks].reverse();
  const audioRows = sequence.audioTracks;
  const rowIds = [...videoRows, ...audioRows];
  const playheadLeft = flicksToPixels(playhead, pixelsPerSecond);

  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-edge">
      <div className="flex items-center gap-2 border-b border-edge bg-surface-1 px-3 py-1 text-xs text-fg-muted">
        <span>Zoom</span>
        <input
          aria-label="Timeline zoom"
          type="range"
          min={5}
          max={2000}
          step={5}
          value={pixelsPerSecond}
          onChange={(e) => {
            useUiStore.getState().setPixelsPerSecond(Number(e.target.value));
          }}
        />
      </div>
      <div
        data-testid="timeline-scroll"
        className="relative flex-1 overflow-auto"
        onScroll={(e) => {
          useUiStore.getState().setScrollLeft(e.currentTarget.scrollLeft);
        }}
      >
        <div style={{ width: contentWidthPx + 128, position: 'relative' }}>
          <div style={{ marginLeft: 128 }}>
            <Ruler
              frameRate={sequence.format.frameRate}
              contentWidthPx={contentWidthPx}
              pixelsPerSecond={pixelsPerSecond}
              onSeek={(time) => {
                useUiStore.getState().setPlayhead(flicks(roundToFrame(time, frameDuration)));
              }}
            />
          </div>
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-accent"
            style={{ left: playheadLeft + 128 }}
          />
          {rowIds.map((trackId) => {
            const track = sequence.tracks[trackId];
            if (!track) return null;
            return (
              <TrackLane
                key={trackId}
                track={track}
                assets={project.assets}
                contentWidthPx={contentWidthPx}
                pixelsPerSecond={pixelsPerSecond}
                selectedClipIds={selectedClipIds}
                onClipPointerDown={handleClipPointerDown}
                onLanePointerDown={() => {
                  useUiStore.getState().clearSelection();
                }}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}
