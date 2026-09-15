//! Kriti application core. Design: docs/ARCHITECTURE.md.

mod cache;
mod commands;
mod db;
mod error;
mod ffmpeg;
mod jobs;
mod logging;
mod media;
#[cfg(windows)]
mod process_job;
mod project;
#[cfg(test)]
mod test_support;

use tauri::{Manager, RunEvent};

use cache::Cache;
use db::Db;
use jobs::JobScheduler;

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

            // Every FFmpeg child this app ever spawns automatically joins this process's
            // job (Windows assigns child processes to their parent's job by default), so
            // a crash or kill of Kriti itself tears down any child still running with it —
            // never an orphaned encoder (docs/MEDIA-PIPELINE.md §1.2). The `Job` handle
            // must stay alive for the app's lifetime, hence managing it as state here.
            #[cfg(windows)]
            match process_job::create() {
                Ok(job) => {
                    app.manage(job);
                }
                Err(error) => tracing::warn!(%error, "could not set up the process job"),
            }

            let db = Db::open(&app.path().app_data_dir()?.join("library.db"))?;
            let cache = Cache::new(app.path().app_cache_dir()?);
            // Startup reconciliation (docs/MEDIA-PIPELINE.md §6.4): fast for a cache this
            // small, so it is acceptable to run once, synchronously, before the app is usable.
            match tauri::async_runtime::block_on(cache.reconcile(&db)) {
                Ok(report) => tracing::info!(
                    orphaned_rows = report.orphaned_rows_removed,
                    orphaned_files = report.orphaned_files_removed,
                    "cache reconciled"
                ),
                Err(error) => tracing::warn!(%error, "cache reconciliation failed"),
            }
            app.manage(db);
            app.manage(cache);
            app.manage(JobScheduler::new(app.handle().clone()));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_info,
            commands::log::log_write,
            commands::media::media_import,
            commands::media::media_generate_poster,
            commands::media::job_cancel,
            commands::media::ffmpeg_diagnostics,
            project::project_save,
            project::project_open,
            project::autosave::project_autosave,
            project::recents::recent_projects_list,
            project::session::session_check_recovery,
            project::session::session_set_active_project,
        ])
        .build(tauri::generate_context!())
}
