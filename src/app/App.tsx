import type { AppInfo } from '../ipc/contracts';
import { useAppInfo } from './useAppInfo';

export function App() {
  const state = useAppInfo();

  return (
    <main className="flex h-full items-center justify-center p-8">
      <section className="w-full max-w-lg rounded-lg border border-edge bg-surface-1 p-8 shadow-lg">
        <h1 className="text-2xl font-semibold tracking-tight">Kriti</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Foundation build — editing features are not implemented yet.
        </p>
        <div className="mt-6">
          {state.status === 'loading' && (
            <p className="text-sm text-fg-muted">Connecting to the application core…</p>
          )}
          {state.status === 'error' && (
            <p role="alert" className="text-sm text-danger">
              {state.message}
            </p>
          )}
          {state.status === 'ready' && <CoreInfo info={state.info} />}
        </div>
      </section>
    </main>
  );
}

function CoreInfo({ info }: { info: AppInfo }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      <dt className="text-fg-muted">Version</dt>
      <dd data-testid="app-version">{info.version}</dd>
      <dt className="text-fg-muted">Core</dt>
      <dd>Tauri {info.tauriVersion}</dd>
      <dt className="text-fg-muted">Platform</dt>
      <dd>
        {info.os} {info.arch}
        {info.debugBuild ? ' · debug build' : ''}
      </dd>
      <dt className="text-fg-muted">Logs</dt>
      <dd data-testid="log-dir" className="font-mono text-xs break-all">
        {info.logDir}
      </dd>
    </dl>
  );
}
