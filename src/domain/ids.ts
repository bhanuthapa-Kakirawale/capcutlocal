import { z } from 'zod';

/*
 * Branded entity identifiers (docs/PROJECT-MODEL.md §2). Branding keeps, for example, a
 * TrackId from being passed where a ClipId is expected, while the runtime value is a
 * plain non-empty string. Each schema is also how these ids are validated on load.
 */

export const ProjectIdSchema = z.string().min(1).brand<'ProjectId'>();
export type ProjectId = z.infer<typeof ProjectIdSchema>;

export const AssetIdSchema = z.string().min(1).brand<'AssetId'>();
export type AssetId = z.infer<typeof AssetIdSchema>;

export const SequenceIdSchema = z.string().min(1).brand<'SequenceId'>();
export type SequenceId = z.infer<typeof SequenceIdSchema>;

export const TrackIdSchema = z.string().min(1).brand<'TrackId'>();
export type TrackId = z.infer<typeof TrackIdSchema>;

export const ClipIdSchema = z.string().min(1).brand<'ClipId'>();
export type ClipId = z.infer<typeof ClipIdSchema>;

export const LinkIdSchema = z.string().min(1).brand<'LinkId'>();
export type LinkId = z.infer<typeof LinkIdSchema>;

export const MarkerIdSchema = z.string().min(1).brand<'MarkerId'>();
export type MarkerId = z.infer<typeof MarkerIdSchema>;

/**
 * Mints raw id strings. Production uses `crypto.randomUUID()`; tests use a deterministic
 * counter so fixtures and snapshots are stable (docs/PROJECT-MODEL.md §2).
 */
export type IdGenerator = { next(): string };

export const randomIdGenerator: IdGenerator = { next: () => crypto.randomUUID() };

/** An id generator that produces `<prefix>-0000`, `<prefix>-0001`, … in order. */
export function createCounterIdGenerator(prefix = 'id'): IdGenerator {
  let counter = 0;
  return {
    next: () => {
      const id = `${prefix}-${counter.toString().padStart(4, '0')}`;
      counter += 1;
      return id;
    },
  };
}

export function newProjectId(ids: IdGenerator): ProjectId {
  return ids.next() as ProjectId;
}
export function newAssetId(ids: IdGenerator): AssetId {
  return ids.next() as AssetId;
}
export function newSequenceId(ids: IdGenerator): SequenceId {
  return ids.next() as SequenceId;
}
export function newTrackId(ids: IdGenerator): TrackId {
  return ids.next() as TrackId;
}
export function newClipId(ids: IdGenerator): ClipId {
  return ids.next() as ClipId;
}
export function newLinkId(ids: IdGenerator): LinkId {
  return ids.next() as LinkId;
}
export function newMarkerId(ids: IdGenerator): MarkerId {
  return ids.next() as MarkerId;
}
