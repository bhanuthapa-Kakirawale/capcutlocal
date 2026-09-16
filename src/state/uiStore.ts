import { create } from 'zustand';
import type { ClipId } from '../domain/ids';
import { flicks, type Flicks } from '../domain/time';

/**
 * UI/session state for the timeline (docs/ARCHITECTURE.md §2.1): selection, playhead,
 * zoom, and scroll position. Never part of the project document, never undoable, and not
 * yet persisted across sessions (there is no settings-persistence layer to hook into yet).
 */

const MIN_PIXELS_PER_SECOND = 5;
const MAX_PIXELS_PER_SECOND = 2000;
const DEFAULT_PIXELS_PER_SECOND = 100;

export type UiStoreState = {
  selectedClipIds: ReadonlySet<ClipId>;
  playhead: Flicks;
  /** Timeline zoom, in on-screen pixels per second of sequence time. */
  pixelsPerSecond: number;
  /** Horizontal scroll position of the timeline track area, in pixels. */
  scrollLeft: number;
};

export type UiStoreActions = {
  selectClips(clipIds: readonly ClipId[]): void;
  toggleClipSelection(clipId: ClipId): void;
  clearSelection(): void;
  setPlayhead(time: Flicks): void;
  setPixelsPerSecond(pixelsPerSecond: number): void;
  setScrollLeft(scrollLeft: number): void;
};

export type UiStore = UiStoreState & UiStoreActions;

export const useUiStore = create<UiStore>((set) => ({
  selectedClipIds: new Set(),
  playhead: flicks(0),
  pixelsPerSecond: DEFAULT_PIXELS_PER_SECOND,
  scrollLeft: 0,

  selectClips: (clipIds) => {
    set({ selectedClipIds: new Set(clipIds) });
  },
  toggleClipSelection: (clipId) => {
    set((s) => {
      const next = new Set(s.selectedClipIds);
      if (next.has(clipId)) next.delete(clipId);
      else next.add(clipId);
      return { selectedClipIds: next };
    });
  },
  clearSelection: () => {
    set({ selectedClipIds: new Set() });
  },
  setPlayhead: (time) => {
    set({ playhead: flicks(Math.max(0, time)) });
  },
  setPixelsPerSecond: (pixelsPerSecond) => {
    set({
      pixelsPerSecond: Math.min(
        MAX_PIXELS_PER_SECOND,
        Math.max(MIN_PIXELS_PER_SECOND, pixelsPerSecond),
      ),
    });
  },
  setScrollLeft: (scrollLeft) => {
    set({ scrollLeft: Math.max(0, scrollLeft) });
  },
}));
