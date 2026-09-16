import fc from 'fast-check';
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createCounterIdGenerator } from './ids';
import { CURRENT_SCHEMA_VERSION } from './model';
import { describeLoadError, loadProjectFromText, serializeProject } from './serialization';
import { makeProjectWithClips, makeValidProject } from './test-helpers';

describe('serializeProject + loadProjectFromText', () => {
  it('round-trips a valid project exactly', () => {
    const project = makeValidProject();
    const serialized = serializeProject(project, 'Kriti 0.1.0');
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;

    const loaded = loadProjectFromText(serialized.value);
    expect(loaded).toEqual({ ok: true, value: project });
  });

  it('writes 2-space-indented JSON ending in a newline', () => {
    const serialized = serializeProject(makeValidProject(), 'Kriti 0.1.0');
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(serialized.value.endsWith('\n')).toBe(true);
    expect(serialized.value).toContain('\n  "format"');
  });

  it('refuses to serialize a project that violates invariants', () => {
    const broken = produce(makeValidProject(), (draft) => {
      const sequence = draft.sequences[draft.activeSequenceId];
      const track = sequence ? Object.values(sequence.tracks)[0] : undefined;
      const clip = track?.clips[0];
      if (clip) clip.duration = 0 as never;
    });
    const result = serializeProject(broken, 'Kriti 0.1.0');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('invariant');
  });

  it('round-trips for randomly-sized synthetic projects', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200 }), (clipCount) => {
        const project = makeProjectWithClips(createCounterIdGenerator(), clipCount);
        const serialized = serializeProject(project, 'Kriti 0.1.0');
        expect(serialized.ok).toBe(true);
        if (!serialized.ok) return;
        expect(loadProjectFromText(serialized.value)).toEqual({ ok: true, value: project });
      }),
      { numRuns: 25 },
    );
  });
});

describe('loadProjectFromText error handling', () => {
  it('reports invalid JSON', () => {
    const result = loadProjectFromText('{ not json');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('parse');
  });

  it('rejects a file that is not a Kriti project', () => {
    const result = loadProjectFromText(
      JSON.stringify({ format: 'something.else', schemaVersion: 1 }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('envelope');
  });

  it('refuses a newer schema version without attempting to load it', () => {
    const result = loadProjectFromText(
      JSON.stringify({
        format: 'kriti.project',
        schemaVersion: 999,
        savedAt: new Date().toISOString(),
        savedBy: 'Kriti 9.9.9',
        project: {},
      }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toEqual({
      kind: 'unsupported-version',
      fileVersion: 999,
      supportedVersion: CURRENT_SCHEMA_VERSION,
    });
  });

  it('migrates a v1 project file (no enabled/markers) to the current schema', () => {
    const v1Project = JSON.parse(JSON.stringify(makeValidProject())) as {
      sequences: Record<string, { tracks: Record<string, { clips: { enabled?: boolean }[] }> }>;
    };
    // Simulate a real v1 file: strip the fields v2 added.
    const sequence = Object.values(v1Project.sequences)[0];
    for (const track of Object.values(sequence?.tracks ?? {})) {
      for (const clip of track.clips) delete clip.enabled;
    }
    delete (sequence as { markers?: unknown[] }).markers;

    const result = loadProjectFromText(
      JSON.stringify({
        format: 'kriti.project',
        schemaVersion: 1,
        savedAt: new Date().toISOString(),
        savedBy: 'Kriti 0.1.0',
        project: v1Project,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const loadedSequence = Object.values(result.value.sequences)[0];
    expect(loadedSequence?.markers).toEqual([]);
    const loadedTrack = Object.values(loadedSequence?.tracks ?? {})[0];
    expect(loadedTrack?.clips[0]?.enabled).toBe(true);
  });

  it('rejects a project payload that does not match the schema', () => {
    const serialized = serializeProject(makeValidProject(), 'Kriti 0.1.0');
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const envelope: { project: Record<string, unknown> } = JSON.parse(serialized.value) as never;
    delete envelope.project.name;

    const result = loadProjectFromText(JSON.stringify(envelope));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('schema');
  });

  it('rejects a schema-valid project that violates invariants', () => {
    const serialized = serializeProject(makeValidProject(), 'Kriti 0.1.0');
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const envelope: {
      project: {
        sequences: Record<string, { tracks: Record<string, { clips: { duration: number }[] }> }>;
      };
    } = JSON.parse(serialized.value) as never;
    const sequence = Object.values(envelope.project.sequences)[0];
    const track = sequence ? Object.values(sequence.tracks)[0] : undefined;
    const clip = track?.clips[0];
    if (clip) clip.duration = 0;

    const result = loadProjectFromText(JSON.stringify(envelope));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('invariant');
  });

  it('produces a non-empty human message for every error kind', () => {
    expect(describeLoadError({ kind: 'parse', message: 'x' })).not.toBe('');
    expect(describeLoadError({ kind: 'envelope', message: 'x' })).not.toBe('');
    expect(
      describeLoadError({ kind: 'unsupported-version', fileVersion: 2, supportedVersion: 1 }),
    ).not.toBe('');
    expect(describeLoadError({ kind: 'schema', message: 'x' })).not.toBe('');
    expect(describeLoadError({ kind: 'invariant', violations: [] })).not.toBe('');
  });
});

describe('performance gate (docs/ROADMAP.md Phase 2)', () => {
  it('saves and loads a 5,000-clip project in under 200ms', () => {
    const project = makeProjectWithClips(createCounterIdGenerator(), 5000);

    const start = performance.now();
    const serialized = serializeProject(project, 'Kriti 0.1.0');
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const loaded = loadProjectFromText(serialized.value);
    const elapsedMs = performance.now() - start;

    expect(loaded.ok).toBe(true);
    expect(elapsedMs).toBeLessThan(200);
  });
});
