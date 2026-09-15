//! Session lock and crash-recovery detection (docs/PROJECT-MODEL.md §6). A small JSON
//! file records which project is open. If it is still present at the next launch, the
//! previous run did not exit cleanly; when a newer autosave exists for that project,
//! there is unsaved work worth offering back to the user.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::error::AppError;

use super::autosave;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
struct LockContents {
    open_project_id: Option<String>,
    open_project_path: Option<String>,
}

fn lock_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("session.lock"))
}

fn read_lock(path: &Path) -> Option<LockContents> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryInfo {
    pub project_id: String,
    /// Where the project was saved when the previous run started, if it had been saved yet.
    pub project_path: Option<String>,
    pub autosave_path: String,
}

/// Computed once at startup and cached; see `init_recovery_state`.
pub struct RecoveryState(pub(super) Mutex<Option<RecoveryInfo>>);

/// Reads the *previous* run's lock file, before this run's own lock exists. Call once
/// during `setup()`, synchronously (directory listings here are at most a few files).
fn check_recovery<R: Runtime>(app: &AppHandle<R>) -> Option<RecoveryInfo> {
    let prior = read_lock(&lock_path(app)?)?;
    let project_id = prior.open_project_id?;
    let autosave_dir = app
        .path()
        .app_data_dir()
        .ok()?
        .join("autosave")
        .join(&project_id);
    let latest_path = autosave::latest_sync(&autosave_dir)?;
    let latest_modified = std::fs::metadata(&latest_path).ok()?.modified().ok()?;

    let project_modified = prior
        .open_project_path
        .as_deref()
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|m| m.modified().ok());
    let autosave_is_newer = match project_modified {
        Some(saved_at) => latest_modified > saved_at,
        // Never saved, or the saved file is gone: the autosave is the only copy there is.
        None => true,
    };
    if !autosave_is_newer {
        return None;
    }

    Some(RecoveryInfo {
        project_id,
        project_path: prior.open_project_path,
        autosave_path: latest_path.display().to_string(),
    })
}

/// Runs the one-time startup check and stores the result as managed state.
pub(crate) fn init_recovery_state<R: Runtime>(app: &AppHandle<R>) -> RecoveryState {
    RecoveryState(Mutex::new(check_recovery(app)))
}

#[tauri::command]
pub async fn session_check_recovery(
    state: tauri::State<'_, RecoveryState>,
) -> Result<Option<RecoveryInfo>, AppError> {
    Ok(state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone())
}

/// Called whenever the active project's identity changes (New, Open, and Save As all
/// succeeding). Establishes this run's lock; a leftover lock at the next launch means
/// this run did not exit cleanly.
#[tauri::command]
pub async fn session_set_active_project<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    path: Option<String>,
) -> Result<(), AppError> {
    let Some(lock) = lock_path(&app) else {
        return Ok(()); // no app-data dir resolvable: nothing to record, not fatal
    };
    let contents = LockContents {
        open_project_id: Some(project_id),
        open_project_path: path,
    };
    let bytes = serde_json::to_vec(&contents).map_err(|e| AppError::internal(e.to_string()))?;
    if let Some(parent) = lock.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::from_io_error("writing the session lock", &e))?;
    }
    std::fs::write(&lock, bytes)
        .map_err(|e| AppError::from_io_error("writing the session lock", &e))?;
    Ok(())
}

/// Removes the lock on a clean exit, so the next launch sees no stale session
/// (docs/PROJECT-MODEL.md §6). Best-effort: exit must never be blocked by this.
pub(crate) fn session_clear_on_exit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(path) = lock_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kriti-session-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn recovery_info_serializes_to_the_contract_fixture() {
        let info = RecoveryInfo {
            project_id: "3fa2b1c0-1111-2222-3333-444455556666".to_owned(),
            project_path: Some(r"C:\Projects\Demo.kriti".to_owned()),
            autosave_path: r"C:\Users\example\AppData\Local\com.kriti.studio\autosave\3fa2b1c0\00000001757800000000.kriti".to_owned(),
        };
        crate::test_support::assert_matches_fixture("recovery_info.json", &info);
    }

    #[test]
    fn lock_contents_round_trip_through_json() {
        let contents = LockContents {
            open_project_id: Some("id-0001".to_owned()),
            open_project_path: Some(r"C:\Projects\Demo.kriti".to_owned()),
        };
        let bytes = serde_json::to_vec(&contents).unwrap();
        let path = temp_dir("lock-roundtrip").join("session.lock");
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(read_lock(&path), Some(contents));
    }

    #[test]
    fn read_lock_returns_none_for_a_missing_or_corrupt_file() {
        let dir = temp_dir("lock-missing");
        assert_eq!(read_lock(&dir.join("session.lock")), None);

        let corrupt = dir.join("corrupt.lock");
        std::fs::write(&corrupt, b"not json").unwrap();
        assert_eq!(read_lock(&corrupt), None);
    }
}
