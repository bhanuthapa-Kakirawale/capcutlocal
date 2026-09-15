import { produce } from 'immer';
import { z } from 'zod';
import { err, ok, type Result } from '../../lib/result';
import type { EditContext } from '../editContext';
import type { EditError } from '../editError';
import type { Project } from '../model';

export const RenameProjectArgsSchema = z.strictObject({ name: z.string().trim().min(1).max(200) });
export type RenameProjectArgs = z.infer<typeof RenameProjectArgsSchema>;

/**
 * Renames the project. Renaming to its current name is a no-op: Immer's `produce`
 * returns the same object reference when nothing actually changed, so it neither marks
 * the project dirty nor creates an undo step (docs/PROJECT-MODEL.md §7.4).
 */
export function renameProject(
  project: Project,
  args: RenameProjectArgs,
  _ctx: EditContext,
): Result<Project, EditError> {
  const parsed = RenameProjectArgsSchema.safeParse(args);
  if (!parsed.success) {
    return err({ code: 'VALIDATION', message: z.prettifyError(parsed.error) });
  }
  return ok(
    produce(project, (draft) => {
      draft.name = parsed.data.name;
    }),
  );
}
