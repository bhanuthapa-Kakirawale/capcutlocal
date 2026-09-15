import { useEffect, useState } from 'react';
import { toAssetUrl } from '../../ipc/assetUrl';
import { onFilesDropped } from '../../ipc/dragDrop';
import { pickMediaFilesToImport } from '../../ipc/dialogs';
import { importMediaFiles } from '../../app/mediaActions';
import { useMediaStore } from '../../state/mediaStore';
import { useProjectStore } from '../../state/projectStore';
import { MediaCard } from './MediaCard';

/** Import via dialog or drag-drop, and a grid of what's been imported
 * (docs/MEDIA-PIPELINE.md's media browser + import UI). */
export function MediaBrowser() {
  const assets = useProjectStore((s) => s.history.present.assets);
  const posterPaths = useMediaStore((s) => s.posterPaths);
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const runImport = async (paths: string[]) => {
    if (paths.length === 0) return;
    setImporting(true);
    try {
      await importMediaFiles(paths);
    } finally {
      setImporting(false);
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    void onFilesDropped((paths) => {
      setDragOver(false);
      void runImport(paths);
    }).then((unsub) => {
      if (active) unlisten = unsub;
      else unsub();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const assetList = Object.values(assets);

  return (
    <section
      className={`flex flex-1 flex-col gap-3 overflow-y-auto p-4 ${dragOver ? 'bg-surface-1' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => {
        setDragOver(false);
      }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg-muted">Media</h2>
        <button
          type="button"
          disabled={importing}
          onClick={() => void pickMediaFilesToImport().then(runImport)}
          className="rounded border border-edge px-2 py-1 text-sm hover:bg-surface-1 disabled:opacity-50"
        >
          {importing ? 'Importing…' : 'Import…'}
        </button>
      </div>

      {assetList.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No media yet. Import files or drag them into this window.
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
          {assetList.map((asset) => {
            const posterPath = posterPaths[asset.id];
            return (
              <MediaCard
                key={asset.id}
                asset={asset}
                posterUrl={posterPath ? toAssetUrl(posterPath) : undefined}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
