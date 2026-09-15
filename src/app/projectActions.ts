import { createProject } from '../domain/factories';
import { randomIdGenerator } from '../domain/ids';
import { SEQUENCE_FORMAT_PRESETS } from '../domain/model/sequence';
import { describeLoadError, loadProjectFromText, serializeProject } from '../domain/serialization';
import { pickProjectSaveLocation, pickProjectToOpen } from '../ipc/dialogs';
import { projectOpen, projectSave, sessionSetActiveProject } from '../ipc/commands';
import type { RecoveryInfo } from '../ipc/contracts';
import { describeIpcError } from '../ipc/invoke';
import { selectIsDirty, useProjectStore } from '../state/projectStore';
import { useSessionStore } from '../state/sessionStore';
import { savedByLabel } from './appVersion';
import { logger } from './logger';

/**
 * New / Open / Save / Save As, plus crash recovery (docs/PROJECT-MODEL.md §6-7). These
 * orchestrate the domain layer (validation, serialization), the IPC layer (file I/O,
 * dialogs), and the stores — the one place that combines all three for project-level
 * actions, so components stay thin.
 */

export type ActionResult = { ok: true } | { ok: false; message: string };

function confirmDiscardIfDirty(promptMessage: string): boolean {
  if (!selectIsDirty(useProjectStore.getState())) return true;
  return window.confirm(promptMessage);
}

async function syncActiveProject(projectId: string, path: string | null): Promise<void> {
  const result = await sessionSetActiveProject(projectId, path);
  if (!result.ok) {
    logger.warn(`session_set_active_project failed: ${describeIpcError(result.error)}`);
  }
}

export async function newProject(name = 'Untitled Project'): Promise<ActionResult> {
  if (!confirmDiscardIfDirty('Discard unsaved changes and start a new project?')) {
    return { ok: true };
  }
  const project = createProject(randomIdGenerator, {
    name,
    format: SEQUENCE_FORMAT_PRESETS.youtube1080p,
  });
  useProjectStore.getState().startNewProject(project);
  useSessionStore.getState().setProjectPath(null);
  await syncActiveProject(project.id, null);
  return { ok: true };
}

export async function openProjectAtPath(path: string): Promise<ActionResult> {
  const opened = await projectOpen(path);
  if (!opened.ok) {
    const message = describeIpcError(opened.error);
    logger.error(`project_open failed: ${message}`);
    return { ok: false, message };
  }
  const loaded = loadProjectFromText(opened.value.contents);
  if (!loaded.ok) {
    const message = describeLoadError(loaded.error);
    logger.error(`opened an invalid project file: ${message}`);
    return { ok: false, message };
  }
  useProjectStore.getState().openProject(loaded.value);
  useSessionStore.getState().setProjectPath(path);
  await syncActiveProject(loaded.value.id, path);
  return { ok: true };
}

export async function openProjectFromDialog(): Promise<ActionResult> {
  if (!confirmDiscardIfDirty('Discard unsaved changes and open a different project?')) {
    return { ok: true };
  }
  const path = await pickProjectToOpen();
  if (path === null) return { ok: true }; // cancelled
  return openProjectAtPath(path);
}

async function writeProjectTo(path: string): Promise<ActionResult> {
  const project = useProjectStore.getState().history.present;
  const savedBy = await savedByLabel();
  const serialized = serializeProject(project, savedBy);
  if (!serialized.ok) {
    const message =
      serialized.error.kind === 'invariant'
        ? `The project is internally inconsistent and cannot be saved: ${serialized.error.violations.map((v) => v.message).join('; ')}`
        : `The project cannot be saved: ${serialized.error.message}`;
    logger.error(message);
    return { ok: false, message };
  }

  const result = await projectSave(path, serialized.value);
  if (!result.ok) {
    const message = describeIpcError(result.error);
    logger.error(`project_save failed: ${message}`);
    return { ok: false, message };
  }
  useProjectStore.getState().markSaved(project);
  return { ok: true };
}

export async function saveProjectAs(): Promise<ActionResult> {
  const project = useProjectStore.getState().history.present;
  const path = await pickProjectSaveLocation(project.name);
  if (path === null) return { ok: true }; // cancelled
  const result = await writeProjectTo(path);
  if (result.ok) {
    useSessionStore.getState().setProjectPath(path);
    await syncActiveProject(project.id, path);
  }
  return result;
}

export async function saveProject(): Promise<ActionResult> {
  const path = useSessionStore.getState().projectPath;
  return path === null ? saveProjectAs() : writeProjectTo(path);
}

/** Opens the recovered autosave as unsaved work, still pointed at the original save path
 * (never at the autosave file itself) so the next Save writes back to the real project. */
export async function recoverFromAutosave(recovery: RecoveryInfo): Promise<ActionResult> {
  const opened = await projectOpen(recovery.autosavePath);
  if (!opened.ok) {
    const message = describeIpcError(opened.error);
    logger.error(`could not read the autosave: ${message}`);
    return { ok: false, message };
  }
  const loaded = loadProjectFromText(opened.value.contents);
  if (!loaded.ok) {
    const message = describeLoadError(loaded.error);
    logger.error(`autosave file invalid: ${message}`);
    return { ok: false, message };
  }
  useProjectStore.getState().startNewProject(loaded.value); // recovered content is unsaved work
  useSessionStore.getState().setProjectPath(recovery.projectPath);
  await syncActiveProject(loaded.value.id, recovery.projectPath);
  return { ok: true };
}

/** Establishes this run's session lock for whatever project is active at launch
 * (the default blank project, unless the user chooses to recover). */
export async function bootstrapSession(): Promise<void> {
  const project = useProjectStore.getState().history.present;
  const path = useSessionStore.getState().projectPath;
  await syncActiveProject(project.id, path);
}
