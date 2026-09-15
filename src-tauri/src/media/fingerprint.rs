//! Content-based identity: size plus a BLAKE3 hash of the first/middle/last 1 MiB
//! (docs/MEDIA-PIPELINE.md §2.1). Constant-time for any file size, and the same file
//! imported from a different path or drive gets the same fingerprint.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

use crate::error::AppError;

/// Matches docs/PROJECT-MODEL.md §3.1's `Fingerprint` (size, mtime hint, content sample hash).
pub struct Fingerprint {
    pub size_bytes: u64,
    pub modified_ms: u64,
    pub sample_hash: String,
}

/// Mirrors `Fingerprint` in src/domain/model/asset.ts.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FingerprintDto {
    pub size_bytes: u64,
    pub modified_ms: u64,
    pub sample_hash: String,
}

impl From<Fingerprint> for FingerprintDto {
    fn from(fp: Fingerprint) -> Self {
        Self {
            size_bytes: fp.size_bytes,
            modified_ms: fp.modified_ms,
            sample_hash: fp.sample_hash,
        }
    }
}

const SAMPLE_BYTES: u64 = 1024 * 1024;

pub async fn fingerprint(path: &Path) -> Result<Fingerprint, AppError> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|e| AppError::from_io_error("reading file metadata for fingerprinting", &e))?;
    let size_bytes = metadata.len();
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0);

    // Sampled reads are blocking file I/O; run off the async executor's thread.
    let owned_path = path.to_owned();
    let sample_hash =
        tokio::task::spawn_blocking(move || compute_sample_hash(&owned_path, size_bytes))
            .await
            .map_err(|join_error| {
                AppError::internal(format!("fingerprint task panicked: {join_error}"))
            })??;

    Ok(Fingerprint {
        size_bytes,
        modified_ms,
        sample_hash,
    })
}

fn compute_sample_hash(path: &Path, size_bytes: u64) -> Result<String, AppError> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| AppError::from_io_error("reading the file for fingerprinting", &e))?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(&size_bytes.to_le_bytes());

    let sample_len = SAMPLE_BYTES.min(size_bytes);
    let mut buffer = vec![0u8; usize::try_from(sample_len).unwrap_or(0)];
    if buffer.is_empty() {
        return Ok(hasher.finalize().to_hex().to_string());
    }

    read_sample(&mut file, 0, &mut buffer)?;
    hasher.update(&buffer);

    if size_bytes > SAMPLE_BYTES * 2 {
        let middle_offset = size_bytes / 2 - sample_len / 2;
        read_sample(&mut file, middle_offset, &mut buffer)?;
        hasher.update(&buffer);
    }
    if size_bytes > SAMPLE_BYTES {
        let last_offset = size_bytes - sample_len;
        read_sample(&mut file, last_offset, &mut buffer)?;
        hasher.update(&buffer);
    }

    Ok(hasher.finalize().to_hex().to_string())
}

fn read_sample(file: &mut std::fs::File, offset: u64, buffer: &mut [u8]) -> Result<(), AppError> {
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| AppError::from_io_error("seeking to fingerprint sample", &e))?;
    file.read_exact(buffer)
        .map_err(|e| AppError::from_io_error("reading a fingerprint sample", &e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str, contents: &[u8]) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kriti-fingerprint-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[tokio::test]
    async fn same_content_gives_the_same_fingerprint_regardless_of_path() {
        let a = temp_file("a.bin", b"hello world");
        let b = temp_file("b.bin", b"hello world");
        let fp_a = fingerprint(&a).await.unwrap();
        let fp_b = fingerprint(&b).await.unwrap();
        assert_eq!(fp_a.sample_hash, fp_b.sample_hash);
    }

    #[tokio::test]
    async fn different_content_gives_a_different_fingerprint() {
        let a = temp_file("c.bin", b"hello world");
        let b = temp_file("d.bin", b"goodbye world");
        let fp_a = fingerprint(&a).await.unwrap();
        let fp_b = fingerprint(&b).await.unwrap();
        assert_ne!(fp_a.sample_hash, fp_b.sample_hash);
    }

    #[tokio::test]
    async fn handles_an_empty_file() {
        let path = temp_file("empty.bin", b"");
        let fp = fingerprint(&path).await.unwrap();
        assert_eq!(fp.size_bytes, 0);
        assert!(!fp.sample_hash.is_empty());
    }

    #[tokio::test]
    async fn handles_a_file_larger_than_the_sample_window() {
        // 3 MiB: exercises the first, middle, and last sample reads.
        let large = vec![7u8; 3 * 1024 * 1024];
        let path = temp_file("large.bin", &large);
        let fp = fingerprint(&path).await.unwrap();
        assert_eq!(fp.size_bytes, large.len() as u64);
        assert!(!fp.sample_hash.is_empty());
    }
}
