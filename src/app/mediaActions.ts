import type { AssetId } from '../domain/ids';
import type { Asset, Track } from '../domain/model';
import { addAssets } from '../domain/ops/media';
import { insertClips, type InsertClipsArgs } from '../domain/ops/clips';
import { flicks } from '../domain/time';
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

function trackEndFlicks(track: Track | undefined): number {
  if (!track) return 0;
  const last = track.clips[track.clips.length - 1];
  return last ? last.start + last.duration : 0;
}

/**
 * Appends an asset to the end of the active sequence's first video and/or audio track
 * (whichever apply), linking the pair when a video asset has an audio stream (§3.3).
 * The one way to get media from the browser onto the timeline in this phase — dragging
 * a clip mid-timeline is `moveClips`, exercised once it's already placed.
 */
export function addAssetToTimeline(assetId: AssetId): void {
  const store = useProjectStore.getState();
  const project = store.history.present;
  const sequence = project.sequences[project.activeSequenceId];
  const asset = project.assets[assetId];
  if (!sequence || !asset) return;

  const videoTrackId = sequence.videoTracks[0];
  const audioTrackId = sequence.audioTracks[0];
  const hasAudioStream = asset.kind === 'video' && asset.info.audio.length > 0;
  const wantsVideo =
    (asset.kind === 'video' || asset.kind === 'image') && videoTrackId !== undefined;
  const wantsAudio = (asset.kind === 'audio' || hasAudioStream) && audioTrackId !== undefined;
  if (!wantsVideo && !wantsAudio) return;

  const at = Math.max(
    wantsVideo ? trackEndFlicks(sequence.tracks[videoTrackId]) : 0,
    wantsAudio ? trackEndFlicks(sequence.tracks[audioTrackId]) : 0,
  );

  const placements: InsertClipsArgs['placements'] = [];
  if (wantsVideo) {
    placements.push({
      type: 'video',
      trackId: videoTrackId,
      assetId,
      sourceIn: flicks(0),
      duration: asset.info.durationFlicks,
    });
  }
  if (wantsAudio) {
    placements.push({
      type: 'audio',
      trackId: audioTrackId,
      assetId,
      sourceIn: flicks(0),
      duration: asset.info.durationFlicks,
      streamIndex: asset.kind === 'audio' ? 0 : (asset.info.audio[0]?.streamIndex ?? 0),
      gainDb: 0,
    });
  }

  store.dispatch(
    insertClips,
    {
      sequenceId: sequence.id,
      at: flicks(at),
      mode: 'overwrite',
      link: placements.length > 1,
      placements,
    },
    'Add to timeline',
  );
}
