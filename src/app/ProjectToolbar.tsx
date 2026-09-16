import { useState, type ReactNode } from 'react';
import { renameProject } from '../domain/ops/project';
import {
  selectCanRedo,
  selectCanUndo,
  selectIsDirty,
  useProjectStore,
} from '../state/projectStore';
import { useSessionStore } from '../state/sessionStore';
import {
  newProject,
  openProjectAtPath,
  openProjectFromDialog,
  saveProject,
  saveProjectAs,
  type ActionResult,
} from './projectActions';
import { useRecentProjects } from './useRecentProjects';

const NAME_INPUT_ID = 'project-name-input';

export function ProjectToolbar() {
  const projectName = useProjectStore((s) => s.history.present.name);
  const isDirty = useProjectStore(selectIsDirty);
  const canUndo = useProjectStore(selectCanUndo);
  const canRedo = useProjectStore(selectCanRedo);
  const projectPath = useSessionStore((s) => s.projectPath);
  const { recents, refresh } = useRecentProjects();
  const [nameDraft, setNameDraft] = useState(projectName);
  const [busy, setBusy] = useState(false);
  // Tracks the last store name the draft was synced to, so an external change
  // (New/Open/undo/redo) can be told apart from the user's own in-progress edit.
  const [syncedName, setSyncedName] = useState(projectName);
  if (projectName !== syncedName) {
    setSyncedName(projectName);
    if (document.activeElement?.id !== NAME_INPUT_ID) setNameDraft(projectName);
  }

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed === '' || trimmed === projectName) {
      setNameDraft(projectName);
      return;
    }
    useProjectStore.getState().dispatch(renameProject, { name: trimmed }, 'Rename project');
  };

  const run = async (action: () => Promise<ActionResult>) => {
    setBusy(true);
    try {
      const result = await action();
      if (!result.ok) window.alert(result.message);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="flex items-center gap-3 border-b border-edge bg-surface-1 px-4 py-2">
      <input
        id={NAME_INPUT_ID}
        aria-label="Project name"
        className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 text-sm font-medium outline-none hover:bg-surface-0 focus:bg-surface-0"
        value={nameDraft}
        onChange={(e) => {
          setNameDraft(e.target.value);
        }}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      <span className="text-xs text-fg-muted" data-testid="dirty-indicator">
        {isDirty ? 'Unsaved changes' : 'Saved'}
      </span>
      <div className="flex gap-1.5 text-sm">
        <ToolbarButton disabled={busy} onClick={() => void run(newProject)}>
          New
        </ToolbarButton>
        <ToolbarButton disabled={busy} onClick={() => void run(openProjectFromDialog)}>
          Open…
        </ToolbarButton>
        <ToolbarButton disabled={busy} onClick={() => void run(saveProject)}>
          Save
        </ToolbarButton>
        <ToolbarButton disabled={busy} onClick={() => void run(saveProjectAs)}>
          Save As…
        </ToolbarButton>
      </div>
      <div className="flex gap-1.5 text-sm">
        <ToolbarButton
          disabled={!canUndo}
          onClick={() => {
            useProjectStore.getState().undo();
          }}
        >
          Undo
        </ToolbarButton>
        <ToolbarButton
          disabled={!canRedo}
          onClick={() => {
            useProjectStore.getState().redo();
          }}
        >
          Redo
        </ToolbarButton>
      </div>
      {recents.length > 0 && (
        <select
          aria-label="Recent projects"
          className="rounded border border-edge bg-surface-0 px-2 py-1 text-xs"
          disabled={busy}
          value={projectPath ?? ''}
          onChange={(e) => {
            const path = e.target.value;
            if (path) void run(() => openProjectAtPath(path));
          }}
        >
          <option value="" disabled>
            Recent projects…
          </option>
          {recents.map((recent) => (
            <option key={recent.path} value={recent.path}>
              {recent.name}
            </option>
          ))}
        </select>
      )}
    </header>
  );
}

function ToolbarButton(props: { children: ReactNode; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className="rounded border border-edge px-2 py-1 hover:bg-surface-0 disabled:opacity-50"
    >
      {props.children}
    </button>
  );
}
