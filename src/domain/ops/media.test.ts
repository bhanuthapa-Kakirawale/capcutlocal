import { describe, expect, it } from 'vitest';
import { createCounterIdGenerator, type AssetId, type IdGenerator } from '../ids';
import { AssetSchema } from '../model';
import { makeMediaInfo, makeValidProject } from '../test-helpers';
import { flicks } from '../time';
import { addAssets, type NewAssetInput } from './media';

function input(overrides: Partial<NewAssetInput> = {}): NewAssetInput {
  return {
    kind: 'video',
    name: 'Clip',
    path: 'C:\\media\\clip.mp4',
    fingerprint: { sizeBytes: 1000, modifiedMs: 0, sampleHash: 'abc' },
    info: makeMediaInfo(flicks(705_600_000)),
    ...overrides,
  };
}

/** One shared id generator per test, so the fixture project and the op under test never
 * mint colliding ids (both would otherwise start counting from "id-0000"). */
function setup(): { ids: IdGenerator; project: ReturnType<typeof makeValidProject> } {
  const ids = createCounterIdGenerator();
  return { ids, project: makeValidProject(ids) };
}

describe('addAssets', () => {
  it('adds a new asset with a minted id', () => {
    const { ids, project } = setup();
    const result = addAssets(project, { assets: [input()] }, { ids });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const addedIds = (Object.keys(result.value.assets) as AssetId[]).filter(
      (id) => !(id in project.assets),
    );
    expect(addedIds).toHaveLength(1);
    const added = addedIds[0] ? result.value.assets[addedIds[0]] : undefined;
    expect(added).toBeDefined();
    expect(() => AssetSchema.parse(added)).not.toThrow();
    expect(added?.name).toBe('Clip');
  });

  it('adds several assets in one call', () => {
    const { ids, project } = setup();
    const result = addAssets(
      project,
      { assets: [input({ name: 'A' }), input({ name: 'B' })] },
      { ids },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.assets).length).toBe(Object.keys(project.assets).length + 2);
  });

  it('is a no-op for an empty batch (same reference, no dirty)', () => {
    const { ids, project } = setup();
    const result = addAssets(project, { assets: [] }, { ids });
    expect(result.ok && result.value).toBe(project);
  });

  it('rejects an invalid input shape', () => {
    const { ids, project } = setup();
    const result = addAssets(
      project,
      { assets: [{ ...input(), kind: 'not-a-kind' as never }] },
      { ids },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('VALIDATION');
  });

  it('never mutates the original project', () => {
    const { ids, project } = setup();
    const before = JSON.stringify(project);
    addAssets(project, { assets: [input()] }, { ids });
    expect(JSON.stringify(project)).toBe(before);
  });
});
