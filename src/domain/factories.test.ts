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
});
