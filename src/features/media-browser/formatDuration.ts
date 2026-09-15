import { flicksToSeconds, type Flicks } from '../../domain/time';

/** `MM:SS`, or `H:MM:SS` past an hour. Display-only (docs/TIMELINE.md §1: flicks convert
 * to seconds only at the last moment, never for timeline math). */
export function formatDuration(duration: Flicks): string {
  const totalSeconds = Math.max(0, Math.round(flicksToSeconds(duration)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return hours > 0
    ? `${hours.toString()}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes.toString()}:${pad(seconds)}`;
}
