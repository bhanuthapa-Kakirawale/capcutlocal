import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkInvariants } from '../invariants';
import {
  createCounterIdGenerator,
  type ClipId,
  type IdGenerator,
  type SequenceId,
  type TrackId,
} from '../ids';
import type { Project } from '../model';
import { makeProjectWithClips, makeValidProject } from '../test-helpers';
import { flicks, flicksPerFrame } from '../time';
import {
  closeGap,
  deleteClips,
  insertClips,
  moveClips,
  rippleDelete,
  rollEdit,
  splitClips,
  trimClip,
} from './clips';
import { addTrack } from './tracks';

const FRAME: number = flicksPerFrame({ num: 30, den: 1 });

function setup(): { ids: IdGenerator; project: Project; sequenceId: SequenceId } {
  const ids = createCounterIdGenerator();
  const project = makeValidProject(ids);
  const sequenceId = project.sequenceOrder[0];
  if (!sequenceId) throw new Error('fixture has no sequence');
  return { ids, project, sequenceId };
}

function videoTrackId(project: Project, sequenceId: SequenceId, index = 0): TrackId {
  const id = project.sequences[sequenceId]?.videoTracks[index];
  if (!id) throw new Error('expected a video track');
  return id;
}
function audioTrackId(project: Project, sequenceId: SequenceId, index = 0): TrackId {
  const id = project.sequences[sequenceId]?.audioTracks[index];
  if (!id) throw new Error('expected an audio track');
  return id;
}
function clipsOnTrack(project: Project, sequenceId: SequenceId, trackId: TrackId) {
  return project.sequences[sequenceId]?.tracks[trackId]?.clips ?? [];
}

