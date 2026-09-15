//! The cache-artifact index: what's on disk, its generator version, and when it was last
//! used — the basis for reconciliation and LRU eviction (docs/MEDIA-PIPELINE.md §6.3-6.4).
//! A row exists only for an artifact that finished writing successfully (the cache module
//! inserts it *after* the atomic rename into place), so there is no in-progress state to track.

use rusqlite::{OptionalExtension, params};

use super::{Db, map_sqlite_error};
use crate::error::AppError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactRow {
    /// `(fingerprint, kind, variant, generatorVersion)`, joined with `|` — see `artifact_key`.
    pub key: String,
    pub fingerprint: String,
    pub kind: String,
    pub variant: String,
    pub generator_version: u32,
    /// Relative to the cache root, so relocating the cache never invalidates the index.
    pub rel_path: String,
    pub bytes: u64,
    pub created_at_ms: i64,
    pub last_access_at_ms: i64,
}

/// The artifact key is `(fingerprint, kind, variant, generatorVersion)`
/// (docs/MEDIA-PIPELINE.md §6.2); this is its canonical string form.
pub fn artifact_key(
    fingerprint: &str,
    kind: &str,
    variant: &str,
    generator_version: u32,
) -> String {
    format!("{fingerprint}|{kind}|{variant}|{generator_version}")
}

impl Db {
    pub fn get_artifact(&self, key: &str) -> Result<Option<ArtifactRow>, AppError> {
        self.lock()
            .query_row(
                "SELECT key, fingerprint, kind, variant, generator_version, rel_path, bytes, created_at_ms, last_access_at_ms
                 FROM artifacts WHERE key = ?1",
                params![key],
                Self::row_to_artifact,
            )
            .optional()
            .map_err(map_sqlite_error)
    }

    pub fn upsert_artifact(&self, row: &ArtifactRow) -> Result<(), AppError> {
        self.lock()
            .execute(
                "INSERT INTO artifacts (key, fingerprint, kind, variant, generator_version, rel_path, bytes, created_at_ms, last_access_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(key) DO UPDATE SET
                     rel_path = excluded.rel_path,
                     bytes = excluded.bytes,
                     last_access_at_ms = excluded.last_access_at_ms",
                params![
                    row.key,
                    row.fingerprint,
                    row.kind,
                    row.variant,
                    row.generator_version,
                    row.rel_path,
                    row.bytes,
                    row.created_at_ms,
                    row.last_access_at_ms
                ],
            )
            .map_err(map_sqlite_error)?;
        Ok(())
    }

    pub fn touch_artifact(&self, key: &str, at_ms: i64) -> Result<(), AppError> {
        self.lock()
            .execute(
                "UPDATE artifacts SET last_access_at_ms = ?1 WHERE key = ?2",
                params![at_ms, key],
            )
            .map_err(map_sqlite_error)?;
        Ok(())
    }

    pub fn delete_artifact(&self, key: &str) -> Result<(), AppError> {
        self.lock()
            .execute("DELETE FROM artifacts WHERE key = ?1", params![key])
            .map_err(map_sqlite_error)?;
        Ok(())
    }

