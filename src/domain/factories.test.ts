import { describe, expect, it } from 'vitest';
import { createProject } from './factories';
import { createCounterIdGenerator } from './ids';
import { ProjectSchema } from './model';
import { SEQUENCE_FORMAT_PRESETS } from './model/sequence';

describe('createProject', () => {
  it('builds a project that satisfies ProjectSchema', () => {
    const project = createProject(createCounterIdGenerator(), {
      name: 'My Video',
      format: SEQUENCE_FORMAT_PRESETS.youtube1080p,
    });

    expect(() => ProjectSchema.parse(project)).not.toThrow();
    expect(project.sequenceOrder).toEqual([project.activeSequenceId]);
    expect(Object.keys(project.sequences)).toEqual([project.activeSequenceId]);
    expect(project.sequences[project.activeSequenceId]?.name).toBe('Sequence 1');
  });

  it('mints distinct ids for the project and its sequence', () => {
    const project = createProject(createCounterIdGenerator(), {
      name: 'X',
      format: SEQUENCE_FORMAT_PRESETS.shorts,
    });
    expect(project.id).not.toBe(project.activeSequenceId);
  });

  it('seeds one empty video track (V1) and one empty audio track (A1)', () => {
    const project = createProject(createCounterIdGenerator(), {
      name: 'X',
      format: SEQUENCE_FORMAT_PRESETS.youtube1080p,
    });
    const sequence = project.sequences[project.activeSequenceId];
    if (!sequence) throw new Error('expected a sequence');
    expect(sequence.videoTracks).toHaveLength(1);
    expect(sequence.audioTracks).toHaveLength(1);
    const videoTrackId = sequence.videoTracks[0];
    const audioTrackId = sequence.audioTracks[0];
    expect(videoTrackId ? sequence.tracks[videoTrackId] : undefined).toMatchObject({
      name: 'V1',
      kind: 'video',
      clips: [],
    });
    expect(audioTrackId ? sequence.tracks[audioTrackId] : undefined).toMatchObject({
      name: 'A1',
      kind: 'audio',
      clips: [],
    });
  });
});
