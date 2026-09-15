import { getCurrentWebview } from '@tauri-apps/api/webview';

const NOOP_UNLISTEN = () => {
  /* nothing to unsubscribe */
};

/** Subscribes to native file drag-and-drop over the main window. Returns an unsubscribe
 * function (call it from a React effect's cleanup). Resolves to a no-op subscription
 * rather than rejecting if the webview API is unavailable in the current context (e.g.
 * component tests outside a real Tauri window) — drag-drop is a convenience on top of
 * the dialog-based import, never the only way in. */
export async function onFilesDropped(handler: (paths: string[]) => void): Promise<() => void> {
  try {
    return await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === 'drop') {
        handler(event.payload.paths);
      }
    });
  } catch {
    return NOOP_UNLISTEN;
  }
}