    /// All artifact rows, for startup reconciliation (docs/MEDIA-PIPELINE.md §6.4).
    pub fn all_artifacts(&self) -> Result<Vec<ArtifactRow>, AppError> {
        let conn = self.lock();
        let mut statement = conn
            .prepare(
                "SELECT key, fingerprint, kind, variant, generator_version, rel_path, bytes, created_at_ms, last_access_at_ms
                 FROM artifacts",
            )
            .map_err(map_sqlite_error)?;
        let rows = statement
            .query_map([], Self::row_to_artifact)
            .map_err(map_sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(map_sqlite_error)?;
        Ok(rows)
    }

    /// Artifacts of `kind`, least-recently-used first — eviction order (docs/MEDIA-PIPELINE.md §6.4).
    pub fn artifacts_by_kind_lru(&self, kind: &str) -> Result<Vec<ArtifactRow>, AppError> {
        let conn = self.lock();
        let mut statement = conn
            .prepare(
                "SELECT key, fingerprint, kind, variant, generator_version, rel_path, bytes, created_at_ms, last_access_at_ms
                 FROM artifacts WHERE kind = ?1 ORDER BY last_access_at_ms ASC",
            )
            .map_err(map_sqlite_error)?;
        let rows = statement
            .query_map(params![kind], Self::row_to_artifact)
            .map_err(map_sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(map_sqlite_error)?;
        Ok(rows)
    }

    pub fn total_bytes_for_kind(&self, kind: &str) -> Result<u64, AppError> {
        self.lock()
            .query_row(
                "SELECT COALESCE(SUM(bytes), 0) FROM artifacts WHERE kind = ?1",
                params![kind],
                |row| row.get(0),
            )
            .map_err(map_sqlite_error)
    }

    fn row_to_artifact(row: &rusqlite::Row) -> rusqlite::Result<ArtifactRow> {
        Ok(ArtifactRow {
            key: row.get(0)?,
            fingerprint: row.get(1)?,
            kind: row.get(2)?,
            variant: row.get(3)?,
            generator_version: row.get(4)?,
            rel_path: row.get(5)?,
            bytes: row.get(6)?,
            created_at_ms: row.get(7)?,
            last_access_at_ms: row.get(8)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(key: &str, kind: &str, bytes: u64, last_access_at_ms: i64) -> ArtifactRow {
        ArtifactRow {
            key: key.to_owned(),
            fingerprint: "fp1".to_owned(),
            kind: kind.to_owned(),
            variant: "default".to_owned(),
            generator_version: 1,
            rel_path: format!("thumbs/{key}.jpg"),
            bytes,
            created_at_ms: 0,
            last_access_at_ms,
        }
    }

    #[test]
    fn artifact_key_is_stable_and_distinguishes_its_parts() {
        assert_eq!(
            artifact_key("fp", "poster", "default", 1),
            "fp|poster|default|1"
        );
        assert_ne!(
            artifact_key("fp", "poster", "default", 1),
            artifact_key("fp", "poster", "default", 2)
        );
    }

    #[test]
    fn upsert_then_get_round_trips() {
        let db = Db::open_in_memory();
        db.upsert_artifact(&row("k1", "poster", 100, 5)).unwrap();
        assert_eq!(
            db.get_artifact("k1").unwrap(),
            Some(row("k1", "poster", 100, 5))
        );
    }

    #[test]
    fn get_artifact_returns_none_when_absent() {
        let db = Db::open_in_memory();
        assert_eq!(db.get_artifact("missing").unwrap(), None);
    }

    #[test]
    fn touch_artifact_updates_last_access_only() {
        let db = Db::open_in_memory();
        db.upsert_artifact(&row("k1", "poster", 100, 5)).unwrap();
        db.touch_artifact("k1", 999).unwrap();
        let fetched = db.get_artifact("k1").unwrap().unwrap();
        assert_eq!(fetched.last_access_at_ms, 999);
        assert_eq!(fetched.bytes, 100);
    }

    #[test]
    fn delete_artifact_removes_the_row() {
        let db = Db::open_in_memory();
        db.upsert_artifact(&row("k1", "poster", 100, 5)).unwrap();
        db.delete_artifact("k1").unwrap();
        assert_eq!(db.get_artifact("k1").unwrap(), None);
    }

    #[test]
    fn artifacts_by_kind_lru_orders_oldest_access_first_and_filters_by_kind() {
        let db = Db::open_in_memory();
        db.upsert_artifact(&row("newest", "poster", 10, 300))
            .unwrap();
        db.upsert_artifact(&row("oldest", "poster", 10, 100))
            .unwrap();
        db.upsert_artifact(&row("middle", "poster", 10, 200))
            .unwrap();
        db.upsert_artifact(&row("other-kind", "waveform", 10, 50))
            .unwrap();

        let ordered = db.artifacts_by_kind_lru("poster").unwrap();
        let keys: Vec<&str> = ordered.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(keys, vec!["oldest", "middle", "newest"]);
    }

    #[test]
    fn total_bytes_for_kind_sums_only_that_kind() {
        let db = Db::open_in_memory();
        db.upsert_artifact(&row("a", "poster", 100, 1)).unwrap();
        db.upsert_artifact(&row("b", "poster", 50, 2)).unwrap();
        db.upsert_artifact(&row("c", "waveform", 999, 3)).unwrap();
        assert_eq!(db.total_bytes_for_kind("poster").unwrap(), 150);
    }

    #[test]
    fn all_artifacts_returns_every_row() {
        let db = Db::open_in_memory();
        db.upsert_artifact(&row("a", "poster", 100, 1)).unwrap();
        db.upsert_artifact(&row("b", "waveform", 50, 2)).unwrap();
        assert_eq!(db.all_artifacts().unwrap().len(), 2);
    }
}
