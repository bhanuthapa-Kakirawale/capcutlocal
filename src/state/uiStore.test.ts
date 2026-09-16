import { beforeEach, describe, expect, it } from 'vitest';
import type { ClipId } from '../domain/ids';
import { flicks } from '../domain/time';
import { useUiStore } from './uiStore';

const initialState = useUiStore.getState();

beforeEach(() => {
  useUiStore.setState(initialState, true);
});

describe('selection', () => {
  it('replaces the selection with selectClips', () => {
    useUiStore.getState().selectClips(['a' as ClipId, 'b' as ClipId]);
    expect(useUiStore.getState().selectedClipIds).toEqual(new Set(['a', 'b']));
  });

  it('toggleClipSelection adds and then removes a clip', () => {
    useUiStore.getState().toggleClipSelection('a' as ClipId);
    expect(useUiStore.getState().selectedClipIds.has('a' as ClipId)).toBe(true);
    useUiStore.getState().toggleClipSelection('a' as ClipId);
    expect(useUiStore.getState().selectedClipIds.has('a' as ClipId)).toBe(false);
  });

  it('clearSelection empties the selection', () => {
    useUiStore.getState().selectClips(['a' as ClipId]);
    useUiStore.getState().clearSelection();
    expect(useUiStore.getState().selectedClipIds.size).toBe(0);
  });
});

describe('playhead', () => {
  it('sets the playhead', () => {
    useUiStore.getState().setPlayhead(flicks(1000));
    expect(useUiStore.getState().playhead).toBe(1000);
  });

  it('clamps the playhead to zero', () => {
    useUiStore.getState().setPlayhead(flicks(-500));
    expect(useUiStore.getState().playhead).toBe(0);
  });
});

describe('zoom', () => {
  it('sets pixelsPerSecond within range', () => {
    useUiStore.getState().setPixelsPerSecond(300);
    expect(useUiStore.getState().pixelsPerSecond).toBe(300);
  });

  it('clamps zoom to the minimum and maximum', () => {
    useUiStore.getState().setPixelsPerSecond(0);
    expect(useUiStore.getState().pixelsPerSecond).toBeGreaterThan(0);
    useUiStore.getState().setPixelsPerSecond(1_000_000);
    expect(useUiStore.getState().pixelsPerSecond).toBeLessThan(1_000_000);
  });
});

describe('scroll', () => {
  it('sets scrollLeft and clamps to zero', () => {
    useUiStore.getState().setScrollLeft(50);
    expect(useUiStore.getState().scrollLeft).toBe(50);
    useUiStore.getState().setScrollLeft(-10);
    expect(useUiStore.getState().scrollLeft).toBe(0);
  });
});
