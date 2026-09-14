//! Structured logging to daily-rotated files (docs/ARCHITECTURE.md §8).

use std::path::{Path, PathBuf};

use tracing_appender::rolling::{InitError, RollingFileAppender, Rotation};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::{SubscriberInitExt, TryInitError};
use tracing_subscriber::{EnvFilter, fmt};

/// Files are named `kriti.<yyyy-mm-dd>.log`.
const FILE_PREFIX: &str = "kriti";
const FILE_SUFFIX: &str = "log";
/// Daily files kept before the oldest is deleted.
const RETAINED_FILES: usize = 14;
/// Overrides the default filter with `tracing` env-filter syntax, e.g. `KRITI_LOG=debug`.
const FILTER_ENV_VAR: &str = "KRITI_LOG";
const DEFAULT_FILTER: &str = "info";

#[derive(Debug, thiserror::Error)]
pub enum LoggingError {
    #[error("could not create log directory {path}: {source}")]
    CreateDir {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("could not open the log file: {0}")]
    OpenFile(#[from] InitError),
    #[error("a global logger is already installed: {0}")]
    AlreadyInstalled(#[from] TryInitError),
}

/// Installs the global subscriber (files in `log_dir`, plus stderr in debug builds) and
/// routes panics into the log, since release builds have no console.
pub fn init(log_dir: &Path) -> Result<(), LoggingError> {
    std::fs::create_dir_all(log_dir).map_err(|source| LoggingError::CreateDir {
        path: log_dir.to_path_buf(),
        source,
    })?;
    let file = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(FILE_PREFIX)
        .filename_suffix(FILE_SUFFIX)
        .max_log_files(RETAINED_FILES)
        .build(log_dir)?;
    let filter =
        EnvFilter::try_from_env(FILTER_ENV_VAR).unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER));
    let console = cfg!(debug_assertions).then(|| fmt::layer().with_writer(std::io::stderr));

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(file).with_ansi(false))
        .with(console)
        .try_init()?;

    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        tracing::error!(target: "panic", "{info}");
        previous_hook(info);
    }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::init;

    // The only test allowed to call `init`: it installs a process-wide subscriber.
    #[test]
    fn writes_events_to_a_dated_file_in_the_log_dir() {
        // A fixed directory, cleared first: the appender keeps its file open, so a per-run
        // directory could not be removed at the end and would pile up in %TEMP%.
        let dir = std::env::temp_dir().join("kriti-logging-test");
        let _ = std::fs::remove_dir_all(&dir);
        init(&dir).unwrap();

        tracing::info!("log line from the logging test");

        let log_file = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("kriti.") && name.ends_with(".log"))
            })
            .expect("no kriti.<date>.log file was created");
        let contents = std::fs::read_to_string(log_file).unwrap();
        assert!(contents.contains("log line from the logging test"));
    }
}
