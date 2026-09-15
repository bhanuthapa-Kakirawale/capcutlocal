//! Poster thumbnails: one frame at 10% of duration, scaled to 320px wide, JPEG
//! (docs/MEDIA-PIPELINE.md §4). The first artifact generator — everything else in the
//! cache/db plumbing was built to support this.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::cache::{ArtifactKind, Cache};
use crate::db::{ArtifactRow, Db, artifact_key};
use crate::error::{AppError, ErrorCode};
use crate::ffmpeg::FLICKS_PER_SECOND;

const POSTER_TIMEOUT: Duration = Duration::from_secs(30);

/// Returns the poster's path, generating and caching it first if needed. `duration_flicks`
/// of 0 or less (e.g. malformed media) falls back to the very first frame.
pub async fn generate_poster(
    path: &Path,
    fingerprint: &str,
    duration_flicks: i64,
    cache: &Cache,
    db: &Db,
    cancellation: &CancellationToken,
) -> Result<PathBuf, AppError> {
    let kind = ArtifactKind::Poster;
    let key = artifact_key(fingerprint, kind.as_str(), "", kind.generator_version());

    if let Some(row) = db.get_artifact(&key)? {
        db.touch_artifact(&key, crate::db::now_ms())?;
        return Ok(cache.root().join(&row.rel_path));
    }

    let final_path = cache.artifact_path(kind, fingerprint, "");
    let seek_seconds = if duration_flicks > 0 {
        0.1 * (duration_flicks as f64 / FLICKS_PER_SECOND)
    } else {
        0.0
    };
    let seek_arg = format!("{seek_seconds:.3}");

    let bins = crate::ffmpeg::binaries().await?;
    let args: Vec<&OsStr> = vec![
        OsStr::new("-ss"),
        OsStr::new(&seek_arg),
        OsStr::new("-i"),
        path.as_os_str(),
        OsStr::new("-frames:v"),
        OsStr::new("1"),
        OsStr::new("-vf"),
        OsStr::new("scale=320:-2:flags=lanczos"),
        OsStr::new("-f"),
        OsStr::new("image2"),
        OsStr::new("-c:v"),
        OsStr::new("mjpeg"),
        OsStr::new("pipe:1"),
    ];
    let output = crate::ffmpeg::run(&bins.ffmpeg, &args, POSTER_TIMEOUT, cancellation).await?;
    if output.stdout.is_empty() {
        return Err(AppError::new(
            ErrorCode::FfmpegFailed,
            "poster generation produced no image data",
        ));
    }

    cache.write_artifact(&final_path, &output.stdout).await?;

    let rel_path = final_path
        .strip_prefix(cache.root())
        .unwrap_or(&final_path)
        .to_string_lossy()
        .replace('\\', "/");
    let now = crate::db::now_ms();
    db.upsert_artifact(&ArtifactRow {
        key,
        fingerprint: fingerprint.to_owned(),
        kind: kind.as_str().to_owned(),
        variant: String::new(),
        generator_version: kind.generator_version(),
        rel_path,
        bytes: output.stdout.len() as u64,
        created_at_ms: now,
        last_access_at_ms: now,
    })?;

    // Best-effort: staying within budget matters, but must never fail the import that
    // just produced this poster.
    if let Err(error) = cache
        .evict_to_budget(db, kind, kind.default_budget_bytes(), &[])
        .await
    {
        tracing::warn!(%error, "poster cache eviction failed");
    }

    Ok(final_path)
}

#[cfg(all(test, feature = "media-tests"))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn generates_and_then_reuses_a_cached_poster() {
        let dir = std::env::temp_dir().join(format!("kriti-poster-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let video_path = dir.join("video.mp4");
        let status = std::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x240:duration=1:rate=30",
            ])
            .args(["-pix_fmt", "yuv420p", video_path.to_str().unwrap()])
            .status()
            .expect("ffmpeg must be on PATH to run media-tests");
        assert!(status.success());

        let cache = Cache::new(dir.join("cache"));
        let db = Db::open_in_memory();
        let token = CancellationToken::new();

        let first = generate_poster(&video_path, "fp1", 705_600_000, &cache, &db, &token)
            .await
            .unwrap();
        assert!(tokio::fs::metadata(&first).await.is_ok());
        let bytes_on_disk = tokio::fs::read(&first).await.unwrap();
        assert!(!bytes_on_disk.is_empty());

        // Second call must not re-invoke ffmpeg: delete the source so a re-generation
        // attempt would fail, and confirm the cached path is returned successfully anyway.
        std::fs::remove_file(&video_path).unwrap();
        let second = generate_poster(&video_path, "fp1", 705_600_000, &cache, &db, &token)
            .await
            .unwrap();
        assert_eq!(first, second);
    }
}
