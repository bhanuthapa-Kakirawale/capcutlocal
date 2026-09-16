import type { PointerEvent as ReactPointerEvent } from 'react';
import type { ClipId } from '../../domain/ids';
import type { Asset, Track } from '../../domain/model';
import { ClipBlock } from './ClipBlock';
import { TRACK_HEIGHT_PX } from './constants';
import { flicksToPixels } from './timeScale';

export type ClipPointerPart = 'body' | 'head' | 'tail';

/** One track row: a fixed header (name) plus an absolutely-positioned lane of clips. */
export function TrackLane(props: {
  track: Track;
  assets: Record<string, Asset>;
  contentWidthPx: number;
  pixelsPerSecond: number;
  selectedClipIds: ReadonlySet<ClipId>;
  onClipPointerDown: (clipId: ClipId, part: ClipPointerPart, e: ReactPointerEvent) => void;
  onLanePointerDown: () => void;
}) {
  return (
    <div className="flex border-b border-edge">
      <div
        className="sticky left-0 z-10 flex w-32 shrink-0 flex-col justify-center gap-0.5 border-r border-edge bg-surface-1 px-2"
        style={{ height: TRACK_HEIGHT_PX }}
      >
        <span className="truncate text-xs font-medium">{props.track.name}</span>
        <span className="text-[10px] text-fg-muted">
          {props.track.kind}
          {props.track.locked ? ' · locked' : ''}
        </span>
      </div>
      <div
        className="relative"
        style={{ height: TRACK_HEIGHT_PX, width: props.contentWidthPx }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) props.onLanePointerDown();
        }}
      >
        {props.track.clips.map((clip) => {
          const asset: Asset | undefined = props.assets[clip.assetId];
          return (
            <ClipBlock
              key={clip.id}
              clip={clip}
              label={asset?.name ?? clip.type}
              left={flicksToPixels(clip.start, props.pixelsPerSecond)}
              width={flicksToPixels(clip.duration, props.pixelsPerSecond)}
              height={TRACK_HEIGHT_PX - 8}
              selected={props.selectedClipIds.has(clip.id)}
              disabled={props.track.locked}
              onBodyPointerDown={(e) => {
                props.onClipPointerDown(clip.id, 'body', e);
              }}
              onHeadPointerDown={(e) => {
                props.onClipPointerDown(clip.id, 'head', e);
              }}
              onTailPointerDown={(e) => {
                props.onClipPointerDown(clip.id, 'tail', e);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
