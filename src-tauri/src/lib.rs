//! Kriti application core. Design: docs/ARCHITECTURE.md.

mod commands;
mod error;
mod logging;
mod project;
#[cfg(test)]
mod test_support;

use tauri::{Manager, RunEvent};

/// Builds and runs the application; returns when the event loop ends.
pub fn run() {
    let result = build();
    match result {
        Ok(app) => app.run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                project::session_clear_on_exit(app_handle);
            }
        }),
        Err(error) => {
            tracing::error!(%error, "application failed to start");
            // Startup can fail before logging is initialized, so stderr is the last resort.
            eprintln!("Kriti failed to start: {error}");
            std::process::exit(1);
        }
    }
}

fn build() -> tauri::Result<tauri::App<tauri::Wry>> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let log_dir = app.path().app_log_dir()?;
            logging::init(&log_dir)?;
            tracing::info!(
                version = %app.package_info().version,
                log_dir = %log_dir.display(),
                "application started"
            );

            let recovery = project::init_recovery_state(app.handle());
            app.manage(recovery);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_info,
            commands::log::log_write,
            project::project_save,
            project::project_open,
            project::autosave::project_autosave,
            project::recents::recent_projects_list,
            project::session::session_check_recovery,
            project::session::session_set_active_project,
        ])
        .build(tauri::generate_context!())
}
