import { z } from 'zod';
import { AssetIdSchema } from '../ids';
import { MediaInfoSchema } from './media';

/** Identity hint for relink and change detection (docs/PROJECT-MODEL.md §3.1). */
export const FingerprintSchema = z.strictObject({
  sizeBytes: z.number().int().nonnegative(),
  modifiedMs: z.number().int().nonnegative(),
  sampleHash: z.string().min(1),
});
export type Fingerprint = z.infer<typeof FingerprintSchema>;

/** A reference to media on disk, plus the metadata snapshot taken at import. */
export const AssetSchema = z.strictObject({
  id: AssetIdSchema,
  kind: z.enum(['video', 'audio', 'image']),
  name: z.string().min(1),
  source: z.strictObject({
    path: z.string().min(1),
    relativePath: z.string().min(1).nullable(),
    fingerprint: FingerprintSchema,
  }),
  info: MediaInfoSchema,
});
export type Asset = z.infer<typeof AssetSchema>;
