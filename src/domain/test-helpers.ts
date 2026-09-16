import type { IdGenerator } from './ids';
import {
  createCounterIdGenerator,
  newAssetId,
  newClipId,
  newLinkId,
  newMarkerId,
  newProjectId,
  newSequenceId,
  newTrackId,
} from './ids';
import type { Asset, AudioClip, Marker, MediaInfo, Project, VideoClip } from './model';
import { SEQUENCE_FORMAT_PRESETS } from './model/sequence';
import type { Flicks } from './time';
import { flicks, flicksPerFrame } from './time';

/** Test-only fixture builders. Not imported by any production (non-test) module. */

export function makeMediaInfo(durationFlicksValue: Flicks): MediaInfo {
  return {
    container: 'mp4',
    durationFlicks: durationFlicksValue,
    sizeBytes: 1_000_000,
    bitRate: 5_000_000,
    video: {
      streamIndex: 0,
      codec: 'h264',
      profile: 'High',
      width: 1920,
      height: 1080,
      sampleAspectRatio: { num: 1, den: 1 },
      rotation: 0,
      frameRate: { num: 30, den: 1 },
      avgFrameRate: { num: 30, den: 1 },
      isVariableFrameRate: false,
      pixelFormat: 'yuv420p',
      bitDepth: 8,
      colorPrimaries: 'bt709',
      colorTransfer: 'bt709',
      colorSpace: 'bt709',
      colorRange: 'tv',
      isHdr: false,
      hasAlpha: false,
      startOffsetFlicks: flicks(0),
      durationFlicks: durationFlicksValue,
    },
    audio: [
      {
        streamIndex: 0,
        codec: 'aac',
        sampleRate: 48000,
        channels: 2,
        channelLayout: 'stereo',
        language: null,
        startOffsetFlicks: flicks(0),
        durationFlicks: durationFlicksValue,
      },
    ],
    image: null,
    probedWith: 'ffprobe-test',
  };
}

export function makeAsset(
  ids: IdGenerator,
  kind: 'video' | 'audio' | 'image' = 'video',
  durationFlicksValue: Flicks = flicks(flicksPerFrame({ num: 30, den: 1 }) * 300),
): Asset {
  return {
    id: newAssetId(ids),
    kind,
    name: `${kind}-asset`,
    source: {
      path: `C:\\media\\${kind}.mp4`,
      relativePath: null,
      fingerprint: { sizeBytes: 1_000_000, modifiedMs: 0, sampleHash: 'abc' },
    },
    info: makeMediaInfo(durationFlicksValue),
  };
}

/** One sequence (YouTube 1080p/30fps), one linked video+audio clip on one track each. */
export function makeValidProject(ids: IdGenerator = createCounterIdGenerator()): Project {
  const format = SEQUENCE_FORMAT_PRESETS.youtube1080p;
  const frameDuration = flicksPerFrame(format.frameRate);
  const asset = makeAsset(ids, 'video');
  const clipDuration = flicks(frameDuration * 30);
  const linkId = newLinkId(ids);

  const videoClip: VideoClip = {
    id: newClipId(ids),
    start: flicks(0),
    duration: clipDuration,
    sourceIn: flicks(0),
    linkId,
    enabled: true,
    type: 'video',
    assetId: asset.id,
  };
  const audioClip: AudioClip = {
    id: newClipId(ids),
    start: flicks(0),
    duration: clipDuration,
    sourceIn: flicks(0),
    linkId,
    enabled: true,
    type: 'audio',
    assetId: asset.id,
    streamIndex: 0,
    gainDb: 0,
  };

  const videoTrackId = newTrackId(ids);
  const audioTrackId = newTrackId(ids);
  const sequenceId = newSequenceId(ids);

  return {
    id: newProjectId(ids),
    name: 'Test Project',
    createdAt: new Date(0).toISOString(),
    settings: { defaultSequenceFormat: format, proxyPolicy: 'auto' },
    assets: { [asset.id]: asset },
    sequences: {
      [sequenceId]: {
        id: sequenceId,
        name: 'Sequence 1',
        format,
        tracks: {
          [videoTrackId]: {
            id: videoTrackId,
            name: 'V1',
            locked: false,
            kind: 'video',
            hidden: false,
            clips: [videoClip],
          },
          [audioTrackId]: {
            id: audioTrackId,
            name: 'A1',
            locked: false,
            kind: 'audio',
            muted: false,
            clips: [audioClip],
          },
        },
        videoTracks: [videoTrackId],
        audioTracks: [audioTrackId],
        markers: [],
      },
    },
    sequenceOrder: [sequenceId],
    activeSequenceId: sequenceId,
  };
}

/** One video track with `clipCount` sequential, non-overlapping clips (for P2's 5,000-clip gate). */
export function makeProjectWithClips(ids: IdGenerator, clipCount: number): Project {
  const format = SEQUENCE_FORMAT_PRESETS.youtube1080p;
  const frameDuration = flicksPerFrame(format.frameRate);
  const clipDuration = frameDuration * 30; // 1 second each
  const asset = makeAsset(ids, 'video', flicks(clipDuration * clipCount + frameDuration));
  const videoTrackId = newTrackId(ids);
  const sequenceId = newSequenceId(ids);

  const clips: VideoClip[] = [];
  let cursor = 0;
  for (let i = 0; i < clipCount; i += 1) {
    clips.push({
      id: newClipId(ids),
      start: flicks(cursor),
      duration: flicks(clipDuration),
      sourceIn: flicks(cursor),
      linkId: null,
      enabled: true,
      type: 'video',
      assetId: asset.id,
    });
    cursor += clipDuration;
  }

  return {
    id: newProjectId(ids),
    name: 'Perf Project',
    createdAt: new Date(0).toISOString(),
    settings: { defaultSequenceFormat: format, proxyPolicy: 'auto' },
    assets: { [asset.id]: asset },
    sequences: {
      [sequenceId]: {
        id: sequenceId,
        name: 'Sequence 1',
        format,
        tracks: {
          [videoTrackId]: {
            id: videoTrackId,
            name: 'V1',
            locked: false,
            kind: 'video',
            hidden: false,
            clips,
          },
        },
        videoTracks: [videoTrackId],
        audioTracks: [],
        markers: [],
      },
    },
    sequenceOrder: [sequenceId],
    activeSequenceId: sequenceId,
  };
}

export function makeMarker(
  ids: IdGenerator,
  time: Flicks,
  overrides: Partial<Marker> = {},
): Marker {
  return { id: newMarkerId(ids), time, label: 'Marker', color: 'blue', ...overrides };
}
