//! `library.db`: the probe cache and cache-artifact index, shared across every project
//! (ADR-006, docs/MEDIA-PIPELINE.md §6.3). One connection behind a mutex — SQLite
//! serializes writes internally anyway, and every query here is tiny.

mod artifacts;
mod media;

pub use artifacts::{ArtifactRow, artifact_key};
pub use media::MediaRow;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

use crate::error::AppError;

pub struct Db {
    conn: Mutex<Connection>,
}

/// Schema migrations, applied in order and tracked via `PRAGMA user_version`
/// (docs/PROJECT-MODEL.md §5.4's migration pattern, mirrored here for the cache DB).
const MIGRATIONS: &[&str] = &[r#"
    CREATE TABLE media (
        fingerprint TEXT PRIMARY KEY,
        size_bytes INTEGER NOT NULL,
        sample_hash TEXT NOT NULL,
        info_json TEXT NOT NULL,
        probed_with TEXT NOT NULL,
        last_seen_path TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE artifacts (
        key TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        kind TEXT NOT NULL,
        variant TEXT NOT NULL,
        generator_version INTEGER NOT NULL,
        rel_path TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        last_access_at_ms INTEGER NOT NULL
    );
    CREATE INDEX artifacts_fingerprint_idx ON artifacts(fingerprint);
    CREATE INDEX artifacts_kind_access_idx ON artifacts(kind, last_access_at_ms);
"#];

impl Db {
    pub fn open(path: &Path) -> Result<Self, AppError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::from_io_error("creating the library.db folder", &e))?;
        }
        let conn = Connection::open(path).map_err(map_sqlite_error)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(map_sqlite_error)?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("in-memory sqlite connection");
        migrate(&conn).expect("migrations");
        Self {
            conn: Mutex::new(conn),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn migrate(conn: &Connection) -> Result<(), AppError> {
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(map_sqlite_error)?;
    let current = usize::try_from(current).unwrap_or(0);
    for (index, migration) in MIGRATIONS.iter().enumerate().skip(current) {
        conn.execute_batch(migration).map_err(map_sqlite_error)?;
        let version = i64::try_from(index + 1).unwrap_or(i64::MAX);
        conn.pragma_update(None, "user_version", version)
            .map_err(map_sqlite_error)?;
    }
    Ok(())
}

pub(crate) fn map_sqlite_error(error: rusqlite::Error) -> AppError {
    AppError::internal(format!("library.db: {error}"))
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_in_memory_creates_the_schema_and_is_idempotent_on_reopen() {
        let db = Db::open_in_memory();
        let conn = db.lock();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
    }

    #[test]
    fn open_creates_the_parent_directory_and_reopens_the_same_file() {
        let dir = std::env::temp_dir().join(format!("kriti-db-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("nested").join("library.db");

        {
            let db = Db::open(&path).unwrap();
            db.upsert_media(&MediaRow {
                fingerprint: "fp1".to_owned(),
                size_bytes: 10,
                sample_hash: "hash".to_owned(),
                info_json: "{}".to_owned(),
                probed_with: "test".to_owned(),
                last_seen_path: "C:/a".to_owned(),
                updated_at_ms: 1,
            })
            .unwrap();
        }
        let reopened = Db::open(&path).unwrap();
        assert!(reopened.get_media("fp1").unwrap().is_some());
    }
}
