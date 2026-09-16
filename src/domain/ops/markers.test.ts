import { describe, expect, it } from 'vitest';
import { checkInvariants } from '../invariants';
import { createCounterIdGenerator, type IdGenerator, type MarkerId, type SequenceId } from '../ids';
import { makeValidProject } from '../test-helpers';
import { flicks, flicksPerFrame } from '../time';
import { addMarker, removeMarker, updateMarker } from './markers';

const FRAME = flicksPerFrame({ num: 30, den: 1 });

function setup(): {
  ids: IdGenerator;
  project: ReturnType<typeof makeValidProject>;
  sequenceId: SequenceId;
} {
  const ids = createCounterIdGenerator();
  const project = makeValidProject(ids);
  const sequenceId = project.sequenceOrder[0];
  if (!sequenceId) throw new Error('fixture has no sequence');
  return { ids, project, sequenceId };
}

describe('addMarker', () => {
  it('adds a marker with a minted id', () => {
    const { ids, project, sequenceId } = setup();
    const result = addMarker(
      project,
      { sequenceId, time: flicks(FRAME * 10), label: 'Intro', color: 'red' },
      { ids },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const markers = result.value.sequences[sequenceId]?.markers ?? [];
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ time: FRAME * 10, label: 'Intro', color: 'red' });
    expect(checkInvariants(result.value)).toEqual([]);
  });

  it('keeps markers sorted by time regardless of insertion order', () => {
    const { ids, project, sequenceId } = setup();
    const first = addMarker(
      project,
      { sequenceId, time: flicks(FRAME * 20), label: 'B', color: 'blue' },
      { ids },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = addMarker(
      first.value,
      { sequenceId, time: flicks(FRAME * 5), label: 'A', color: 'green' },
      { ids },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.sequences[sequenceId]?.markers.map((m) => m.label)).toEqual(['A', 'B']);
  });

  it('rounds time to the frame grid', () => {
    const { ids, project, sequenceId } = setup();
    const result = addMarker(
      project,
      { sequenceId, time: flicks(FRAME * 10 + 1), label: 'M', color: 'blue' },
      { ids },
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.sequences[sequenceId]?.markers[0]?.time).toBe(FRAME * 10);
  });

  it('rejects an unknown sequence', () => {
    const { ids, project } = setup();
    const result = addMarker(
      project,
      { sequenceId: 'missing' as SequenceId, time: flicks(0), label: 'M', color: 'blue' },
      { ids },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('NOT_FOUND');
  });

  it('rejects an empty label', () => {
    const { ids, project, sequenceId } = setup();
    const result = addMarker(
      project,
      { sequenceId, time: flicks(0), label: '   ', color: 'blue' },
      { ids },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('VALIDATION');
  });

  it('never mutates the original project', () => {
    const { ids, project, sequenceId } = setup();
    const before = JSON.stringify(project);
    addMarker(project, { sequenceId, time: flicks(0), label: 'M', color: 'blue' }, { ids });
    expect(JSON.stringify(project)).toBe(before);
  });
});

describe('removeMarker', () => {
  it('removes an existing marker', () => {
    const { ids, project, sequenceId } = setup();
    const added = addMarker(
      project,
      { sequenceId, time: flicks(0), label: 'M', color: 'blue' },
      { ids },
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const markerId = added.value.sequences[sequenceId]?.markers[0]?.id;
    if (!markerId) throw new Error('expected a marker');

    const result = removeMarker(added.value, { sequenceId, markerId }, { ids });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.sequences[sequenceId]?.markers).toEqual([]);
  });

  it('rejects an unknown marker', () => {
    const { ids, project, sequenceId } = setup();
    const result = removeMarker(project, { sequenceId, markerId: 'missing' as MarkerId }, { ids });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('NOT_FOUND');
  });
});

describe('updateMarker', () => {
  it('updates label and color without touching time', () => {
    const { ids, project, sequenceId } = setup();
    const added = addMarker(
      project,
      { sequenceId, time: flicks(FRAME * 10), label: 'M', color: 'blue' },
      { ids },
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const markerId = added.value.sequences[sequenceId]?.markers[0]?.id;
    if (!markerId) throw new Error('expected a marker');

    const result = updateMarker(
      added.value,
      { sequenceId, markerId, label: 'Renamed', color: 'purple' },
      { ids },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sequences[sequenceId]?.markers[0]).toMatchObject({
      label: 'Renamed',
      color: 'purple',
      time: FRAME * 10,
    });
  });

  it('re-sorts when time changes past another marker', () => {
    const { ids, project, sequenceId } = setup();
    const first = addMarker(
      project,
      { sequenceId, time: flicks(FRAME * 5), label: 'A', color: 'blue' },
      { ids },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = addMarker(
      first.value,
      { sequenceId, time: flicks(FRAME * 10), label: 'B', color: 'blue' },
      { ids },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const markerAId = second.value.sequences[sequenceId]?.markers.find((m) => m.label === 'A')?.id;
    if (!markerAId) throw new Error('expected marker A');

    const result = updateMarker(
      second.value,
      { sequenceId, markerId: markerAId, time: flicks(FRAME * 20) },
      { ids },
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.sequences[sequenceId]?.markers.map((m) => m.label)).toEqual([
      'B',
      'A',
    ]);
  });

  it('is a no-op when nothing changes (same reference)', () => {
    const { ids, project, sequenceId } = setup();
    const added = addMarker(
      project,
      { sequenceId, time: flicks(FRAME * 10), label: 'M', color: 'blue' },
      { ids },
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const markerId = added.value.sequences[sequenceId]?.markers[0]?.id;
    if (!markerId) throw new Error('expected a marker');

    const result = updateMarker(added.value, { sequenceId, markerId, label: 'M' }, { ids });
    expect(result.ok && result.value).toBe(added.value);
  });

  it('rejects an unknown marker', () => {
    const { ids, project, sequenceId } = setup();
    const result = updateMarker(
      project,
      { sequenceId, markerId: 'missing' as MarkerId, label: 'X' },
      { ids },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('NOT_FOUND');
  });
});
