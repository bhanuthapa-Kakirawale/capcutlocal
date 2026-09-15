import { produce } from 'immer';
import { z } from 'zod';
import { err, ok, type Result } from '../../lib/result';
import type { EditContext } from '../editContext';
import type { EditError } from '../editError';
import { newAssetId } from '../ids';
import { FingerprintSchema } from '../model/asset';
import { MediaInfoSchema } from '../model/media';
import type { Project } from '../model';

/** One successfully-imported file (docs/MEDIA-PIPELINE.md §2.1's `media_import` flow). */
export const NewAssetInputSchema = z.strictObject({
  kind: z.enum(['video', 'audio', 'image']),
  name: z.string().min(1),
  path: z.string().min(1),
  fingerprint: FingerprintSchema,
  info: MediaInfoSchema,
});
export type NewAssetInput = z.infer<typeof NewAssetInputSchema>;

export const AddAssetsArgsSchema = z.strictObject({ assets: z.array(NewAssetInputSchema) });
export type AddAssetsArgs = z.infer<typeof AddAssetsArgsSchema>;

/**
 * Adds one or more imported files as asset references, in one undo step
 * (docs/MEDIA-PIPELINE.md §2.1). Rust returns raw probe data; this op is where a new
 * `AssetId` is minted and the `Asset` record actually enters the document (ADR-002: Rust
 * never constructs project-schema objects itself).
 */
export function addAssets(
  project: Project,
  args: AddAssetsArgs,
  ctx: EditContext,
): Result<Project, EditError> {
  const parsed = AddAssetsArgsSchema.safeParse(args);
  if (!parsed.success) {
    return err({ code: 'VALIDATION', message: z.prettifyError(parsed.error) });
  }
  if (parsed.data.assets.length === 0) return ok(project);

  return ok(
    produce(project, (draft) => {
      for (const input of parsed.data.assets) {
        const id = newAssetId(ctx.ids);
        draft.assets[id] = {
          id,
          kind: input.kind,
          name: input.name,
          source: { path: input.path, relativePath: null, fingerprint: input.fingerprint },
          info: input.info,
        };
      }
    }),
  );
}
