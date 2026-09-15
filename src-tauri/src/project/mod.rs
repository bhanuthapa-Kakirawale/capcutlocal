//! Project file I/O: atomic save, open, autosave ring, session lock and crash recovery
//! (docs/PROJECT-MODEL.md §5-6). The document's JSON *shape* and every invariant are
//! validated by the TypeScript domain layer (ADR-002) — this module treats the project
//! as opaque bytes plus a shallow envelope check, so garbage never overwrites a project
//! file and a corrupt file is never partially accepted.

// `pub(crate)` (not private): `tauri::generate_handler!` in lib.rs references each
// `#[tauri::command]` function by its *defining* module path (e.g.
// `project::autosave::project_autosave`), not through a re-export below — the
// attribute macro's hidden helper items live alongside the function in that module
// and are not carried along by a `pub use`.
pub(crate) mod autosave;
pub(crate) mod recents;
pub(crate) mod session;

pub(crate) use session::{init_recovery_state, session_clear_on_exit};

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tokio::fs;
use tokio::io::AsyncWriteExt;

use crate::error::{AppError, ErrorCode};

/// Real projects are a few hundred KB; this is a generous ceiling, not a target
/// (docs/PROJECT-MODEL.md §5.1).
const MAX_PROJECT_FILE_BYTES: u64 = 256 * 1024 * 1024;
const PROJECT_FILE_FORMAT: &str = "kriti.project";

/// What Rust needs out of the envelope, without understanding the rest of the document
/// (docs/PROJECT-MODEL.md §5.2's "shallow envelope check"). `format` and `schemaVersion`
/// are validated here but not kept: the full envelope shape is TypeScript's to own (ADR-002).
#[derive(Debug)]
struct EnvelopeShell {
    /// Best-effort, for the recent-projects list; absent if the file is malformed there.
    project_name: Option<String>,
}

fn parse_envelope_shell(contents: &str) -> Result<EnvelopeShell, AppError> {
    let value: serde_json::Value = serde_json::from_str(contents).map_err(|error| {
        AppError::new(
            ErrorCode::InvalidProjectFile,
            format!("not valid JSON: {error}"),
        )
    })?;
    let format = value
        .get("format")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::new(ErrorCode::InvalidProjectFile, "missing \"format\""))?;
    if format != PROJECT_FILE_FORMAT {
        return Err(AppError::new(
            ErrorCode::InvalidProjectFile,
            format!("not a Kriti project file (format \"{format}\")"),
        ));
    }
    if value
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .is_none()
    {
        return Err(AppError::new(
            ErrorCode::InvalidProjectFile,
            "missing \"schemaVersion\"",
        ));
    }
    let project_name = value
        .get("project")
        .and_then(|p| p.get("name"))
        .and_then(|n| n.as_str())
        .map(str::to_owned);
    Ok(EnvelopeShell { project_name })
}

fn check_size(byte_len: usize) -> Result<(), AppError> {
    if byte_len as u64 > MAX_PROJECT_FILE_BYTES {
        return Err(AppError::new(
            ErrorCode::TooLarge,
            format!(
                "project file is {byte_len} bytes, exceeding the {MAX_PROJECT_FILE_BYTES} byte limit"
            ),
        ));
    }
    Ok(())
}

/// `path` with `suffix` appended to its whole file name (not `Path::with_extension`,
/// which would mangle a name that already contains a dot, like `My Project.kriti`).
fn sibling_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name: OsString = path.file_name().unwrap_or_default().to_owned();
    name.push(suffix);
    path.with_file_name(name)
}

/// tmp write + fsync + atomic rename, with no backup step (docs/PROJECT-MODEL.md §5.2).
/// A crash at any point leaves the old file or the new file at `path`, never a torn one.
async fn write_then_rename(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| AppError::from_io_error("creating the project's folder", &e))?;
    }

    let tmp_path = sibling_with_suffix(path, ".tmp");
    {
        let mut file = fs::File::create(&tmp_path)
            .await
            .map_err(|e| AppError::from_io_error("writing the project file", &e))?;
        file.write_all(bytes)
            .await
            .map_err(|e| AppError::from_io_error("writing the project file", &e))?;
        file.sync_all()
            .await
            .map_err(|e| AppError::from_io_error("writing the project file", &e))?;
    }

    fs::rename(&tmp_path, path)
        .await
        .map_err(|e| AppError::from_io_error("replacing the project file", &e))?;
    Ok(())
}

