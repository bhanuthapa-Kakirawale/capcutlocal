import { useState } from 'react';
import { recoverFromAutosave } from './projectActions';
import { useSessionRecovery } from './useSessionRecovery';

/** Offers to restore a newer autosave left by a session that did not exit cleanly
 * (docs/PROJECT-MODEL.md §6). Renders nothing once dismissed or when there is nothing to offer. */
export function RecoveryBanner() {
  const { recovery, dismiss } = useSessionRecovery();
  const [busy, setBusy] = useState(false);

  if (!recovery) return null;

  const recover = async () => {
    setBusy(true);
    try {
      const result = await recoverFromAutosave(recovery);
      if (!result.ok) window.alert(result.message);
      dismiss();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-edge bg-amber-950/40 px-4 py-2 text-sm text-amber-200"
    >
      <span>
        Kriti didn&apos;t exit cleanly last time
        {recovery.projectPath
          ? ` — a newer autosave of "${recovery.projectPath}" was found.`
          : ' — an unsaved new project was found.'}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void recover()}
        className="rounded border border-amber-700 px-2 py-1 hover:bg-amber-900/40 disabled:opacity-50"
      >
        Recover
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={dismiss}
        className="rounded px-2 py-1 text-amber-300 hover:bg-amber-900/40 disabled:opacity-50"
      >
        Discard
      </button>
    </div>
  );
}
