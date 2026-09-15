import { describe, expect, it } from 'vitest';
import { createCounterIdGenerator } from '../ids';
import { makeValidProject } from '../test-helpers';
import { renameProject } from './project';

const ctx = { ids: createCounterIdGenerator() };

describe('renameProject', () => {
  it('renames the project', () => {
    const project = makeValidProject();
    const result = renameProject(project, { name: 'New Name' }, ctx);
    expect(result).toEqual({ ok: true, value: { ...project, name: 'New Name' } });
  });

  it('trims the new name', () => {
    const project = makeValidProject();
    const result = renameProject(project, { name: '  Padded  ' }, ctx);
    expect(result.ok && result.value.name).toBe('Padded');
  });

  it('rejects an empty name', () => {
    const project = makeValidProject();
    const result = renameProject(project, { name: '   ' }, ctx);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('VALIDATION');
  });

  it('returns the same reference when the name does not change (no-op, no undo step)', () => {
    const project = makeValidProject();
    const result = renameProject(project, { name: project.name }, ctx);
    expect(result.ok && result.value).toBe(project);
  });
});