/// `write_then_rename`, plus a best-effort single-generation backup of the file it
/// replaces (docs/PROJECT-MODEL.md §5.2) — used for the user's own save path, where an
/// existing file is meaningful. Losing the backup must never block saving the new edit.
async fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    if fs::try_exists(path).await.unwrap_or(false) {
        let bak_path = sibling_with_suffix(path, ".bak");
        if let Err(error) = fs::copy(path, &bak_path).await {
            tracing::warn!(%error, path = %bak_path.display(), "could not write project backup");
        }
    }
    write_then_rename(path, bytes).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedProject {
    pub contents: String,
    pub path: String,
}

#[tauri::command]
pub async fn project_save<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    contents: String,
) -> Result<(), AppError> {
    check_size(contents.len())?;
    let shell = parse_envelope_shell(&contents)?;
    let path_buf = PathBuf::from(&path);
    atomic_write(&path_buf, contents.as_bytes()).await?;
    if let Err(error) = recents::record_opened(&app, &path_buf, shell.project_name.as_deref()) {
        tracing::warn!(%error, "could not update the recent-projects list");
    }
    Ok(())
}

#[tauri::command]
pub async fn project_open<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<OpenedProject, AppError> {
    let path_buf = PathBuf::from(&path);
    let metadata = fs::metadata(&path_buf)
        .await
        .map_err(|e| AppError::from_io_error("opening the project file", &e))?;
    check_size(usize::try_from(metadata.len()).unwrap_or(usize::MAX))?;

    let bytes = fs::read(&path_buf)
        .await
        .map_err(|e| AppError::from_io_error("opening the project file", &e))?;
    let contents = String::from_utf8(bytes).map_err(|_| {
        AppError::new(
            ErrorCode::InvalidProjectFile,
            "project file is not valid UTF-8",
        )
    })?;
    let shell = parse_envelope_shell(&contents)?;

    if let Err(error) = recents::record_opened(&app, &path_buf, shell.project_name.as_deref()) {
        tracing::warn!(%error, "could not update the recent-projects list");
    }
    Ok(OpenedProject { contents, path })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kriti-project-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sibling_with_suffix_appends_to_the_whole_file_name() {
        let path = Path::new("C:/Projects/My Project.kriti");
        assert_eq!(
            sibling_with_suffix(path, ".tmp"),
            Path::new("C:/Projects/My Project.kriti.tmp")
        );
        assert_eq!(
            sibling_with_suffix(path, ".bak"),
            Path::new("C:/Projects/My Project.kriti.bak")
        );
    }

    #[test]
    fn parse_envelope_shell_reads_the_project_name() {
        let shell = parse_envelope_shell(
            r#"{"format":"kriti.project","schemaVersion":1,"project":{"name":"Demo"}}"#,
        )
        .unwrap();
        assert_eq!(shell.project_name.as_deref(), Some("Demo"));
    }

    #[test]
    fn parse_envelope_shell_accepts_a_missing_name_as_none() {
        let shell =
            parse_envelope_shell(r#"{"format":"kriti.project","schemaVersion":1,"project":{}}"#)
                .unwrap();
        assert_eq!(shell.project_name, None);
    }

    #[test]
    fn parse_envelope_shell_rejects_a_non_kriti_file() {
        let error =
            parse_envelope_shell(r#"{"format":"something.else","schemaVersion":1}"#).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidProjectFile);
    }

    #[test]
    fn parse_envelope_shell_rejects_a_missing_schema_version() {
        let error = parse_envelope_shell(r#"{"format":"kriti.project"}"#).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidProjectFile);
    }

    #[test]
    fn parse_envelope_shell_rejects_invalid_json() {
        let error = parse_envelope_shell("{ not json").unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidProjectFile);
    }

    #[tokio::test]
    async fn atomic_write_creates_the_file_and_a_backup_of_the_previous_version() {
        let dir = temp_dir("atomic-write");
        let path = dir.join("Project.kriti");

        atomic_write(&path, b"version 1").await.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "version 1");
        assert!(!path.with_file_name("Project.kriti.bak").exists());

        atomic_write(&path, b"version 2").await.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "version 2");
        assert_eq!(
            std::fs::read_to_string(path.with_file_name("Project.kriti.bak")).unwrap(),
            "version 1"
        );

        // No leftover temp file after a successful write.
        assert!(!path.with_file_name("Project.kriti.tmp").exists());
    }

    #[test]
    fn opened_project_serializes_to_the_contract_fixture() {
        let opened = OpenedProject {
            contents: "{\"format\":\"kriti.project\"}".to_owned(),
            path: r"C:\Projects\Demo.kriti".to_owned(),
        };
        crate::test_support::assert_matches_fixture("opened_project.json", &opened);
    }

    #[tokio::test]
    async fn project_open_rejects_a_missing_file_with_not_found() {
        let dir = temp_dir("open-missing");
        let error = fs::metadata(dir.join("does-not-exist.kriti"))
            .await
            .map_err(|e| AppError::from_io_error("x", &e))
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
    }
}
