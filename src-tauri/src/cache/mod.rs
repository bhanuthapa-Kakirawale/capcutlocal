//! Derived-artifact cache: layout, atomic writes, startup reconciliation, and LRU
//! eviction (docs/MEDIA-PIPELINE.md §6). Everything here is regenerable — losing the
//! whole cache directory costs time, never correctness.
//!
//! The OS-level free-space guard described in docs/MEDIA-PIPELINE.md §6.4 (refuse a
//! heavy job below 5 GB free) is not implemented yet: it is the one piece of this module
//! that would need a disk-space API, and nothing in Phase 3 has hit it in practice. When
//! it is added, it needs its own `ErrorCode` variant in `error.rs` (and `DISK_LOW` in
//! `src/ipc/contracts.ts`) — not added ahead of time to avoid an unused error code.

use std::path::{Path, PathBuf};

use crate::db::Db;
use crate::error::AppError;

const TMP_DIR_NAME: &str = "tmp";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactKind {
    Poster,
    Filmstrip,
    Waveform,
}

impl ArtifactKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Poster => "poster",
            Self::Filmstrip => "filmstrip",
            Self::Waveform => "waveform",
        }
    }

    fn dir_name(self) -> &'static str {
        match self {
            Self::Poster => "thumbs",
            Self::Filmstrip => "filmstrips",
            Self::Waveform => "waveforms",
        }
    }

    /// Bumping this invalidates every existing artifact of this kind
    /// (docs/MEDIA-PIPELINE.md §6.2) — there is nothing to bump to yet.
    pub fn generator_version(self) -> u32 {
        1
    }

    /// Default per-kind budget in bytes (docs/MEDIA-PIPELINE.md §6.4).
    pub fn default_budget_bytes(self) -> u64 {
        match self {
            Self::Poster | Self::Filmstrip => 2 * 1024 * 1024 * 1024,
            Self::Waveform => 1024 * 1024 * 1024,
        }
    }
}

pub struct Cache {
    root: PathBuf,
}

impl Cache {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// First two characters of the fingerprint, keeping any one directory small
    /// (docs/MEDIA-PIPELINE.md §6.2).
    fn shard(fingerprint: &str) -> &str {
        let end = fingerprint
            .char_indices()
            .nth(2)
            .map(|(index, _)| index)
            .unwrap_or(fingerprint.len());
        &fingerprint[..end]
    }

    /// Where an artifact for `(kind, fingerprint, variant)` lives, whether or not it
    /// exists yet. `variant` distinguishes multiple artifacts of the same kind for one
    /// fingerprint (e.g. a waveform's stream index); pass `""` when there is only one.
    pub fn artifact_path(&self, kind: ArtifactKind, fingerprint: &str, variant: &str) -> PathBuf {
        let file_stem = if variant.is_empty() {
            format!(
                "{fingerprint}-{}-v{}",
                kind.as_str(),
                kind.generator_version()
            )
        } else {
            format!("{fingerprint}-{variant}-v{}", kind.generator_version())
        };
        let extension = match kind {
            ArtifactKind::Poster => "jpg",
            ArtifactKind::Filmstrip => "json", // an index; sheet images sit alongside it
            ArtifactKind::Waveform => "peaks",
        };
        self.root
            .join(kind.dir_name())
            .join(Self::shard(fingerprint))
            .join(format!("{file_stem}.{extension}"))
    }

    fn tmp_dir(&self) -> PathBuf {
        self.root.join(TMP_DIR_NAME)
    }

