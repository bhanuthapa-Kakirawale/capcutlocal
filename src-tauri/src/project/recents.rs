//! Recently-opened projects. A small JSON settings file — the plan is to move this into
//! `library.db` once Phase 3 introduces it (docs/ROADMAP.md Phase 2).

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::error::AppError;

const MAX_RECENTS: usize = 20;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub last_opened_at_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    recent_projects: Vec<RecentProject>,
}

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, AppError> {
    Ok(app.path().app_config_dir()?.join("settings.json"))
}

/// Never fails: a missing or corrupt settings file just means an empty list.
fn load(path: &Path) -> Settings {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save(path: &Path, settings: &Settings) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::from_io_error("writing settings", &e))?;
    }
    let bytes =
        serde_json::to_vec_pretty(settings).map_err(|e| AppError::internal(e.to_string()))?;
    std::fs::write(path, bytes).map_err(|e| AppError::from_io_error("writing settings", &e))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Moves `path_str` to the front of `settings` (inserting it if new), trimmed to
/// `MAX_RECENTS`. Pure, so it is tested directly rather than through an `AppHandle`.
fn apply_recent(settings: &mut Settings, path_str: String, name: String, at_ms: u64) {
    settings
        .recent_projects
        .retain(|entry| entry.path != path_str);
    settings.recent_projects.insert(
        0,
        RecentProject {
            path: path_str,
            name,
            last_opened_at_ms: at_ms,
        },
    );
    settings.recent_projects.truncate(MAX_RECENTS);
}

/// Records that `path` was just opened or saved. `name` falls back to the file stem
/// when the project's own name could not be read from its envelope.
pub(super) fn record_opened<R: Runtime>(
    app: &AppHandle<R>,
    path: &Path,
    name: Option<&str>,
) -> Result<(), AppError> {
    let settings_file = settings_path(app)?;
    let mut settings = load(&settings_file);
    let path_str = path.display().to_string();
    let name = name
        .map(str::to_owned)
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_else(|| path_str.clone());
    apply_recent(&mut settings, path_str, name, now_ms());
    save(&settings_file, &settings)
}

#[tauri::command]
pub async fn recent_projects_list<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<RecentProject>, AppError> {
    Ok(load(&settings_path(&app)?).recent_projects)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_settings_path(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kriti-recents-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    #[test]
    fn load_returns_an_empty_list_for_a_missing_file() {
        let path = temp_settings_path("missing");
        assert_eq!(load(&path).recent_projects, Vec::new());
    }

    #[test]
    fn save_then_load_round_trips() {
        let path = temp_settings_path("roundtrip");
        let settings = Settings {
            recent_projects: vec![RecentProject {
                path: "C:/a.kriti".to_owned(),
                name: "A".to_owned(),
                last_opened_at_ms: 42,
            }],
        };
        save(&path, &settings).unwrap();
        assert_eq!(load(&path).recent_projects, settings.recent_projects);
    }

    #[test]
    fn recent_project_serializes_to_the_contract_fixture() {
        let entry = RecentProject {
            path: r"C:\Projects\Demo.kriti".to_owned(),
            name: "Demo".to_owned(),
            last_opened_at_ms: 1_757_800_000_000,
        };
        crate::test_support::assert_matches_fixture("recent_project.json", &entry);
    }

    #[test]
    fn apply_recent_moves_an_existing_entry_to_the_front_without_duplicating_it() {
        let mut settings = Settings::default();
        apply_recent(&mut settings, "C:/a.kriti".to_owned(), "A".to_owned(), 1);
        apply_recent(&mut settings, "C:/b.kriti".to_owned(), "B".to_owned(), 2);
        apply_recent(
            &mut settings,
            "C:/a.kriti".to_owned(),
            "A renamed".to_owned(),
            3,
        );

        assert_eq!(settings.recent_projects.len(), 2);
        assert_eq!(settings.recent_projects[0].path, "C:/a.kriti");
        assert_eq!(settings.recent_projects[0].name, "A renamed");
        assert_eq!(settings.recent_projects[1].path, "C:/b.kriti");
    }

    #[test]
    fn apply_recent_truncates_to_max_recents_keeping_the_newest() {
        let mut settings = Settings::default();
        for i in 0..(MAX_RECENTS + 5) {
            apply_recent(
                &mut settings,
                format!("C:/{i}.kriti"),
                i.to_string(),
                i as u64,
            );
        }
        assert_eq!(settings.recent_projects.len(), MAX_RECENTS);
        assert_eq!(
            settings.recent_projects[0].path,
            format!("C:/{}.kriti", MAX_RECENTS + 4)
        );
    }
}
