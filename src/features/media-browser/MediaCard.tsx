import { addAssetToTimeline } from '../../app/mediaActions';
import type { Asset } from '../../domain/model';
import { formatDuration } from './formatDuration';

const KIND_LABEL: Record<Asset['kind'], string> = {
  video: 'Video',
  audio: 'Audio',
  image: 'Image',
};

export function MediaCard({ asset, posterUrl }: { asset: Asset; posterUrl: string | undefined }) {
  return (
    <div
      data-testid="media-card"
      data-asset-name={asset.name}
      className="flex flex-col overflow-hidden rounded border border-edge bg-surface-1"
    >
      <div className="flex aspect-video items-center justify-center bg-surface-0">
        {posterUrl ? (
          <img src={posterUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="text-xs text-fg-muted">{asset.kind === 'audio' ? '♪' : '…'}</span>
        )}
      </div>
      <div className="flex flex-col gap-0.5 p-2">
        <span className="truncate text-xs font-medium" title={asset.name}>
          {asset.name}
        </span>
        <span className="text-[11px] text-fg-muted">
          {KIND_LABEL[asset.kind]}
          {asset.kind !== 'image' && ` · ${formatDuration(asset.info.durationFlicks)}`}
          {asset.info.video &&
            ` · ${asset.info.video.width.toString()}×${asset.info.video.height.toString()}`}
        </span>
        <button
          type="button"
          onClick={() => {
            addAssetToTimeline(asset.id);
          }}
          className="mt-1 rounded border border-edge px-1.5 py-0.5 text-[11px] hover:bg-surface-0"
        >
          Add to timeline
        </button>
      </div>
    </div>
  );
}
