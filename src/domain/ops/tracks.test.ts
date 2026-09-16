import { describe, expect, it } from 'vitest';
import { checkInvariants } from '../invariants';
import type { IdGenerator } from '../ids';
import { createCounterIdGenerator, type SequenceId, type TrackId } from '../ids';
import type { Sequence } from '../model';
import { makeValidProject } from '../test-helpers';
import { addTrack, removeTrack, reorderTrack, setTrackFlags } from './tracks';

function setup(): { ids: IdGenerator; project: ReturnType<typeof makeValidProject> } {
  const ids = createCounterIdGenerator();
  return { ids, project: makeValidProject(ids) };
}

function firstSequenceId(project: ReturnType<typeof makeValidProject>): SequenceId {
  const id = project.sequenceOrder[0];
  if (!id) throw new Error('fixture has no sequence');
  return id;
}

function getSequence(
  project: ReturnType<typeof makeValidProject>,
  sequenceId: SequenceId,
): Sequence {
  const sequence = project.sequences[sequenceId];
  if (!sequence) throw new Error('fixture has no such sequence');
  return sequence;
}

describe('addTrack', () => {
  it('appends a new video track to videoTracks', () => {
    const { ids, project } = setup();
    const sequenceId = firstSequenceId(project);
    const result = addTrack(project, { sequenceId, kind: 'video' }, { ids });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sequence = getSequence(result.value, sequenceId);
    expect(sequence.videoTracks).toHaveLength(2);
    const newId = sequence.videoTracks[1];
    const track = newId ? sequence.tracks[newId] : undefined;
    expect(track).toMatchObject({ kind: 'video', hidden: false, locked: false, clips: [] });
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('appends a new audio track to audioTracks with a default name', () => {
    const { ids, project } = setup();
    const sequenceId = firstSequenceId(project);
    const result = addTrack(project, { sequenceId, kind: 'audio' }, { ids });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sequence = getSequence(result.value, sequenceId);
    expect(sequence.audioTracks).toHaveLength(2);
    const newId = sequence.audioTracks[1];
    const track = newId ? sequence.tracks[newId] : undefined;
    expect(track?.name).toBe('A2');
    expect(track).toMatchObject({ kind: 'audio', muted: false, locked: false, clips: [] });
  });

  it('honors a custom name', () => {
    const { ids, project } = setup();
    const sequenceId = firstSequenceId(project);
    const result = addTrack(project, { sequenceId, kind: 'video', name: 'B-roll' }, { ids });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sequence = getSequence(result.value, sequenceId);
    const newId = sequence.videoTracks[1];
    expect(newId ? sequence.tracks[newId]?.name : undefined).toBe('B-roll');
  });

  it('rejects an unknown sequence', () => {
    const { ids, project } = setup();
    const result = addTrack(
      project,
      { sequenceId: 'missing' as SequenceId, kind: 'video' },
      { ids },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('NOT_FOUND');
  });

  it('never mutates the original project', () => {
    const { ids, project } = setup();
    const before = JSON.stringify(project);
    addTrack(project, { sequenceId: firstSequenceId(project), kind: 'video' }, { ids });
    expect(JSON.stringify(project)).toBe(before);
  });
});

describe('removeTrack', () => {
  it('rejects removing a non-empty track without force', () => {
    const { ids, project } = setup();
    const sequenceId = firstSequenceId(project);
    const sequence = project.sequences[sequenceId];
    const videoTrackId = sequence?.videoTracks[0];
    if (!videoTrackId) throw new Error('fixture has no video track');

    const result = removeTrack(project, { sequenceId, trackId: videoTrackId }, { ids });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('TRACK_NOT_EMPTY');
  });

  it('removes an empty track', () => {
    const { ids, project } = setup();
    const sequenceId = firstSequenceId(project);
    const added = addTrack(project, { sequenceId, kind: 'video' }, { ids });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const newTrackId = added.value.sequences[sequenceId]?.videoTracks[1];
    if (!newTrackId) throw new Error('expected a newly added track');

    const result = removeTrack(added.value, { sequenceId, trackId: newTrackId }, { ids });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sequences[sequenceId]?.videoTracks).toEqual(
      added.value.sequences[sequenceId]?.videoTracks.filter((id) => id !== newTrackId),
    );
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('removes a non-empty track with force and dissolves the orphaned link', () => {
    const { ids, project } = setup();
    const sequenceId = firstSequenceId(project);
    const sequence = project.sequences[sequenceId];
    const videoTrackId = sequence?.videoTracks[0];
    const audioTrackId = sequence?.audioTracks[0];
    if (!videoTrackId || !audioTrackId) throw new Error('fixture missing tracks');

    const result = removeTrack(
      project,
      { sequenceId, trackId: videoTrackId, force: true },
      { ids },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const resultSequence = result.value.sequences[sequenceId];
    expect(resultSequence?.tracks[videoTrackId]).toBeUndefined();
    expect(resultSequence?.videoTracks).toEqual([]);
    const audioClip = resultSequence?.tracks[audioTrackId]?.clips[0];
    expect(audioClip?.linkId).toBeNull();
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('rejects an unknown track', () => {
    const { ids, project } = setup();
    const result = removeTrack(
      project,
      { sequenceId: firstSequenceId(project), trackId: 'missing' as TrackId },
      { ids },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('NOT_FOUND');
  });
});

describe('reorderTrack', () => {
  it('moves a track to a new index within its own kind', () => {
    const { ids, project } = setup();
    const sequenceId = firstSequenceId(project);
    const added = addTrack(project, { sequenceId, kind: 'video' }, { ids });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const sequence = added.value.sequences[sequenceId];
    const [firstId, secondId] = sequence?.videoTracks ?? [];
    if (!firstId || !secondId) throw new Error('expected two video tracks');

    const result = reorderTrack(
      added.value,
      { sequenceId, trackId: secondId, toIndex: 0 },
      { ids },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sequences[sequenceId]?.videoTracks).toEqual([secondId, firstId]);
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('clamps an out-of-range index to the end', () => {
    const { ids, project } = setup();
    const sequenceId = firstSequenceId(project);
    const added = addTrack(project, { sequenceId, kind: 'video' }, { ids });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const sequence = added.value.sequences[sequenceId];
    const [firstId, secondId] = sequence?.videoTracks ?? [];
    if (!firstId || !secondId) throw new Error('expected two video tracks');

    const result = reorderTrack(
      added.value,
      { sequenceId, trackId: firstId, toIndex: 99 },
      { ids },
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.sequences[sequenceId]?.videoTracks).toEqual([
      secondId,
      firstId,
    ]);
  });

  it('is a no-op when already at the target index (same reference)', () => {
    const { ids, project } = setup();
    const sequenceId = firstSequenceId(project);
    const trackId = project.sequences[sequenceId]?.videoTracks[0];
    if (!trackId) throw new Error('fixture has no video track');
    const result = reorderTrack(project, { sequenceId, trackId, toIndex: 0 }, { ids });
    expect(result.ok && result.value).toBe(project);
  });

  it('rejects an unknown track', () => {
    const { ids, project } = setup();
    const result = reorderTrack(
      project,
      { sequenceId: firstSequenceId(project), trackId: 'missing' as TrackId, toIndex: 0 },
      { ids },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('NOT_FOUND');
  });
});

describe('setTrackFlags', () => {
  it('sets locked on any track kind', () => {
    const { ids, project } = setup();
    const sequenceId = firstSequenceId(project);
    const trackId = project.sequences[sequenceId]?.videoTracks[0];
    if (!trackId) throw new Error('fixture has no video track');
    const result = setTrackFlags(project, { sequenceId, trackId, locked: true }, { ids });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.sequences[sequenceId]?.tracks[trackId]?.locked).toBe(true);
  });

  it('sets hidden on a video track', () => {
    const { ids, project } = setup();
    const sequenceId = firstSequenceId(project);
    const trackId = project.sequences[sequenceId]?.videoTracks[0];
    if (!trackId) throw new Error('fixture has no video track');
    const result = setTrackFlags(project, { sequenceId, trackId, hidden: true }, { ids });
    expect(result.ok).toBe(true);
    const track = result.ok ? result.value.sequences[sequenceId]?.tracks[trackId] : undefined;
    expect(track?.kind === 'video' && track.hidden).toBe(true);
  });

  it('sets muted on an audio track', () => {
    const { ids, project } = setup();
    const sequenceId = firstSequenceId(project);
    const trackId = project.sequences[sequenceId]?.audioTracks[0];
    if (!trackId) throw new Error('fixture has no audio track');
    const result = setTrackFlags(project, { sequenceId, trackId, muted: true }, { ids });
    expect(result.ok).toBe(true);
    const track = result.ok ? result.value.sequences[sequenceId]?.tracks[trackId] : undefined;
    expect(track?.kind === 'audio' && track.muted).toBe(true);
  });

  it('rejects `hidden` on an audio track', () => {
    const { ids, project } = setup();
    const sequenceId = firstSequenceId(project);
    const trackId = project.sequences[sequenceId]?.audioTracks[0];
    if (!trackId) throw new Error('fixture has no audio track');
    const result = setTrackFlags(project, { sequenceId, trackId, hidden: true }, { ids });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('VALIDATION');
  });

  it('rejects `muted` on a video track', () => {
    const { ids, project } = setup();
    const sequenceId = firstSequenceId(project);
    const trackId = project.sequences[sequenceId]?.videoTracks[0];
    if (!trackId) throw new Error('fixture has no video track');
    const result = setTrackFlags(project, { sequenceId, trackId, muted: true }, { ids });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('VALIDATION');
  });

  it('is a no-op when the value does not change (same reference)', () => {
    const { ids, project } = setup();
    const sequenceId = firstSequenceId(project);
    const trackId = project.sequences[sequenceId]?.videoTracks[0];
    if (!trackId) throw new Error('fixture has no video track');
    const result = setTrackFlags(project, { sequenceId, trackId, locked: false }, { ids });
    expect(result.ok && result.value).toBe(project);
  });

  it('rejects an unknown track', () => {
    const { ids, project } = setup();
    const result = setTrackFlags(
      project,
      { sequenceId: firstSequenceId(project), trackId: 'missing' as TrackId, locked: true },
      { ids },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('NOT_FOUND');
  });
});
