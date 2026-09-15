import fc from 'fast-check';
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { checkInvariants } from './invariants';
import { createCounterIdGenerator, newClipId, type TrackId } from './ids';
import type { Project, Sequence } from './model';
import type { AudioClip, VideoClip } from './model/clip';
import { makeAsset, makeValidProject } from './test-helpers';
import { flicks, flicksPerFrame } from './time';

describe('checkInvariants', () => {
  it('finds no violations in a well-formed project', () => {
    expect(checkInvariants(makeValidProject())).toEqual([]);
  });

  it('flags a clip whose start is not frame-aligned', () => {
    const project = mutateFirstVideoClip(makeValidProject(), (clip) => {
      clip.start = flicks(1);
    });
    expect(ruleSet(project)).toContain('CLIP_NOT_FRAME_ALIGNED');
  });

  it('flags a clip shorter than one frame', () => {
    const project = mutateFirstVideoClip(makeValidProject(), (clip) => {
      clip.duration = flicks(0);
    });
    expect(ruleSet(project)).toContain('CLIP_TOO_SHORT');
  });

  it('flags two clips on the same track that overlap', () => {
    const ids = createCounterIdGenerator();
    const project = mutateSequence(makeValidProject(ids), (sequence) => {
      const videoTrackId = sequence.videoTracks[0];
      const track = videoTrackId ? sequence.tracks[videoTrackId] : undefined;
      if (!track || track.kind !== 'video') throw new Error('fixture missing a video clip');
      const first = track.clips[0];
      if (!first) throw new Error('fixture missing a video clip');
      const second: VideoClip = { ...first, id: newClipId(ids), start: flicks(first.duration - 1) };
      track.clips.push(second);
    });
    expect(ruleSet(project)).toContain('CLIP_ORDER_OR_OVERLAP');
  });

  it('flags a clip referencing an asset that does not exist', () => {
    const project = mutateFirstVideoClip(makeValidProject(), (clip) => {
      clip.assetId = 'missing-asset' as VideoClip['assetId'];
    });
    expect(ruleSet(project)).toContain('ASSET_NOT_FOUND');
  });

  it('flags a video clip whose asset has no video (audio-only asset on a video track)', () => {
    const ids = createCounterIdGenerator();
    const audioOnly = makeAsset(ids, 'audio');
    const project = produce(makeValidProject(ids), (draft) => {
      draft.assets[audioOnly.id] = audioOnly;
    });
    const withAudioAsset = mutateFirstVideoClip(project, (clip) => {
      clip.assetId = audioOnly.id;
    });
    expect(ruleSet(withAudioAsset)).toContain('ASSET_KIND_MISMATCH');
  });

  it('flags an audio clip whose streamIndex does not exist on the asset', () => {
    const project = mutateFirstAudioClip(makeValidProject(), (clip) => {
      clip.streamIndex = 5;
    });
    expect(ruleSet(project)).toContain('AUDIO_STREAM_NOT_FOUND');
  });

  it('flags a clip whose sourceIn + duration exceeds the asset duration', () => {
    const project = mutateFirstVideoClip(makeValidProject(), (clip) => {
      clip.sourceIn = flicks(1_000_000_000_000);
    });
    expect(ruleSet(project)).toContain('CLIP_OUT_OF_MEDIA_BOUNDS');
  });

  it('does not bounds-check clips referencing an image asset', () => {
    const ids = createCounterIdGenerator();
    const image = makeAsset(ids, 'image');
    const project = produce(makeValidProject(ids), (draft) => {
      draft.assets[image.id] = image;
    });
    const withImageClip = mutateFirstVideoClip(project, (clip) => {
      clip.assetId = image.id;
      clip.sourceIn = flicks(1_000_000_000_000); // would violate bounds for a video asset
    });
    expect(ruleSet(withImageClip)).not.toContain('CLIP_OUT_OF_MEDIA_BOUNDS');
  });

  it('flags a linkId used by only one clip', () => {
    const project = mutateFirstAudioClip(makeValidProject(), (clip) => {
      clip.linkId = null;
    });
    // The video clip still has the (now orphaned) linkId; the group has size 1.
    expect(ruleSet(project)).toContain('LINK_GROUP_TOO_SMALL');
  });

  it('flags videoTracks listing a track id that is not in the sequence', () => {
    const project = mutateSequence(makeValidProject(), (sequence) => {
      sequence.videoTracks.push('not-a-real-track-id' as TrackId);
    });
    expect(ruleSet(project)).toContain('TRACK_ORDER_MISMATCH');
  });

  it('accepts any number of sequential, non-overlapping, frame-aligned clips', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 1, maxLength: 30 }),
        (frameCounts) => {
          const ids = createCounterIdGenerator();
          const project = makeValidProject(ids);
          const sequenceId = project.activeSequenceId;
          const sequence = project.sequences[sequenceId];
          const videoTrackId = sequence?.videoTracks[0];
          if (!sequence || !videoTrackId) throw new Error('fixture missing a video track');
          const frameDuration = flicksPerFrame(sequence.format.frameRate);

          const withGeneratedClips = mutateSequence(project, (draftSequence) => {
            const track = draftSequence.tracks[videoTrackId];
            if (!track || track.kind !== 'video') throw new Error('fixture missing a video track');
            const original = track.clips[0];
            if (!original) throw new Error('fixture missing a video clip');
            let cursor = 0;
            track.clips = frameCounts.map((frames) => {
              const duration = flicks(frames * frameDuration);
              const clip: VideoClip = {
                ...original,
                id: newClipId(ids),
                start: flicks(cursor),
                duration,
              };
              cursor += duration;
              return clip;
            });
          });

          expect(checkInvariants(withGeneratedClips)).toEqual([]);
        },
      ),
    );
  });
});

function ruleSet(project: Project): Set<string> {
  return new Set(checkInvariants(project).map((v) => v.rule));
}

function mutateFirstVideoClip(project: Project, recipe: (clip: VideoClip) => void): Project {
  return mutateSequence(project, (sequence) => {
    const trackId = sequence.videoTracks[0];
    const track = trackId ? sequence.tracks[trackId] : undefined;
    if (!track || track.kind !== 'video') throw new Error('fixture missing a video clip');
    const clip = track.clips[0];
    if (!clip) throw new Error('fixture missing a video clip');
    recipe(clip);
  });
}

function mutateFirstAudioClip(project: Project, recipe: (clip: AudioClip) => void): Project {
  return mutateSequence(project, (sequence) => {
    const trackId = sequence.audioTracks[0];
    const track = trackId ? sequence.tracks[trackId] : undefined;
    if (!track || track.kind !== 'audio') throw new Error('fixture missing an audio clip');
    const clip = track.clips[0];
    if (!clip) throw new Error('fixture missing an audio clip');
    recipe(clip);
  });
}

function mutateSequence(project: Project, recipe: (sequence: Sequence) => void): Project {
  return produce(project, (draft) => {
    const sequence = draft.sequences[draft.activeSequenceId];
    if (!sequence) throw new Error('fixture missing its active sequence');
    recipe(sequence);
  });
}
