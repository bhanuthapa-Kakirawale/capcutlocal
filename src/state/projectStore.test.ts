import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createCounterIdGenerator } from '../domain/ids';
import { renameProject } from '../domain/ops/project';
import { makeValidProject } from '../domain/test-helpers';
import {
  MAX_HISTORY_ENTRIES,
  createProjectStore,
  selectCanRedo,
  selectCanUndo,
  selectIsDirty,
} from './projectStore';

function setup() {
  const ids = createCounterIdGenerator();
  const initial = makeValidProject(ids);
  const store = createProjectStore(initial, ids);
  return { store, initial };
}

describe('dispatch', () => {
  it('commits one history entry and bumps the revision', () => {
    const { store, initial } = setup();
    const result = store.getState().dispatch(renameProject, { name: 'Renamed' }, 'Rename project');

    expect(result.ok).toBe(true);
    const state = store.getState();
    expect(state.history.present.name).toBe('Renamed');
    expect(state.history.past).toEqual([{ project: initial, label: 'Rename project' }]);
    expect(state.history.future).toEqual([]);
    expect(state.revision).toBe(1);
  });

  it('does not push a history entry for a no-op edit', () => {
    const { store, initial } = setup();
    const result = store
      .getState()
      .dispatch(renameProject, { name: initial.name }, 'Rename project');

    expect(result.ok).toBe(true);
    expect(store.getState().history.past).toEqual([]);
    expect(store.getState().revision).toBe(0);
  });

  it('returns the op error and leaves the document unchanged on failure', () => {
    const { store, initial } = setup();
    const result = store.getState().dispatch(renameProject, { name: '   ' }, 'Rename project');

    expect(result.ok).toBe(false);
    expect(store.getState().history.present).toBe(initial);
    expect(store.getState().revision).toBe(0);
  });

  it('clears future on a new dispatch (new branch after undo)', () => {
    const { store } = setup();
    store.getState().dispatch(renameProject, { name: 'A' }, 'r1');
    store.getState().undo();
    expect(selectCanRedo(store.getState())).toBe(true);

    store.getState().dispatch(renameProject, { name: 'B' }, 'r2');
    expect(selectCanRedo(store.getState())).toBe(false);
  });

  it('caps history at MAX_HISTORY_ENTRIES', () => {
    const { store } = setup();
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 50; i += 1) {
      store
        .getState()
        .dispatch(renameProject, { name: `Name ${i.toString()}` }, `rename ${i.toString()}`);
    }
    expect(store.getState().history.past).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(store.getState().history.present.name).toBe(
      `Name ${(MAX_HISTORY_ENTRIES + 49).toString()}`,
    );
  });
});

describe('undo / redo', () => {
  it('undo restores the previous project and redo restores the change', () => {
    const { store, initial } = setup();
    store.getState().dispatch(renameProject, { name: 'Renamed' }, 'Rename project');

    store.getState().undo();
    expect(store.getState().history.present).toBe(initial);
    expect(selectCanUndo(store.getState())).toBe(false);
    expect(selectCanRedo(store.getState())).toBe(true);

    store.getState().redo();
    expect(store.getState().history.present.name).toBe('Renamed');
    expect(selectCanRedo(store.getState())).toBe(false);
  });

  it('undo and redo with nothing to undo/redo are no-ops', () => {
    const { store, initial } = setup();
    store.getState().undo();
    expect(store.getState().history.present).toBe(initial);
    store.getState().redo();
    expect(store.getState().history.present).toBe(initial);
  });
});

