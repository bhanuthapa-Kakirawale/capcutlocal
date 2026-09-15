import { serializeProject } from '../domain/serialization';
import { projectAutosave } from '../ipc/commands';
import { describeIpcError } from '../ipc/invoke';
import { selectIsDirty, useProjectStore } from '../state/projectStore';
import { savedByLabel } from './appVersion';
import { logger } from './logger';

/** Runs every 60s while dirty, and on window blur (docs/PROJECT-MODEL.md §6). */
const AUTOSAVE_INTERVAL_MS = 60_000;

async function runAutosave(): Promise<void> {
  const state = useProjectStore.getState();
  if (!selectIsDirty(state)) return;

  const project = state.history.present;
  const savedBy = await savedByLabel();
  const serialized = serializeProject(project, savedBy);
  if (!serialized.ok) {
    // An invariant-violating document is a bug elsewhere; autosave just skips this tick.
    logger.warn(`autosave skipped: document failed validation (${serialized.error.kind})`);
    return;
  }

  const result = await projectAutosave(project.id, serialized.value);
  if (!result.ok) {
    logger.warn(`autosave failed: ${describeIpcError(result.error)}`);
    return;
  }
  logger.info('autosaved');
}

/** Starts the autosave timer and blur listener. Returns a cleanup function. */
export function startAutosaveScheduler(target: Window): () => void {
  const interval = target.setInterval(() => void runAutosave(), AUTOSAVE_INTERVAL_MS);
  const onBlur = () => void runAutosave();
  target.addEventListener('blur', onBlur);
  return () => {
    target.clearInterval(interval);
    target.removeEventListener('blur', onBlur);
  };
}
