use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::error::AppError;

/// Build and platform information for the start screen and bug reports.
/// Mirrored by `AppInfoSchema` in src/ipc/contracts.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub tauri_version: String,
    pub os: String,
    pub arch: String,
    pub debug_build: bool,
    pub log_dir: String,
}

#[tauri::command]
pub async fn app_info<R: Runtime>(app: AppHandle<R>) -> Result<AppInfo, AppError> {
    let package = app.package_info();
    Ok(AppInfo {
        name: package.name.clone(),
        version: package.version.to_string(),
        tauri_version: tauri::VERSION.to_owned(),
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        debug_build: cfg!(debug_assertions),
        log_dir: app.path().app_log_dir()?.display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::AppInfo;
    use crate::test_support::assert_matches_fixture;

    #[test]
    fn serializes_to_the_contract_fixture() {
        let info = AppInfo {
            name: "Kriti".to_owned(),
            version: "0.1.0".to_owned(),
            tauri_version: "2.11.0".to_owned(),
            os: "windows".to_owned(),
            arch: "x86_64".to_owned(),
            debug_build: false,
            log_dir: r"C:\Users\example\AppData\Local\com.kriti.studio\logs".to_owned(),
        };
        assert_matches_fixture("app_info.json", &info);
    }
}