describe('transactions', () => {
  it('collapses several updates into exactly one history entry', () => {
    const { store, initial } = setup();
    store.getState().beginTransaction('Rename project');
    store.getState().updateTransaction(renameProject, { name: 'A' });
    store.getState().updateTransaction(renameProject, { name: 'AB' });
    store.getState().updateTransaction(renameProject, { name: 'ABC' });
    store.getState().commitTransaction();

    const state = store.getState();
    expect(state.history.present.name).toBe('ABC');
    expect(state.history.past).toEqual([{ project: initial, label: 'Rename project' }]);
    expect(state.transaction).toBeNull();
  });

  it('undo after a committed transaction restores the pre-transaction state, not an intermediate one', () => {
    const { store, initial } = setup();
    store.getState().beginTransaction('Rename project');
    store.getState().updateTransaction(renameProject, { name: 'A' });
    store.getState().updateTransaction(renameProject, { name: 'AB' });
    store.getState().commitTransaction();

    store.getState().undo();
    expect(store.getState().history.present).toBe(initial);
  });

  it('cancelTransaction restores the pre-transaction document and adds no history entry', () => {
    const { store, initial } = setup();
    store.getState().beginTransaction('Rename project');
    store.getState().updateTransaction(renameProject, { name: 'A' });
    store.getState().cancelTransaction();

    const state = store.getState();
    expect(state.history.present).toBe(initial);
    expect(state.history.past).toEqual([]);
    expect(state.transaction).toBeNull();
  });

  it('commits no history entry when the only update in the transaction was a no-op', () => {
    const { store, initial } = setup();
    store.getState().beginTransaction('Rename project');
    store.getState().updateTransaction(renameProject, { name: initial.name }); // renaming to itself
    store.getState().commitTransaction();

    expect(store.getState().history.present).toBe(initial);
    expect(store.getState().history.past).toEqual([]);
  });

  it('still commits one entry when several updates net back to the original content', () => {
    // Dirty tracking is reference-based, not deep-equality-based (docs/PROJECT-MODEL.md §7.4):
    // each updateTransaction call is a separate Immer `produce`, so even though the final
    // content equals `initial`, it is a different object. Only undo restores the exact
    // stored reference; a transaction that visits and leaves a value is not "free".
    const { store, initial } = setup();
    store.getState().beginTransaction('Rename project');
    store.getState().updateTransaction(renameProject, { name: 'A' });
    store.getState().updateTransaction(renameProject, { name: initial.name });
    store.getState().commitTransaction();

    expect(store.getState().history.present).not.toBe(initial);
    expect(store.getState().history.present).toEqual(initial);
    expect(store.getState().history.past).toEqual([{ project: initial, label: 'Rename project' }]);
  });

  it('beginTransaction auto-commits a previously open transaction', () => {
    const { store } = setup();
    store.getState().beginTransaction('First');
    store.getState().updateTransaction(renameProject, { name: 'A' });
    store.getState().beginTransaction('Second');

    expect(store.getState().history.past).toHaveLength(1);
    expect(store.getState().history.past[0]?.label).toBe('First');
    expect(store.getState().history.present.name).toBe('A');
  });

  it('throws if updateTransaction is called with no open transaction', () => {
    const { store } = setup();
    expect(() => store.getState().updateTransaction(renameProject, { name: 'A' })).toThrow();
  });
});

describe('dirty tracking', () => {
  it('a freshly created store is dirty (savedProject is null)', () => {
    const { store } = setup();
    expect(selectIsDirty(store.getState())).toBe(true);
  });

  it('openProject starts clean; startNewProject starts dirty', () => {
    const { store, initial } = setup();
    store.getState().openProject(initial);
    expect(selectIsDirty(store.getState())).toBe(false);

    store.getState().startNewProject(initial);
    expect(selectIsDirty(store.getState())).toBe(true);
  });

  it('markSaved(present) clears dirty; a further edit makes it dirty again', () => {
    const { store } = setup();
    store.getState().dispatch(renameProject, { name: 'A' }, 'r1');
    store.getState().markSaved(store.getState().history.present);
    expect(selectIsDirty(store.getState())).toBe(false);

    store.getState().dispatch(renameProject, { name: 'B' }, 'r2');
    expect(selectIsDirty(store.getState())).toBe(true);
  });

  it('markSaved with a stale reference (save still in flight) does not mark newer edits clean', () => {
    const { store } = setup();
    store.getState().dispatch(renameProject, { name: 'A' }, 'r1');
    const inFlight = store.getState().history.present; // captured before further edits
    store.getState().dispatch(renameProject, { name: 'B' }, 'r2'); // user kept editing
    store.getState().markSaved(inFlight); // the save of "A" only just resolved

    expect(selectIsDirty(store.getState())).toBe(true);
  });
});

describe('property: history invariants hold for any sequence of dispatch/undo/redo', () => {
  it('past never exceeds the cap, and canUndo/canRedo match past/future length', () => {
    const actionArb = fc.oneof(
      fc.record({
        kind: fc.constant('rename' as const),
        name: fc.string({ minLength: 1, maxLength: 10 }),
      }),
      fc.record({ kind: fc.constant('undo' as const) }),
      fc.record({ kind: fc.constant('redo' as const) }),
    );

    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 300 }), (actions) => {
        const { store } = setup();
        for (const action of actions) {
          if (action.kind === 'rename') {
            store.getState().dispatch(renameProject, { name: action.name }, 'rename');
          } else if (action.kind === 'undo') {
            store.getState().undo();
          } else {
            store.getState().redo();
          }

          const state = store.getState();
          expect(state.history.past.length).toBeLessThanOrEqual(MAX_HISTORY_ENTRIES);
          expect(selectCanUndo(state)).toBe(state.history.past.length > 0);
          expect(selectCanRedo(state)).toBe(state.history.future.length > 0);
        }
      }),
    );
  });
});
