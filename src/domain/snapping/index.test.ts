import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createCounterIdGenerator } from '../ids';
import { makeValidProject } from '../test-helpers';
import { flicks, flicksPerFrame } from '../time';
import { collectSnapTargets, snap } from './index';

const FRAME = flicksPerFrame({ num: 30, den: 1 });

function setup() {
  const ids = createCounterIdGenerator();
  const project = makeValidProject(ids);
  const sequenceId = project.sequenceOrder[0];
  if (!sequenceId) throw new Error('fixture has no sequence');
  const sequence = project.sequences[sequenceId];
  if (!sequence) throw new Error('fixture has no sequence');
  return { sequence };
}

describe('collectSnapTargets', () => {
  it('includes sequence start, clip edges and markers, sorted and deduplicated', () => {
    const { sequence } = setup();
    // Fixture: one video clip [0, 30 frames), one audio clip [0, 30 frames), same edges.
    const targets = collectSnapTargets({
      ...sequence,
      markers: [{ id: 'm1' as never, time: flicks(FRAME * 15), label: 'x', color: 'blue' }],
    });
    expect(targets).toEqual([0, FRAME * 15, FRAME * 30]);
  });

  it('excludes edges of clips being dragged', () => {
    const { sequence } = setup();
    const videoClipId = Object.values(sequence.tracks).find((t) => t.kind === 'video')?.clips[0]
      ?.id;
    if (!videoClipId) throw new Error('expected a video clip');
    const targets = collectSnapTargets(sequence, { excludeClipIds: new Set([videoClipId]) });
    // Only the audio clip's edges (identical: 0 and 30 frames) remain, plus sequence start.
    expect(targets).toEqual([0, FRAME * 30]);
  });

  it('includes the playhead when provided', () => {
    const { sequence } = setup();
    const targets = collectSnapTargets(sequence, { playhead: FRAME * 12 });
    expect(targets).toContain(FRAME * 12);
  });
});

describe('snap', () => {
  it('snaps an edge to the nearest target within threshold', () => {
    const targets = [0, FRAME * 10, FRAME * 30];
    const result = snap([{ id: 'a', time: FRAME * 9 }], targets, FRAME * 2);
    expect(result).toEqual({ edgeId: 'a', target: FRAME * 10, delta: FRAME });
  });

  it('returns null when nothing is within threshold', () => {
    const targets = [0, FRAME * 30];
    const result = snap([{ id: 'a', time: FRAME * 15 }], targets, FRAME);
    expect(result).toBeNull();
  });

  it('picks the closest edge across multiple dragged edges', () => {
    const targets = [0, FRAME * 10];
    const result = snap(
      [
        { id: 'far', time: FRAME * 8 },
        { id: 'near', time: FRAME * 9.5 },
      ],
      targets,
      FRAME * 3,
    );
    expect(result?.edgeId).toBe('near');
  });

  it('returns null for an empty target list', () => {
    expect(snap([{ id: 'a', time: 0 }], [], FRAME)).toBeNull();
  });

  it('never returns a target farther than any actual target (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 50 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        (rawTargets, edgeTime, threshold) => {
          const targets = [...new Set(rawTargets)].sort((a, b) => a - b);
          const result = snap([{ id: 'e', time: edgeTime }], targets, threshold);
          if (result === null) return;
          expect(Math.abs(result.delta)).toBeLessThanOrEqual(threshold);
          const actualNearestDistance = Math.min(...targets.map((t) => Math.abs(t - edgeTime)));
          expect(Math.abs(result.delta)).toBe(actualNearestDistance);
        },
      ),
    );
  });
});
