//! The probe cache: fingerprint → probed media info, shared across projects
//! (docs/MEDIA-PIPELINE.md §2.1, §6.3). A cache hit means a re-imported or duplicate
//! file skips ffprobe entirely.

use rusqlite::{OptionalExtension, params};

use super::{Db, map_sqlite_error};
use crate::error::AppError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaRow {
    pub fingerprint: String,
    pub size_bytes: u64,
    pub sample_hash: String,
    /// The probed `MediaInfoDto`, serialized as JSON (the `media` module owns decoding it —
    /// this layer only stores and retrieves bytes, matching ADR-002's "Rust is not the
    /// schema owner" spirit even for its own internal cache).
    pub info_json: String,
    pub probed_with: String,
    pub last_seen_path: String,
    pub updated_at_ms: i64,
}

impl Db {
    pub fn get_media(&self, fingerprint: &str) -> Result<Option<MediaRow>, AppError> {
        self.lock()
            .query_row(
                "SELECT fingerprint, size_bytes, sample_hash, info_json, probed_with, last_seen_path, updated_at_ms
                 FROM media WHERE fingerprint = ?1",
                params![fingerprint],
                |row| {
                    Ok(MediaRow {
                        fingerprint: row.get(0)?,
                        size_bytes: row.get(1)?,
                        sample_hash: row.get(2)?,
                        info_json: row.get(3)?,
                        probed_with: row.get(4)?,
                        last_seen_path: row.get(5)?,
                        updated_at_ms: row.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(map_sqlite_error)
    }

    pub fn upsert_media(&self, row: &MediaRow) -> Result<(), AppError> {
        self.lock()
            .execute(
                "INSERT INTO media (fingerprint, size_bytes, sample_hash, info_json, probed_with, last_seen_path, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(fingerprint) DO UPDATE SET
                     size_bytes = excluded.size_bytes,
                     sample_hash = excluded.sample_hash,
                     info_json = excluded.info_json,
                     probed_with = excluded.probed_with,
                     last_seen_path = excluded.last_seen_path,
                     updated_at_ms = excluded.updated_at_ms",
                params![
                    row.fingerprint,
                    row.size_bytes,
                    row.sample_hash,
                    row.info_json,
                    row.probed_with,
                    row.last_seen_path,
                    row.updated_at_ms
                ],
            )
            .map_err(map_sqlite_error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(fingerprint: &str) -> MediaRow {
        MediaRow {
            fingerprint: fingerprint.to_owned(),
            size_bytes: 100,
            sample_hash: "abc".to_owned(),
            info_json: "{\"container\":\"mp4\"}".to_owned(),
            probed_with: "ffprobe-test".to_owned(),
            last_seen_path: "C:/media/a.mp4".to_owned(),
            updated_at_ms: 1000,
        }
    }

    #[test]
    fn get_media_returns_none_when_absent() {
        let db = Db::open_in_memory();
        assert_eq!(db.get_media("missing").unwrap(), None);
    }

    #[test]
    fn upsert_then_get_round_trips() {
        let db = Db::open_in_memory();
        db.upsert_media(&row("fp1")).unwrap();
        assert_eq!(db.get_media("fp1").unwrap(), Some(row("fp1")));
    }

    #[test]
    fn upsert_replaces_the_existing_row_for_the_same_fingerprint() {
        let db = Db::open_in_memory();
        db.upsert_media(&row("fp1")).unwrap();
        let mut updated = row("fp1");
        updated.last_seen_path = "D:/moved/a.mp4".to_owned();
        updated.updated_at_ms = 2000;
        db.upsert_media(&updated).unwrap();

        let fetched = db.get_media("fp1").unwrap().unwrap();
        assert_eq!(fetched.last_seen_path, "D:/moved/a.mp4");
        assert_eq!(fetched.updated_at_ms, 2000);
    }
}
