//! Kriti application core. Design: docs/ARCHITECTURE.md.

mod commands;
mod error;
mod logging;
#[cfg(test)]
mod test_support;

use tauri::Manager;

/// Builds and runs the application; returns when the event loop ends.
pub fn run() {
    let result = tauri::Builder::default()
        .setup(|app| {
            let log_dir = app.path().app_log_dir()?;
            logging::init(&log_dir)?;
            tracing::info!(
                version = %app.package_info().version,
                log_dir = %log_dir.display(),
                "application started"
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_info,
            commands::log::log_write,
        ])
        .run(tauri::generate_context!());

    if let Err(error) = result {
        tracing::error!(%error, "application failed");
        // Startup can fail before logging is initialized, so stderr is the last resort.
        eprintln!("Kriti failed to start: {error}");
        std::process::exit(1);
    }
}
