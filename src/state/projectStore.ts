import { create } from 'zustand';
import { createProject } from '../domain/factories';
import type { EditContext, EditOp } from '../domain/editContext';
import type { EditError } from '../domain/editError';
import { randomIdGenerator, type IdGenerator } from '../domain/ids';
import type { Project } from '../domain/model';
import { SEQUENCE_FORMAT_PRESETS } from '../domain/model/sequence';
import type { Result } from '../lib/result';

/*
 * The document store: undo/redo history, transactions for continuous interactions, and
 * dirty tracking (docs/PROJECT-MODEL.md §7). This is the only place edit ops are
 * dispatched — components never call an op directly.
 */

export type HistoryEntry = { project: Project; label: string };
export type History = { past: HistoryEntry[]; present: Project; future: HistoryEntry[] };

/** Memory stays bounded regardless of session length; entries share structure via Immer. */
export const MAX_HISTORY_ENTRIES = 200;

type Transaction = { label: string; before: Project };

export type ProjectStoreState = {
  history: History;
  /** Bumped on every change to `present`, including transient transaction updates.
   * Rust tags rendered frames with the revision used, so stale frames can be dropped. */
  revision: number;
  /** The project object last written to disk; null if this project has never been saved. */
  savedProject: Project | null;
  transaction: Transaction | null;
  ids: IdGenerator;
};

export type ProjectStoreActions = {
  /** Runs `op`, committing one history entry labeled `label` if it changes the document. */
  dispatch<A>(op: EditOp<A>, args: A, label: string): Result<Project, EditError>;
  undo(): void;
  redo(): void;
  /** Starts a transaction for a continuous interaction (drag, scrub). Auto-commits any open one. */
  beginTransaction(label: string): void;
  /** Applies `op` to the live document without pushing a history entry yet. */
  updateTransaction<A>(op: EditOp<A>, args: A): Result<Project, EditError>;
  /** Pushes one history entry for the whole transaction, or none if nothing changed. */
  commitTransaction(): void;
  /** Restores the document to how it was before the transaction began. */
  cancelTransaction(): void;
  /** Marks the given (already-saved) project reference as the clean state. */
  markSaved(savedProject: Project): void;
  /** Resets history for a brand-new, unsaved project (always dirty). */
  startNewProject(project: Project): void;
  /** Resets history for a project just read from disk (clean: savedProject = project). */
  openProject(project: Project): void;
};

export type ProjectStore = ProjectStoreState & ProjectStoreActions;

function freshHistory(project: Project): History {
  return { past: [], present: project, future: [] };
}

export function createProjectStore(initialProject: Project, ids: IdGenerator = randomIdGenerator) {
  return create<ProjectStore>()((set, get) => {
    function runOp<A>(op: EditOp<A>, args: A): Result<Project, EditError> {
      const state = get();
      const ctx: EditContext = { ids: state.ids };
      return op(state.history.present, args, ctx);
    }

    return {
      history: freshHistory(initialProject),
      revision: 0,
      savedProject: null,
      transaction: null,
      ids,

      dispatch: (op, args, label) => {
        const state = get();
        const result = runOp(op, args);
        if (result.ok && result.value !== state.history.present) {
          const past = [...state.history.past, { project: state.history.present, label }].slice(
            -MAX_HISTORY_ENTRIES,
          );
          set({
            history: { past, present: result.value, future: [] },
            revision: state.revision + 1,
          });
        }
        return result;
      },

      undo: () => {
        const state = get();
        const entry = state.history.past.at(-1);
        if (!entry) return;
        const past = state.history.past.slice(0, -1);
        const future: HistoryEntry[] = [
          { project: state.history.present, label: entry.label },
          ...state.history.future,
        ];
        set({ history: { past, present: entry.project, future }, revision: state.revision + 1 });
      },

      redo: () => {
        const state = get();
        const entry = state.history.future[0];
        if (!entry) return;
        const future = state.history.future.slice(1);
        const past = [
          ...state.history.past,
          { project: state.history.present, label: entry.label },
        ];
        set({ history: { past, present: entry.project, future }, revision: state.revision + 1 });
      },

      beginTransaction: (label) => {
        if (get().transaction) get().commitTransaction();
        set({ transaction: { label, before: get().history.present } });
      },

      updateTransaction: (op, args) => {
        const state = get();
        if (!state.transaction) {
          throw new Error('updateTransaction called with no open transaction');
        }
        const result = runOp(op, args);
        if (result.ok && result.value !== state.history.present) {
          set({
            history: { ...state.history, present: result.value },
            revision: state.revision + 1,
          });
        }
        return result;
      },

      commitTransaction: () => {
        const state = get();
        const tx = state.transaction;
        if (!tx) return;
        set({ transaction: null });
        if (state.history.present === tx.before) return; // nothing changed: no history entry
        set((s) => ({
          history: {
            past: [...s.history.past, { project: tx.before, label: tx.label }].slice(
              -MAX_HISTORY_ENTRIES,
            ),
            present: s.history.present,
            future: [],
          },
        }));
      },

      cancelTransaction: () => {
        const state = get();
        const tx = state.transaction;
        if (!tx) return;
        set({
          transaction: null,
          history: { ...state.history, present: tx.before },
          revision: state.revision + 1,
        });
      },

      markSaved: (savedProject) => {
        set({ savedProject });
      },

      startNewProject: (project) => {
        set({ history: freshHistory(project), revision: 0, savedProject: null, transaction: null });
      },

      openProject: (project) => {
        set({
          history: freshHistory(project),
          revision: 0,
          savedProject: project,
          transaction: null,
        });
      },
    };
  });
}

export function selectIsDirty(state: Pick<ProjectStoreState, 'history' | 'savedProject'>): boolean {
  return state.history.present !== state.savedProject;
}
export function selectCanUndo(state: Pick<ProjectStoreState, 'history'>): boolean {
  return state.history.past.length > 0;
}
export function selectCanRedo(state: Pick<ProjectStoreState, 'history'>): boolean {
  return state.history.future.length > 0;
}

/** The application's single project store, opened on a new untitled project. */
export const useProjectStore = createProjectStore(
  createProject(randomIdGenerator, {
    name: 'Untitled Project',
    format: SEQUENCE_FORMAT_PRESETS.youtube1080p,
  }),
);
