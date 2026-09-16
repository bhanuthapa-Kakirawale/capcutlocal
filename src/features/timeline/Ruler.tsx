import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Rational } from '../../domain/time';
import { formatTimecode, secondsToFlicks } from '../../domain/time';
import { RULER_HEIGHT_PX } from './constants';
import { flicksToPixels, pixelsToFlicks } from './timeScale';

const MIN_LABEL_SPACING_PX = 70;
const TICK_INTERVALS_SECONDS = [1, 2, 5, 10, 30, 60, 120, 300, 600];

function pickTickIntervalSeconds(pixelsPerSecond: number): number {
  for (const seconds of TICK_INTERVALS_SECONDS) {
    if (seconds * pixelsPerSecond >= MIN_LABEL_SPACING_PX) return seconds;
  }
  return TICK_INTERVALS_SECONDS[TICK_INTERVALS_SECONDS.length - 1] ?? 600;
}

/** Timecode ruler. Lives inside the same horizontally-scrolling container as the track
 * lanes, so it scrolls with them without any manual offset math. */
export function Ruler(props: {
  frameRate: Rational;
  contentWidthPx: number;
  pixelsPerSecond: number;
  onSeek: (time: number) => void;
}) {
  const interval = pickTickIntervalSeconds(props.pixelsPerSecond);
  const durationSeconds = props.contentWidthPx / props.pixelsPerSecond;
  const ticks: number[] = [];
  for (let s = 0; s <= durationSeconds; s += interval) ticks.push(s);

  return (
    <div
      data-testid="timeline-ruler"
      className="sticky top-0 z-10 cursor-pointer border-b border-edge bg-surface-1"
      style={{ height: RULER_HEIGHT_PX, width: props.contentWidthPx }}
      onPointerDown={(e: ReactPointerEvent) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const time = Math.max(0, pixelsToFlicks(e.clientX - rect.left, props.pixelsPerSecond));
        props.onSeek(time);
      }}
    >
      {ticks.map((seconds) => (
        <span
          key={seconds}
          className="pointer-events-none absolute top-1 text-[10px] text-fg-muted select-none"
          style={{ left: flicksToPixels(secondsToFlicks(seconds), props.pixelsPerSecond) + 2 }}
        >
          {formatTimecode(secondsToFlicks(seconds), props.frameRate)}
        </span>
      ))}
    </div>
  );
}