describe('insertClips', () => {
  it('places a new video clip on an empty track', () => {
    const { ids, project, sequenceId } = setup();
    const added = addTrack(project, { sequenceId, kind: 'video' }, { ids });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const trackId = videoTrackId(added.value, sequenceId, 1);
    const assetId = Object.keys(added.value.assets)[0] as never;

    const result = insertClips(
      added.value,
      {
        sequenceId,
        at: flicks(0),
        mode: 'overwrite',
        placements: [
          { type: 'video', trackId, assetId, sourceIn: flicks(0), duration: flicks(FRAME * 10) },
        ],
      },
      { ids },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clips = clipsOnTrack(result.value, sequenceId, trackId);
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ start: 0, duration: FRAME * 10, enabled: true, linkId: null });
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('overwrite mode trims the clip underneath', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const assetId = Object.keys(project.assets)[0] as never;
    // Existing video clip spans [0, 30 frames). Insert a 5-frame clip at frame 10.
    const result = insertClips(
      project,
      {
        sequenceId,
        at: flicks(FRAME * 10),
        mode: 'overwrite',
        placements: [
          { type: 'video', trackId, assetId, sourceIn: flicks(0), duration: flicks(FRAME * 5) },
        ],
      },
      { ids },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clips = clipsOnTrack(result.value, sequenceId, trackId);
    expect(clips.map((c) => [c.start, c.duration])).toEqual([
      [0, FRAME * 10],
      [FRAME * 10, FRAME * 5],
      [FRAME * 15, FRAME * 15],
    ]);
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('insert mode ripples the track and the linked partner on another track', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const audioId = audioTrackId(project, sequenceId);
    const assetId = Object.keys(project.assets)[0] as never;

    const result = insertClips(
      project,
      {
        sequenceId,
        at: flicks(0),
        mode: 'insert',
        placements: [
          { type: 'video', trackId, assetId, sourceIn: flicks(0), duration: flicks(FRAME * 5) },
        ],
      },
      { ids },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const videoClips = clipsOnTrack(result.value, sequenceId, trackId);
    const audioClips = clipsOnTrack(result.value, sequenceId, audioId);
    expect(videoClips[0]?.start).toBe(0);
    expect(videoClips[1]?.start).toBe(FRAME * 5);
    expect(audioClips[0]?.start).toBe(FRAME * 5);
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('rejects placing a video clip on an audio track', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = audioTrackId(project, sequenceId);
    const assetId = Object.keys(project.assets)[0] as never;
    const result = insertClips(
      project,
      {
        sequenceId,
        at: flicks(0),
        mode: 'overwrite',
        placements: [
          { type: 'video', trackId, assetId, sourceIn: flicks(0), duration: flicks(FRAME) },
        ],
      },
      { ids },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('COLLISION');
  });

  it('rejects inserting onto a locked track', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const locked = { ...project, sequences: { ...project.sequences } };
    const sequence = locked.sequences[sequenceId];
    if (!sequence) throw new Error('missing sequence');
    locked.sequences[sequenceId] = {
      ...sequence,
      tracks: {
        ...sequence.tracks,
        [trackId]: { ...sequence.tracks[trackId], locked: true } as never,
      },
    };
    const assetId = Object.keys(project.assets)[0] as never;
    const result = insertClips(
      locked,
      {
        sequenceId,
        at: flicks(0),
        mode: 'overwrite',
        placements: [
          { type: 'video', trackId, assetId, sourceIn: flicks(0), duration: flicks(FRAME) },
        ],
      },
      { ids },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('TRACK_LOCKED');
  });

  it('mints one shared linkId across placements when link is true', () => {
    const { ids, project, sequenceId } = setup();
    const addedTrack = addTrack(project, { sequenceId, kind: 'audio' }, { ids });
    expect(addedTrack.ok).toBe(true);
    if (!addedTrack.ok) return;
    const videoId = videoTrackId(addedTrack.value, sequenceId);
    const newAudioId = audioTrackId(addedTrack.value, sequenceId, 1);
    const assetId = Object.keys(addedTrack.value.assets)[0] as never;

    const result = insertClips(
      addedTrack.value,
      {
        sequenceId,
        at: flicks(FRAME * 20),
        mode: 'overwrite',
        link: true,
        placements: [
          {
            type: 'video',
            trackId: videoId,
            assetId,
            sourceIn: flicks(0),
            duration: flicks(FRAME * 5),
          },
          {
            type: 'audio',
            trackId: newAudioId,
            assetId,
            sourceIn: flicks(0),
            duration: flicks(FRAME * 5),
            streamIndex: 0,
            gainDb: 0,
          },
        ],
      },
      { ids },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const video = clipsOnTrack(result.value, sequenceId, videoId).find(
      (c) => c.start === FRAME * 20,
    );
    const audio = clipsOnTrack(result.value, sequenceId, newAudioId).find(
      (c) => c.start === FRAME * 20,
    );
    expect(video?.linkId).not.toBeNull();
    expect(video?.linkId).toBe(audio?.linkId);
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('never mutates the original project', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const assetId = Object.keys(project.assets)[0] as never;
    const before = JSON.stringify(project);
    insertClips(
      project,
      {
        sequenceId,
        at: flicks(FRAME * 100),
        mode: 'overwrite',
        placements: [
          { type: 'video', trackId, assetId, sourceIn: flicks(0), duration: flicks(FRAME) },
        ],
      },
      { ids },
    );
    expect(JSON.stringify(project)).toBe(before);
  });
});

describe('moveClips', () => {
  it('moves a clip and its linked partner by the same delta', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const audioId = audioTrackId(project, sequenceId);
    const videoClipId = clipsOnTrack(project, sequenceId, trackId)[0]?.id;
    if (!videoClipId) throw new Error('fixture missing video clip');

    const result = moveClips(
      project,
      {
        sequenceId,
        moves: [{ clipId: videoClipId, toTrackId: trackId }],
        deltaTime: flicks(FRAME * 5),
        mode: 'overwrite',
      },
      { ids },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(clipsOnTrack(result.value, sequenceId, trackId)[0]?.start).toBe(FRAME * 5);
    expect(clipsOnTrack(result.value, sequenceId, audioId)[0]?.start).toBe(FRAME * 5);
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('moves a clip to a different track of the same kind', () => {
    const { ids, project, sequenceId } = setup();
    const added = addTrack(project, { sequenceId, kind: 'video' }, { ids });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const sourceTrack = videoTrackId(added.value, sequenceId, 0);
    const destTrack = videoTrackId(added.value, sequenceId, 1);
    const videoClipId = clipsOnTrack(added.value, sequenceId, sourceTrack)[0]?.id;
    if (!videoClipId) throw new Error('fixture missing video clip');

    const result = moveClips(
      added.value,
      {
        sequenceId,
        moves: [{ clipId: videoClipId, toTrackId: destTrack }],
        deltaTime: flicks(0),
        mode: 'overwrite',
      },
      { ids },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(clipsOnTrack(result.value, sequenceId, sourceTrack)).toHaveLength(0);
    expect(clipsOnTrack(result.value, sequenceId, destTrack)).toHaveLength(1);
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('clamps a large negative delta so start never goes below zero', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const videoClipId = clipsOnTrack(project, sequenceId, trackId)[0]?.id;
    if (!videoClipId) throw new Error('fixture missing video clip');

    const result = moveClips(
      project,
      {
        sequenceId,
        moves: [{ clipId: videoClipId, toTrackId: trackId }],
        deltaTime: flicks(-FRAME * 999),
        mode: 'overwrite',
      },
      { ids },
    );
    expect(result.ok).toBe(true);
    expect(result.ok && clipsOnTrack(result.value, sequenceId, trackId)[0]?.start).toBe(0);
  });

  it('rejects moving a video clip onto an audio track', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const audioId = audioTrackId(project, sequenceId);
    const videoClipId = clipsOnTrack(project, sequenceId, trackId)[0]?.id;
    if (!videoClipId) throw new Error('fixture missing video clip');

    const result = moveClips(
      project,
      {
        sequenceId,
        moves: [{ clipId: videoClipId, toTrackId: audioId }],
        deltaTime: flicks(0),
        mode: 'overwrite',
      },
      { ids },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('COLLISION');
  });

  it('is a no-op for zero delta and no track change (same reference)', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const videoClipId = clipsOnTrack(project, sequenceId, trackId)[0]?.id;
    if (!videoClipId) throw new Error('fixture missing video clip');
    const result = moveClips(
      project,
      {
        sequenceId,
        moves: [{ clipId: videoClipId, toTrackId: trackId }],
        deltaTime: flicks(0),
        mode: 'overwrite',
      },
      { ids },
    );
    expect(result.ok && result.value).toBe(project);
  });
});

describe('trimClip', () => {
  it('trims the tail shorter (non-ripple)', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const clipId = clipsOnTrack(project, sequenceId, trackId)[0]?.id;
    if (!clipId) throw new Error('fixture missing clip');

    const result = trimClip(
      project,
      { sequenceId, clipId, edge: 'tail', delta: flicks(-FRAME * 5) },
      { ids },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(clipsOnTrack(result.value, sequenceId, trackId)[0]?.duration).toBe(FRAME * 25);
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('clamps the tail so duration never drops below one frame', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const clipId = clipsOnTrack(project, sequenceId, trackId)[0]?.id;
    if (!clipId) throw new Error('fixture missing clip');

    const result = trimClip(
      project,
      { sequenceId, clipId, edge: 'tail', delta: flicks(-FRAME * 999) },
      { ids },
    );
    expect(result.ok).toBe(true);
    expect(result.ok && clipsOnTrack(result.value, sequenceId, trackId)[0]?.duration).toBe(FRAME);
  });

  it('clamps the head so it cannot extend past the available media handle', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const clipId = clipsOnTrack(project, sequenceId, trackId)[0]?.id;
    if (!clipId) throw new Error('fixture missing clip');
    // sourceIn is already 0, so extending the head backward has no handle available.
    const result = trimClip(
      project,
      { sequenceId, clipId, edge: 'head', delta: flicks(-FRAME) },
      { ids },
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(project);
  });

  it('trims the head shorter, moving start/sourceIn forward', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const clipId = clipsOnTrack(project, sequenceId, trackId)[0]?.id;
    if (!clipId) throw new Error('fixture missing clip');

    const result = trimClip(
      project,
      { sequenceId, clipId, edge: 'head', delta: flicks(FRAME * 5) },
      { ids },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clip = clipsOnTrack(result.value, sequenceId, trackId)[0];
    expect(clip).toMatchObject({ start: FRAME * 5, sourceIn: FRAME * 5, duration: FRAME * 25 });
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('ripple tail trim shifts later clips and their linked partners', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const audioId = audioTrackId(project, sequenceId);
    const assetId = Object.keys(project.assets)[0] as never;

    // Add a second video clip right after the first, at [30, 40) frames.
    const withSecond = insertClips(
      project,
      {
        sequenceId,
        at: flicks(FRAME * 30),
        mode: 'overwrite',
        placements: [
          { type: 'video', trackId, assetId, sourceIn: flicks(0), duration: flicks(FRAME * 10) },
        ],
      },
      { ids },
    );
    expect(withSecond.ok).toBe(true);
    if (!withSecond.ok) return;
    const firstClipId = clipsOnTrack(withSecond.value, sequenceId, trackId)[0]?.id;
    if (!firstClipId) throw new Error('missing first clip');

    const result = trimClip(
      withSecond.value,
      { sequenceId, clipId: firstClipId, edge: 'tail', delta: flicks(FRAME * 5), ripple: true },
      { ids },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const videoClips = clipsOnTrack(result.value, sequenceId, trackId);
    expect(videoClips[0]?.duration).toBe(FRAME * 35);
    expect(videoClips[1]?.start).toBe(FRAME * 35);
    // The trimmed clip's own linked audio partner starts before the ripple pivot (the
    // trimmed clip's old end), so it is untouched — only clips at/after the pivot ripple.
    expect(clipsOnTrack(result.value, sequenceId, audioId)[0]?.start).toBe(0);
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('ripple tail trim also shifts a linked partner that starts at or after the pivot', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const audioId = audioTrackId(project, sequenceId);
    const assetId = Object.keys(project.assets)[0] as never;

    // A second, linked video+audio pair at [30, 40) frames — both start at the pivot.
    const withSecond = insertClips(
      project,
      {
        sequenceId,
        at: flicks(FRAME * 30),
        mode: 'overwrite',
        link: true,
        placements: [
          { type: 'video', trackId, assetId, sourceIn: flicks(0), duration: flicks(FRAME * 10) },
          {
            type: 'audio',
            trackId: audioId,
            assetId,
            sourceIn: flicks(0),
            duration: flicks(FRAME * 10),
            streamIndex: 0,
            gainDb: 0,
          },
        ],
      },
      { ids },
    );
    expect(withSecond.ok).toBe(true);
    if (!withSecond.ok) return;
    const firstVideoId = clipsOnTrack(withSecond.value, sequenceId, trackId)[0]?.id;
    if (!firstVideoId) throw new Error('missing clip');

    const result = trimClip(
      withSecond.value,
      { sequenceId, clipId: firstVideoId, edge: 'tail', delta: flicks(FRAME * 5), ripple: true },
      { ids },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(clipsOnTrack(result.value, sequenceId, trackId)[1]?.start).toBe(FRAME * 35);
    // The second pair's audio half lives on a track this trim never directly touched,
    // but it's linked to the second video clip, which did ripple — so it follows.
    expect(clipsOnTrack(result.value, sequenceId, audioId)[1]?.start).toBe(FRAME * 35);
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('rejects trimming a clip on a locked track', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const clipId = clipsOnTrack(project, sequenceId, trackId)[0]?.id;
    if (!clipId) throw new Error('fixture missing clip');
    const sequence = project.sequences[sequenceId];
    if (!sequence) throw new Error('missing sequence');
    const locked: Project = {
      ...project,
      sequences: {
        ...project.sequences,
        [sequenceId]: {
          ...sequence,
          tracks: {
            ...sequence.tracks,
            [trackId]: { ...sequence.tracks[trackId], locked: true } as never,
          },
        },
      },
    };
    const result = trimClip(
      locked,
      { sequenceId, clipId, edge: 'tail', delta: flicks(-FRAME) },
      { ids },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('TRACK_LOCKED');
  });
});

describe('splitClips', () => {
  it('splits a linked pair, giving the right halves a new shared linkId', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const audioId = audioTrackId(project, sequenceId);
    const originalVideoId = clipsOnTrack(project, sequenceId, trackId)[0]?.id;
    const originalAudioId = clipsOnTrack(project, sequenceId, audioId)[0]?.id;
    const originalLinkId = clipsOnTrack(project, sequenceId, trackId)[0]?.linkId;

    const result = splitClips(project, { sequenceId, at: flicks(FRAME * 10) }, { ids });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const videoClips = clipsOnTrack(result.value, sequenceId, trackId);
    const audioClips = clipsOnTrack(result.value, sequenceId, audioId);
    expect(videoClips).toHaveLength(2);
    expect(audioClips).toHaveLength(2);
    expect(videoClips[0]).toMatchObject({
      id: originalVideoId,
      start: 0,
      duration: FRAME * 10,
      linkId: originalLinkId,
    });
    expect(audioClips[0]).toMatchObject({
      id: originalAudioId,
      start: 0,
      duration: FRAME * 10,
      linkId: originalLinkId,
    });
    expect(videoClips[1]).toMatchObject({
      start: FRAME * 10,
      sourceIn: FRAME * 10,
      duration: FRAME * 20,
    });
    expect(videoClips[1]?.id).not.toBe(originalVideoId);
    expect(videoClips[1]?.linkId).not.toBeNull();
    expect(videoClips[1]?.linkId).not.toBe(originalLinkId);
    expect(videoClips[1]?.linkId).toBe(audioClips[1]?.linkId);
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('is a no-op when nothing spans the split point', () => {
    const { ids, project, sequenceId } = setup();
    const result = splitClips(project, { sequenceId, at: flicks(0) }, { ids });
    expect(result.ok && result.value).toBe(project);
  });

  it('rejects an explicit clip that does not span the split point', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const clipId = clipsOnTrack(project, sequenceId, trackId)[0]?.id;
    if (!clipId) throw new Error('fixture missing clip');
    const result = splitClips(
      project,
      { sequenceId, at: flicks(FRAME * 999), clipIds: [clipId] },
      { ids },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('VALIDATION');
  });
});

describe('deleteClips', () => {
  it('lifts a clip and its linked partner, leaving a gap', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const audioId = audioTrackId(project, sequenceId);
    const assetId = Object.keys(project.assets)[0] as never;
    const withSecond = insertClips(
      project,
      {
        sequenceId,
        at: flicks(FRAME * 30),
        mode: 'overwrite',
        placements: [
          { type: 'video', trackId, assetId, sourceIn: flicks(0), duration: flicks(FRAME * 10) },
        ],
      },
      { ids },
    );
    expect(withSecond.ok).toBe(true);
    if (!withSecond.ok) return;
    const firstVideoId = clipsOnTrack(withSecond.value, sequenceId, trackId)[0]?.id;
    if (!firstVideoId) throw new Error('missing clip');

    const result = deleteClips(withSecond.value, { sequenceId, clipIds: [firstVideoId] }, { ids });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const videoClips = clipsOnTrack(result.value, sequenceId, trackId);
    expect(videoClips).toHaveLength(1);
    expect(videoClips[0]?.start).toBe(FRAME * 30);
    expect(clipsOnTrack(result.value, sequenceId, audioId)).toHaveLength(0);
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('rejects deleting from a locked track', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const clipId = clipsOnTrack(project, sequenceId, trackId)[0]?.id;
    if (!clipId) throw new Error('fixture missing clip');
    const sequence = project.sequences[sequenceId];
    if (!sequence) throw new Error('missing sequence');
    const locked: Project = {
      ...project,
      sequences: {
        ...project.sequences,
        [sequenceId]: {
          ...sequence,
          tracks: {
            ...sequence.tracks,
            [trackId]: { ...sequence.tracks[trackId], locked: true } as never,
          },
        },
      },
    };
    const result = deleteClips(locked, { sequenceId, clipIds: [clipId] }, { ids });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('TRACK_LOCKED');
  });

  it('rejects an unknown clip', () => {
    const { ids, project, sequenceId } = setup();
    const result = deleteClips(project, { sequenceId, clipIds: ['missing' as ClipId] }, { ids });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('NOT_FOUND');
  });
});

describe('rippleDelete', () => {
  it('closes the gap on affected tracks and shifts markers after the removed range', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const audioId = audioTrackId(project, sequenceId);
    const assetId = Object.keys(project.assets)[0] as never;
    const withSecond = insertClips(
      project,
      {
        sequenceId,
        at: flicks(FRAME * 30),
        mode: 'overwrite',
        placements: [
          { type: 'video', trackId, assetId, sourceIn: flicks(0), duration: flicks(FRAME * 10) },
        ],
      },
      { ids },
    );
    expect(withSecond.ok).toBe(true);
    if (!withSecond.ok) return;
    const withMarker = {
      ...withSecond.value,
      sequences: {
        ...withSecond.value.sequences,
        [sequenceId]: {
          ...withSecond.value.sequences[sequenceId],
          markers: [
            { id: 'm1' as never, time: flicks(FRAME * 35), label: 'cue', color: 'blue' as const },
          ],
        },
      },
    };
    const firstVideoId = clipsOnTrack(withMarker, sequenceId, trackId)[0]?.id;
    if (!firstVideoId) throw new Error('missing clip');

    const result = rippleDelete(withMarker, { sequenceId, clipIds: [firstVideoId] }, { ids });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const videoClips = clipsOnTrack(result.value, sequenceId, trackId);
    expect(videoClips).toHaveLength(1);
    expect(videoClips[0]?.start).toBe(0);
    expect(clipsOnTrack(result.value, sequenceId, audioId)).toHaveLength(0);
    // Marker was at frame 35, 5 frames after the 30-frame removed range's end -> now at frame 5.
    expect(result.value.sequences[sequenceId]?.markers[0]?.time).toBe(FRAME * 5);
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('collapses a marker that sat inside the removed range to the cut point', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const clipId = clipsOnTrack(project, sequenceId, trackId)[0]?.id;
    if (!clipId) throw new Error('fixture missing clip');
    const sequence = project.sequences[sequenceId];
    if (!sequence) throw new Error('missing sequence');
    const withMarker: Project = {
      ...project,
      sequences: {
        ...project.sequences,
        [sequenceId]: {
          ...sequence,
          markers: [
            { id: 'm1' as never, time: flicks(FRAME * 15), label: 'cue', color: 'blue' as const },
          ],
        },
      },
    };

    const result = rippleDelete(withMarker, { sequenceId, clipIds: [clipId] }, { ids });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.sequences[sequenceId]?.markers[0]?.time).toBe(0);
  });
});

describe('closeGap', () => {
  it('closes an empty gap and shifts the linked partner on another track to match', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const audioId = audioTrackId(project, sequenceId);
    const assetId = Object.keys(project.assets)[0] as never;
    // Video clip 2 sits at [40, 50); leaves a 10-frame gap [30, 40) after clip 1.
    const withSecond = insertClips(
      project,
      {
        sequenceId,
        at: flicks(FRAME * 40),
        mode: 'overwrite',
        placements: [
          { type: 'video', trackId, assetId, sourceIn: flicks(0), duration: flicks(FRAME * 10) },
        ],
      },
      { ids },
    );
    expect(withSecond.ok).toBe(true);
    if (!withSecond.ok) return;

    const result = closeGap(
      withSecond.value,
      { sequenceId, trackId, at: flicks(FRAME * 35) },
      { ids },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const videoClips = clipsOnTrack(result.value, sequenceId, trackId);
    expect(videoClips[1]?.start).toBe(FRAME * 30);
    // Audio clip (linked to video clip 1, start 0) is untouched — the gap is after it.
    expect(clipsOnTrack(result.value, sequenceId, audioId)[0]?.start).toBe(0);
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('is a no-op past the last clip', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const result = closeGap(project, { sequenceId, trackId, at: flicks(FRAME * 999) }, { ids });
    expect(result.ok && result.value).toBe(project);
  });

  it('rejects a point inside an existing clip', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const result = closeGap(project, { sequenceId, trackId, at: flicks(FRAME * 5) }, { ids });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('VALIDATION');
  });
});

describe('rollEdit', () => {
  it('moves the cut between two adjacent clips', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const assetId = Object.keys(project.assets)[0] as never;
    const withSecond = insertClips(
      project,
      {
        sequenceId,
        at: flicks(FRAME * 30),
        mode: 'overwrite',
        placements: [
          { type: 'video', trackId, assetId, sourceIn: flicks(0), duration: flicks(FRAME * 10) },
        ],
      },
      { ids },
    );
    expect(withSecond.ok).toBe(true);
    if (!withSecond.ok) return;
    const [left, right] = clipsOnTrack(withSecond.value, sequenceId, trackId);
    if (!left || !right) throw new Error('expected two clips');

    const result = rollEdit(
      withSecond.value,
      { sequenceId, trackId, leftClipId: left.id, rightClipId: right.id, delta: flicks(FRAME * 3) },
      { ids },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clips = clipsOnTrack(result.value, sequenceId, trackId);
    expect(clips[0]?.duration).toBe(FRAME * 33);
    expect(clips[1]).toMatchObject({ start: FRAME * 33, sourceIn: FRAME * 3, duration: FRAME * 7 });
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('rejects non-adjacent clips', () => {
    const { ids, project, sequenceId } = setup();
    const trackId = videoTrackId(project, sequenceId);
    const assetId = Object.keys(project.assets)[0] as never;
    const withGap = insertClips(
      project,
      {
        sequenceId,
        at: flicks(FRAME * 40),
        mode: 'overwrite',
        placements: [
          { type: 'video', trackId, assetId, sourceIn: flicks(0), duration: flicks(FRAME * 10) },
        ],
      },
      { ids },
    );
    expect(withGap.ok).toBe(true);
    if (!withGap.ok) return;
    const [left, right] = clipsOnTrack(withGap.value, sequenceId, trackId);
    if (!left || !right) throw new Error('expected two clips');

    const result = rollEdit(
      withGap.value,
      { sequenceId, trackId, leftClipId: left.id, rightClipId: right.id, delta: flicks(FRAME) },
      { ids },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('VALIDATION');
  });
});

describe('property: random op sequences keep invariants (docs/ROADMAP.md Phase 4 gate)', () => {
  it('never leaves the project in an invalid state', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 15 }),
        fc.array(
          fc.record({
            kind: fc.constantFrom('trim', 'split', 'delete', 'rippleDelete', 'move'),
            clipIndex: fc.integer({ min: 0, max: 20 }),
            delta: fc.integer({ min: -FRAME * 10, max: FRAME * 10 }),
            edge: fc.constantFrom<'head' | 'tail'>('head', 'tail'),
            ripple: fc.boolean(),
          }),
          { maxLength: 20 },
        ),
        (clipCount, actions) => {
          const ids = createCounterIdGenerator();
          let project: Project = makeProjectWithClips(ids, clipCount);
          const sequenceId = project.sequenceOrder[0];
          if (!sequenceId) return;
          const trackId = videoTrackId(project, sequenceId);
          const ctx = { ids };

          for (const action of actions) {
            const clips = clipsOnTrack(project, sequenceId, trackId);
            if (clips.length === 0) break;
            const clip = clips[action.clipIndex % clips.length];
            if (!clip) continue;

            const result =
              action.kind === 'trim'
                ? trimClip(
                    project,
                    {
                      sequenceId,
                      clipId: clip.id,
                      edge: action.edge,
                      delta: flicks(action.delta),
                      ripple: action.ripple,
                    },
                    ctx,
                  )
                : action.kind === 'split'
                  ? splitClips(
                      project,
                      {
                        sequenceId,
                        at: flicks(clip.start + Math.abs(action.delta % clip.duration)),
                      },
                      ctx,
                    )
                  : action.kind === 'delete'
                    ? deleteClips(project, { sequenceId, clipIds: [clip.id] }, ctx)
                    : action.kind === 'rippleDelete'
                      ? rippleDelete(project, { sequenceId, clipIds: [clip.id] }, ctx)
                      : moveClips(
                          project,
                          {
                            sequenceId,
                            moves: [{ clipId: clip.id, toTrackId: trackId }],
                            deltaTime: flicks(action.delta),
                            mode: 'overwrite',
                          },
                          ctx,
                        );

            if (result.ok) {
              project = result.value;
              expect(checkInvariants(project)).toEqual([]);
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
