//! Autosave ring: the newest `MAX_AUTOSAVES_PER_PROJECT` snapshots per project, kept
//! independent of the user's own save path (docs/PROJECT-MODEL.md §6).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, Runtime};
use tokio::fs;

use crate::error::{AppError, ErrorCode};

const MAX_AUTOSAVES_PER_PROJECT: usize = 10;

/// Project ids are UUIDs (or, in tests, a small counter-based id); reject anything that
/// could escape the autosave directory before it becomes part of a path.
fn validate_id(id: &str) -> Result<(), AppError> {
    let safe = !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if safe {
        Ok(())
    } else {
        Err(AppError::new(
            ErrorCode::InvalidArgument,
            "invalid project id",
        ))
    }
}

fn autosave_dir<R: Runtime>(app: &AppHandle<R>, project_id: &str) -> Result<PathBuf, AppError> {
    validate_id(project_id)?;
    Ok(app.path().app_data_dir()?.join("autosave").join(project_id))
}

/// Zero-padded so lexicographic filename order is chronological order.
fn timestamp_filename() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{millis:020}.kriti")
}

async fn list_file_names(dir: &Path) -> Result<Vec<OsString>, AppError> {
    let mut entries = match fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(AppError::from_io_error("listing autosaves", &error)),
    };
    let mut names = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| AppError::from_io_error("listing autosaves", &e))?
    {
        let is_file = entry
            .file_type()
            .await
            .map(|file_type| file_type.is_file())
            .unwrap_or(false);
        if is_file {
            names.push(entry.file_name());
        }
    }
    Ok(names)
}

async fn write(dir: &Path, contents: &[u8]) -> Result<(), AppError> {
    fs::create_dir_all(dir)
        .await
        .map_err(|e| AppError::from_io_error("creating the autosave folder", &e))?;
    let path = dir.join(timestamp_filename());
    super::write_then_rename(&path, contents).await?;
    prune(dir, MAX_AUTOSAVES_PER_PROJECT).await
}

async fn prune(dir: &Path, keep: usize) -> Result<(), AppError> {
    let mut names = list_file_names(dir).await?;
    names.sort();
    if names.len() > keep {
        for name in &names[..names.len() - keep] {
            // Best-effort: a leftover old autosave is harmless.
            let _ = fs::remove_file(dir.join(name)).await;
        }
    }
    Ok(())
}

/// The most recent autosave in `dir`, if any. Synchronous: used once during app startup,
/// before the async runtime's own project-related work begins (see `session.rs`).
pub(super) fn latest_sync(dir: &Path) -> Option<PathBuf> {
    let mut names: Vec<OsString> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .map(|entry| entry.file_name())
        .collect();
    names.sort();
    names.pop().map(|name| dir.join(name))
}

#[tauri::command]
pub async fn project_autosave<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    contents: String,
) -> Result<(), AppError> {
    super::check_size(contents.len())?;
    super::parse_envelope_shell(&contents)?;
    let dir = autosave_dir(&app, &project_id)?;
    write(&dir, contents.as_bytes()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kriti-autosave-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn validate_id_accepts_uuid_like_and_counter_ids_only() {
        assert!(validate_id("3fa2b1c0-1111-2222-3333-444455556666").is_ok());
        assert!(validate_id("id-0007").is_ok());
        assert!(validate_id("").is_err());
        assert!(validate_id("../escape").is_err());
        assert!(validate_id("has/slash").is_err());
    }

    #[tokio::test]
    async fn write_keeps_only_the_newest_entries() {
        let dir = temp_dir("prune");
        for i in 0..(MAX_AUTOSAVES_PER_PROJECT + 5) {
            write(&dir, format!("save {i}").as_bytes()).await.unwrap();
            // Ensure distinct, increasing timestamps even on a fast filesystem.
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let names = list_file_names(&dir).await.unwrap();
        assert_eq!(names.len(), MAX_AUTOSAVES_PER_PROJECT);
    }

    #[test]
    fn latest_sync_returns_none_for_a_missing_directory() {
        let dir = temp_dir("latest-missing");
        assert_eq!(latest_sync(&dir), None);
    }

    #[tokio::test]
    async fn latest_sync_returns_the_most_recently_written_file() {
        let dir = temp_dir("latest");
        write(&dir, b"first").await.unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        write(&dir, b"second").await.unwrap();

        let latest = latest_sync(&dir).expect("an autosave exists");
        assert_eq!(std::fs::read_to_string(latest).unwrap(), "second");
    }
}
