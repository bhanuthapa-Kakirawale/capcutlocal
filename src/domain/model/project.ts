import { z } from 'zod';
import { AssetIdSchema, ProjectIdSchema, SequenceIdSchema } from '../ids';
import { AssetSchema } from './asset';
import { SequenceFormatSchema, SequenceSchema } from './sequence';

/*
 * The project document (docs/PROJECT-MODEL.md §3) and the file envelope it is saved
 * inside (§5.1).
 */

export const ProjectSettingsSchema = z.strictObject({
  defaultSequenceFormat: SequenceFormatSchema,
  proxyPolicy: z.enum(['auto', 'always', 'never']),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const ProjectSchema = z.strictObject({
  id: ProjectIdSchema,
  name: z.string().min(1),
  createdAt: z.iso.datetime(),
  settings: ProjectSettingsSchema,
  assets: z.record(AssetIdSchema, AssetSchema),
  sequences: z.record(SequenceIdSchema, SequenceSchema),
  sequenceOrder: z.array(SequenceIdSchema),
  activeSequenceId: SequenceIdSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const PROJECT_FILE_FORMAT = 'kriti.project';
/** v2 (P4) added `Clip.enabled` and `Sequence.markers` — see the migration in serialization.ts. */
export const CURRENT_SCHEMA_VERSION = 2;

/** The on-disk `.kriti` file shape at the current schema version (docs/PROJECT-MODEL.md §5.1). */
export const ProjectFileSchema = z.strictObject({
  format: z.literal(PROJECT_FILE_FORMAT),
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  savedAt: z.iso.datetime(),
  savedBy: z.string().min(1),
  project: ProjectSchema,
});
export type ProjectFile = z.infer<typeof ProjectFileSchema>;
