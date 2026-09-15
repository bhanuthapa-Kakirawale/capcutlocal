import type { Result } from '../lib/result';
import type { EditError } from './editError';
import type { IdGenerator } from './ids';
import type { Project } from './model';

/** Passed to every edit op (docs/TIMELINE.md §5). */
export type EditContext = { ids: IdGenerator };

/** An edit op: a pure function from the current document to the next one, or an error. */
export type EditOp<A> = (project: Project, args: A, ctx: EditContext) => Result<Project, EditError>;
