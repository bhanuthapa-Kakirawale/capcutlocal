import { useEffect } from 'react';
import { MediaBrowser } from '../features/media-browser/MediaBrowser';
import { Timeline } from '../features/timeline/Timeline';
import { useProjectStore } from '../state/projectStore';
import { ProjectToolbar } from './ProjectToolbar';
import { RecoveryBanner } from './RecoveryBanner';
import { startAutosaveScheduler } from './autosaveScheduler';
import { bootstrapSession } from './projectActions';
import { useAppInfo } from './useAppInfo';

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

export function App() {
  const state = useAppInfo();

  useEffect(() => {
    void bootstrapSession();
    return startAutosaveScheduler(window);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (isTypingTarget(e.target) || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z')
        return;
      e.preventDefault();
      if (e.shiftKey) useProjectStore.getState().redo();
      else useProjectStore.getState().undo();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <ProjectToolbar />
      <RecoveryBanner />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="h-56 shrink-0 overflow-hidden">
          <MediaBrowser />
        </div>
        <Timeline />
      </div>
      {state.status === 'loading' && (
        <p className="border-t border-edge bg-surface-1 px-4 py-1 text-[11px] text-fg-muted">
          Connecting to the application core…
        </p>
      )}
      {state.status === 'error' && (
        <p role="alert" className="border-t border-edge bg-surface-1 px-4 py-1 text-sm text-danger">
          {state.message}
        </p>
      )}
      {state.status === 'ready' && (
        <footer className="flex gap-4 border-t border-edge bg-surface-1 px-4 py-1 text-[11px] text-fg-muted">
          <span data-testid="app-version">{state.info.version}</span>
          <span>Tauri {state.info.tauriVersion}</span>
          <span>
            {state.info.os} {state.info.arch}
            {state.info.debugBuild ? ' · debug build' : ''}
          </span>
          <span data-testid="log-dir" className="truncate">
            {state.info.logDir}
          </span>
        </footer>
      )}
    </div>
  );
}
