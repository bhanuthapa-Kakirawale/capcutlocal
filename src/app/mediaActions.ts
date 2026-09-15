import { addAssets } from '../domain/ops/media';
import type { Asset } from '../domain/model';
import { mediaGeneratePoster, mediaImport } from '../ipc/commands';
import { describeIpcError } from '../ipc/invoke';
import { useProjectStore } from '../state/projectStore';
import { useMediaStore } from '../state/mediaStore';
import { logger } from './logger';

/**
 * Import orchestration (docs/MEDIA-PIPELINE.md §2.1): probe every file (fast, via
 * `media_import`), add the successes to the document in one undo step, then kick off
 * poster generation per asset without waiting for it — posters stream in as they're
 * ready rather than blocking the import.
 */
export async function importMediaFiles(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;

  const result = await mediaImport(paths);
  if (!result.ok) {
    logger.error(`media_import failed: ${describeIpcError(result.error)}`);
    window.alert(`Import failed: ${describeIpcError(result.error)}`);
    return;
  }

  const successes = result.value.filter((outcome) => outcome.status === 'imported');
  for (const outcome of result.value) {
    if (outcome.status === 'failed') {
      logger.warn(`could not import ${outcome.path}: ${outcome.error.message}`);
    }
  }

  if (successes.length === 0) return;

  const store = useProjectStore.getState();
  const dispatchResult = store.dispatch(
    addAssets,
    {
      assets: successes.map((s) => ({
        kind: s.kind,
        name: s.suggestedName,
        path: s.path,
        fingerprint: s.fingerprint,
        info: s.info,
      })),
    },
    `Import ${String(successes.length)} file${successes.length === 1 ? '' : 's'}`,
  );
  if (!dispatchResult.ok) {
    logger.error(`could not add imported assets to the project: ${dispatchResult.error.message}`);
    return;
  }

  // Fire-and-forget: the grid renders immediately, and each poster fills in as it lands.
  for (const asset of Object.values(dispatchResult.value.assets)) {
    if (!useMediaStore.getState().posterPaths[asset.id]) {
      void generatePosterFor(asset);
    }
  }
}

async function generatePosterFor(asset: Asset): Promise<void> {
  if (asset.kind === 'audio') return; // no visual frame to extract a poster from
  const result = await mediaGeneratePoster(
    asset.source.path,
    asset.source.fingerprint.sampleHash,
    asset.info.durationFlicks,
  );
  if (result.ok) {
    useMediaStore.getState().setPosterPath(asset.id, result.value);
  } else {
    logger.warn(`poster generation failed for ${asset.name}: ${describeIpcError(result.error)}`);
  }
}
