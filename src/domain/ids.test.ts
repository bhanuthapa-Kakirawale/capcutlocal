import { describe, expect, it } from 'vitest';
import {
  AssetIdSchema,
  createCounterIdGenerator,
  newAssetId,
  newClipId,
  randomIdGenerator,
} from './ids';

describe('createCounterIdGenerator', () => {
  it('produces distinct, ordered, zero-padded ids', () => {
    const ids = createCounterIdGenerator('clip');
    expect(ids.next()).toBe('clip-0000');
    expect(ids.next()).toBe('clip-0001');
    expect(ids.next()).toBe('clip-0002');
  });

  it('is independent per instance', () => {
    const a = createCounterIdGenerator();
    const b = createCounterIdGenerator();
    a.next();
    expect(b.next()).toBe('id-0000');
  });
});

describe('randomIdGenerator', () => {
  it('produces ids that pass the id schemas', () => {
    expect(() => AssetIdSchema.parse(randomIdGenerator.next())).not.toThrow();
  });

  it('never repeats across many calls', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => randomIdGenerator.next()));
    expect(seen.size).toBe(1000);
  });
});

describe('typed constructors', () => {
  it('brand ids so different kinds are not interchangeable at the type level', () => {
    const ids = createCounterIdGenerator();
    const assetId = newAssetId(ids);
    const clipId = newClipId(ids);
    expect(assetId).not.toBe(clipId);
    expect(AssetIdSchema.safeParse(assetId).success).toBe(true);
  });
});
