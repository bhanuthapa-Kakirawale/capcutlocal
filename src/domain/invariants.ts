import { flicksPerFrame } from './time';
import type { Project } from './model';
import type { AudioClip, VideoClip } from './model/clip';
import type { Track } from './model/track';

/*
 * Cross-entity rules a Project must always satisfy (docs/TIMELINE.md §4). Runs after
 * every edit op in dev/test and on load and save in release. Only the rules that apply
 * to the schema-v1 model are checked here; transitions and keyframes join when their
 * fields do (P7/P9).
 */

export type InvariantViolation = {
  rule:
    | 'TRACK_ORDER_MISMATCH'
    | 'CLIP_NOT_FRAME_ALIGNED'
    | 'CLIP_TOO_SHORT'
    | 'CLIP_ORDER_OR_OVERLAP'
    | 'CLIP_OUT_OF_MEDIA_BOUNDS'
    | 'ASSET_NOT_FOUND'
    | 'ASSET_KIND_MISMATCH'
    | 'AUDIO_STREAM_NOT_FOUND'
    | 'LINK_GROUP_TOO_SMALL'
    | 'LINK_GROUP_SPANS_SEQUENCES';
  message: string;
  path: string;
};

export function checkInvariants(project: Project): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const linkGroups = new Map<string, { sequenceIds: Set<string>; clipCount: number }>();

  for (const [sequenceId, sequence] of Object.entries(project.sequences)) {
    checkTrackOrder(sequence.tracks, sequence.videoTracks, 'video', sequenceId, violations);
    checkTrackOrder(sequence.tracks, sequence.audioTracks, 'audio', sequenceId, violations);

    const frameDuration = flicksPerFrame(sequence.format.frameRate);
    for (const [trackId, track] of Object.entries(sequence.tracks)) {
      const path = `sequences.${sequenceId}.tracks.${trackId}`;
      checkClipsSortedAndNonOverlapping(track, path, violations);
      for (const [index, clip] of track.clips.entries()) {
        const clipPath = `${path}.clips[${index.toString()}]`;
        checkFrameAlignment(clip, frameDuration, clipPath, violations);
        checkReferenceAndBounds(clip, track.kind, project, clipPath, violations);
        if (clip.linkId !== null) {
          const group = linkGroups.get(clip.linkId) ?? { sequenceIds: new Set(), clipCount: 0 };
          group.sequenceIds.add(sequenceId);
          group.clipCount += 1;
          linkGroups.set(clip.linkId, group);
        }
      }
    }
  }

  for (const [linkId, group] of linkGroups) {
    if (group.clipCount < 2) {
      violations.push({
        rule: 'LINK_GROUP_TOO_SMALL',
        message: `linkId ${linkId} has only ${group.clipCount.toString()} clip(s); links must have at least 2`,
        path: `<linkId ${linkId}>`,
      });
    }
    if (group.sequenceIds.size > 1) {
      violations.push({
        rule: 'LINK_GROUP_SPANS_SEQUENCES',
        message: `linkId ${linkId} has clips in ${group.sequenceIds.size.toString()} different sequences; a link must stay within one sequence`,
        path: `<linkId ${linkId}>`,
      });
    }
  }

  return violations;
}

function checkTrackOrder(
  tracks: Record<string, Track>,
  order: readonly string[],
  kind: Track['kind'],
  sequenceId: string,
  violations: InvariantViolation[],
): void {
  const expected = Object.values(tracks)
    .filter((track) => track.kind === kind)
    .map((track) => track.id)
    .sort();
  const actual = [...order].sort();
  const path = `sequences.${sequenceId}.${kind}Tracks`;
  if (new Set(order).size !== order.length) {
    violations.push({
      rule: 'TRACK_ORDER_MISMATCH',
      message: `${kind}Tracks contains a duplicate`,
      path,
    });
    return;
  }
  if (expected.length !== actual.length || expected.some((id, i) => id !== actual[i])) {
    violations.push({
      rule: 'TRACK_ORDER_MISMATCH',
      message: `${kind}Tracks does not list exactly the sequence's ${kind} tracks`,
      path,
    });
  }
}

function checkClipsSortedAndNonOverlapping(
  track: Track,
  path: string,
  violations: InvariantViolation[],
): void {
  for (let i = 1; i < track.clips.length; i += 1) {
    const previous = track.clips[i - 1];
    const current = track.clips[i];
    if (!previous || !current) continue;
    if (previous.start + previous.duration > current.start) {
      violations.push({
        rule: 'CLIP_ORDER_OR_OVERLAP',
        message: `clip ${i.toString()} starts before clip ${(i - 1).toString()} ends`,
        path: `${path}.clips[${i.toString()}]`,
      });
    }
  }
}

function checkFrameAlignment(
  clip: VideoClip | AudioClip,
  frameDuration: number,
  path: string,
  violations: InvariantViolation[],
): void {
  if (clip.start < 0 || clip.start % frameDuration !== 0) {
    violations.push({
      rule: 'CLIP_NOT_FRAME_ALIGNED',
      message: 'start is not frame-aligned',
      path,
    });
  }
  if (clip.duration < frameDuration || clip.duration % frameDuration !== 0) {
    violations.push({
      rule: clip.duration < frameDuration ? 'CLIP_TOO_SHORT' : 'CLIP_NOT_FRAME_ALIGNED',
      message:
        clip.duration < frameDuration
          ? 'duration is shorter than one frame'
          : 'duration is not frame-aligned',
      path,
    });
  }
}

function checkReferenceAndBounds(
  clip: VideoClip | AudioClip,
  trackKind: Track['kind'],
  project: Project,
  path: string,
  violations: InvariantViolation[],
): void {
  const asset = project.assets[clip.assetId];
  if (!asset) {
    violations.push({
      rule: 'ASSET_NOT_FOUND',
      message: `assetId ${clip.assetId} does not exist`,
      path,
    });
    return;
  }

  if (trackKind === 'video' && asset.kind !== 'video' && asset.kind !== 'image') {
    violations.push({
      rule: 'ASSET_KIND_MISMATCH',
      message: `video track clip references a "${asset.kind}" asset`,
      path,
    });
  }
  if (trackKind === 'audio') {
    const stream = clip.type === 'audio' ? asset.info.audio[clip.streamIndex] : undefined;
    if (!stream) {
      violations.push({
        rule: 'AUDIO_STREAM_NOT_FOUND',
        message:
          clip.type === 'audio'
            ? `asset has no audio stream at index ${clip.streamIndex.toString()}`
            : 'audio track clip is not an audio clip',
        path,
      });
    }
  }

  // Images have no natural duration and are exempt from media-bounds checking (docs/TIMELINE.md §3.1).
  if (asset.kind === 'image') return;
  if (clip.sourceIn < 0 || clip.sourceIn + clip.duration > asset.info.durationFlicks) {
    violations.push({
      rule: 'CLIP_OUT_OF_MEDIA_BOUNDS',
      message: `sourceIn + duration exceeds the asset's media duration (${asset.info.durationFlicks.toString()} flicks)`,
      path,
    });
  }
}