    /// Writes `bytes` to a temp file under the cache root, then renames it into place
    /// atomically (docs/MEDIA-PIPELINE.md §6.4) — a reader never sees a partial artifact.
    pub async fn write_artifact(&self, final_path: &Path, bytes: &[u8]) -> Result<(), AppError> {
        let tmp_dir = self.tmp_dir();
        tokio::fs::create_dir_all(&tmp_dir)
            .await
            .map_err(|e| AppError::from_io_error("creating the cache tmp folder", &e))?;
        if let Some(parent) = final_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| AppError::from_io_error("creating the cache folder", &e))?;
        }
        let tmp_path = tmp_dir.join(uuid::Uuid::new_v4().to_string());
        tokio::fs::write(&tmp_path, bytes)
            .await
            .map_err(|e| AppError::from_io_error("writing a cache artifact", &e))?;
        tokio::fs::rename(&tmp_path, final_path)
            .await
            .map_err(|e| AppError::from_io_error("moving a cache artifact into place", &e))?;
        Ok(())
    }

    /// Purges `tmp/` (any in-progress write from a killed process), then drops index
    /// rows whose file is missing and deletes files whose index row is missing
    /// (docs/MEDIA-PIPELINE.md §6.4). Returns the number of rows and files removed.
    pub async fn reconcile(&self, db: &Db) -> Result<ReconcileReport, AppError> {
        let _ = tokio::fs::remove_dir_all(self.tmp_dir()).await; // best-effort; absent is fine

        let mut report = ReconcileReport::default();
        let rows = db.all_artifacts()?;
        for row in &rows {
            let path = self.root.join(&row.rel_path);
            if tokio::fs::metadata(&path).await.is_err() {
                db.delete_artifact(&row.key)?;
                report.orphaned_rows_removed += 1;
            }
        }

        let indexed_paths: std::collections::HashSet<&str> =
            rows.iter().map(|row| row.rel_path.as_str()).collect();
        for kind in [
            ArtifactKind::Poster,
            ArtifactKind::Filmstrip,
            ArtifactKind::Waveform,
        ] {
            let dir = self.root.join(kind.dir_name());
            report.orphaned_files_removed +=
                remove_files_without_index_rows(&dir, &self.root, &indexed_paths).await?;
        }

        Ok(report)
    }

    /// Evicts the least-recently-used artifacts of `kind` until its total size is back
    /// under `budget_bytes` (docs/MEDIA-PIPELINE.md §6.4). Never evicts `keep_keys`
    /// (artifacts the currently open project still references).
    pub async fn evict_to_budget(
        &self,
        db: &Db,
        kind: ArtifactKind,
        budget_bytes: u64,
        keep_keys: &[String],
    ) -> Result<u64, AppError> {
        let mut total = db.total_bytes_for_kind(kind.as_str())?;
        let mut evicted_bytes = 0u64;
        if total <= budget_bytes {
            return Ok(0);
        }
        for row in db.artifacts_by_kind_lru(kind.as_str())? {
            if total <= budget_bytes {
                break;
            }
            if keep_keys.contains(&row.key) {
                continue;
            }
            let path = self.root.join(&row.rel_path);
            let _ = tokio::fs::remove_file(&path).await; // best-effort; a missing file is fine
            db.delete_artifact(&row.key)?;
            total = total.saturating_sub(row.bytes);
            evicted_bytes += row.bytes;
        }
        Ok(evicted_bytes)
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ReconcileReport {
    pub orphaned_rows_removed: u32,
    pub orphaned_files_removed: u32,
}

async fn remove_files_without_index_rows(
    dir: &Path,
    cache_root: &Path,
    indexed_paths: &std::collections::HashSet<&str>,
) -> Result<u32, AppError> {
    let mut removed = 0;
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(AppError::from_io_error("reconciling the cache", &error)),
    };
    // Shard subdirectories, one level deep (docs/MEDIA-PIPELINE.md §6.2).
    while let Some(shard) = entries
        .next_entry()
        .await
        .map_err(|e| AppError::from_io_error("reconciling the cache", &e))?
    {
        if !shard.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let mut files = tokio::fs::read_dir(shard.path())
            .await
            .map_err(|e| AppError::from_io_error("reconciling the cache", &e))?;
        while let Some(file) = files
            .next_entry()
            .await
            .map_err(|e| AppError::from_io_error("reconciling the cache", &e))?
        {
            let path = file.path();
            let rel_path = path.strip_prefix(cache_root).unwrap_or(&path);
            let rel_str = rel_path.to_string_lossy().replace('\\', "/");
            if !indexed_paths.contains(rel_str.as_str()) {
                let _ = tokio::fs::remove_file(&path).await;
                removed += 1;
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::ArtifactRow;

    fn temp_cache(name: &str) -> Cache {
        let dir =
            std::env::temp_dir().join(format!("kriti-cache-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Cache::new(dir)
    }

    #[test]
    fn artifact_path_shards_by_the_first_two_fingerprint_characters() {
        let cache = temp_cache("path");
        let path = cache.artifact_path(ArtifactKind::Poster, "ab12cd34", "");
        assert!(path.starts_with(cache.root().join("thumbs").join("ab")));
        assert_eq!(path.extension().unwrap(), "jpg");
    }

    #[test]
    fn artifact_path_is_stable_for_the_same_inputs() {
        let cache = temp_cache("stable");
        let a = cache.artifact_path(ArtifactKind::Waveform, "fp", "stream0");
        let b = cache.artifact_path(ArtifactKind::Waveform, "fp", "stream0");
        assert_eq!(a, b);
        let different_variant = cache.artifact_path(ArtifactKind::Waveform, "fp", "stream1");
        assert_ne!(a, different_variant);
    }

    #[tokio::test]
    async fn write_artifact_leaves_no_tmp_file_and_is_readable_at_the_final_path() {
        let cache = temp_cache("write");
        let path = cache.artifact_path(ArtifactKind::Poster, "fp", "");
        cache.write_artifact(&path, b"jpeg-bytes").await.unwrap();

        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"jpeg-bytes");
        let tmp_entries: Vec<_> = std::fs::read_dir(cache.tmp_dir()).unwrap().collect();
        assert!(tmp_entries.is_empty());
    }

    #[tokio::test]
    async fn reconcile_purges_tmp_and_removes_index_rows_with_no_file() {
        let cache = temp_cache("reconcile-rows");
        let db = Db::open_in_memory();
        tokio::fs::create_dir_all(cache.tmp_dir()).await.unwrap();
        tokio::fs::write(cache.tmp_dir().join("leftover"), b"x")
            .await
            .unwrap();

        db.upsert_artifact(&ArtifactRow {
            key: "k1".to_owned(),
            fingerprint: "fp".to_owned(),
            kind: "poster".to_owned(),
            variant: "".to_owned(),
            generator_version: 1,
            rel_path: "thumbs/fp/missing.jpg".to_owned(),
            bytes: 10,
            created_at_ms: 0,
            last_access_at_ms: 0,
        })
        .unwrap();

        let report = cache.reconcile(&db).await.unwrap();
        assert_eq!(report.orphaned_rows_removed, 1);
        assert!(db.get_artifact("k1").unwrap().is_none());
        assert!(
            !cache.tmp_dir().exists()
                || std::fs::read_dir(cache.tmp_dir()).unwrap().next().is_none()
        );
    }

    #[tokio::test]
    async fn evict_to_budget_removes_least_recently_used_first_and_respects_keep_keys() {
        let cache = temp_cache("evict");
        let db = Db::open_in_memory();
        for (key, access) in [("old", 1), ("mid", 2), ("new", 3)] {
            let path = cache.artifact_path(ArtifactKind::Poster, key, "");
            cache.write_artifact(&path, b"1234567890").await.unwrap(); // 10 bytes
            db.upsert_artifact(&ArtifactRow {
                key: key.to_owned(),
                fingerprint: key.to_owned(),
                kind: "poster".to_owned(),
                variant: "".to_owned(),
                generator_version: 1,
                rel_path: path
                    .strip_prefix(cache.root())
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
                bytes: 10,
                created_at_ms: 0,
                last_access_at_ms: access,
            })
            .unwrap();
        }

        // Budget 15, "mid" protected: evicting just "old" only gets to 20 (still over
        // budget), so "new" must go too, even though it is the most recently used —
        // landing at 10 (just "mid"), the lowest reachable total without evicting it.
        let evicted = cache
            .evict_to_budget(&db, ArtifactKind::Poster, 15, &["mid".to_owned()])
            .await
            .unwrap();
        assert_eq!(evicted, 20);
        assert!(db.get_artifact("old").unwrap().is_none());
        assert!(db.get_artifact("new").unwrap().is_none());
        assert!(db.get_artifact("mid").unwrap().is_some()); // kept despite being older than "new"
    }
}
