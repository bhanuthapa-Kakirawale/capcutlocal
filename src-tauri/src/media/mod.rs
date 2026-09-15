//! Import orchestration: fingerprint → probe (cache-hit fast path) → classify, plus
//! artifact generation (docs/MEDIA-PIPELINE.md §2, §4). This is the one module that ties
//! `ffmpeg`, `db`, and `cache` together.

mod fingerprint;
mod poster;

pub use fingerprint::{FingerprintDto, fingerprint};
pub use poster::generate_poster;

use std::path::Path;

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::db::{Db, MediaRow};
use crate::error::AppError;
use crate::ffmpeg::{MediaInfoDto, MediaKind};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMedia {
    pub path: String,
    pub kind: MediaKind,
    /// A reasonable display name (the file stem); the caller may let the user rename it.
    pub suggested_name: String,
    pub fingerprint: FingerprintDto,
    pub info: MediaInfoDto,
}

/// A file kind is fully determined by which part of its `MediaInfoDto` is populated, so a
/// cache-hit reuse never needs to re-run (or separately store) classification.
fn kind_of(info: &MediaInfoDto) -> MediaKind {
    if info.image.is_some() {
        MediaKind::Image
    } else if info.video.is_some() {
        MediaKind::Video
    } else {
        MediaKind::Audio
    }
}

/// Fingerprints and probes one file, reusing a cached probe when the fingerprint is
/// already known (docs/MEDIA-PIPELINE.md §2.1). A failure here is per-file — the caller
/// (the `media_import` command) continues with the rest of a batch regardless.
pub async fn import_one(
    path: &Path,
    db: &Db,
    cancellation: &CancellationToken,
) -> Result<ImportedMedia, AppError> {
    let fp = fingerprint(path).await?;

    let info: MediaInfoDto = match db.get_media(&fp.sample_hash)? {
        Some(row) if row.size_bytes == fp.size_bytes => serde_json::from_str(&row.info_json)
            .map_err(|error| AppError::internal(format!("corrupt media cache row: {error}")))?,
        _ => {
            let probed_info = crate::ffmpeg::probe(path, cancellation).await?;
            let info_json = serde_json::to_string(&probed_info).map_err(|error| {
                AppError::internal(format!("could not cache probe result: {error}"))
            })?;
            db.upsert_media(&MediaRow {
                fingerprint: fp.sample_hash.clone(),
                size_bytes: fp.size_bytes,
                sample_hash: fp.sample_hash.clone(),
                info_json,
                probed_with: probed_info.probed_with.clone(),
                last_seen_path: path.display().to_string(),
                updated_at_ms: crate::db::now_ms(),
            })?;
            probed_info
        }
    };

    let suggested_name = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());

    Ok(ImportedMedia {
        path: path.display().to_string(),
        kind: kind_of(&info),
        suggested_name,
        fingerprint: fp.into(),
        info,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::{ImageInfoDto, VideoStreamInfoDto};

    fn image_info() -> MediaInfoDto {
        MediaInfoDto {
            container: "png_pipe".to_owned(),
            duration_flicks: 0,
            size_bytes: 10,
            bit_rate: None,
            video: None,
            audio: Vec::new(),
            image: Some(ImageInfoDto {
                width: 10,
                height: 10,
                has_alpha: false,
            }),
            probed_with: "test".to_owned(),
        }
    }

    fn video_info() -> MediaInfoDto {
        MediaInfoDto {
            container: "mov,mp4,m4a,3gp,3g2,mj2".to_owned(),
            duration_flicks: 705_600_000,
            size_bytes: 10,
            bit_rate: None,
            video: Some(VideoStreamInfoDto {
                stream_index: 0,
                codec: "h264".to_owned(),
                profile: None,
                width: 10,
                height: 10,
                sample_aspect_ratio: crate::ffmpeg::RationalDto { num: 1, den: 1 },
                rotation: 0,
                frame_rate: crate::ffmpeg::RationalDto { num: 30, den: 1 },
                avg_frame_rate: crate::ffmpeg::RationalDto { num: 30, den: 1 },
                is_variable_frame_rate: false,
                pixel_format: "yuv420p".to_owned(),
                bit_depth: 8,
                color_primaries: None,
                color_transfer: None,
                color_space: None,
                color_range: None,
                is_hdr: false,
                has_alpha: false,
                start_offset_flicks: 0,
                duration_flicks: 705_600_000,
            }),
            audio: Vec::new(),
            image: None,
            probed_with: "test".to_owned(),
        }
    }

    #[test]
    fn kind_of_prefers_image_then_video_then_audio() {
        assert_eq!(kind_of(&image_info()), MediaKind::Image);
        assert_eq!(kind_of(&video_info()), MediaKind::Video);
        let mut audio_only = video_info();
        audio_only.video = None;
        assert_eq!(kind_of(&audio_only), MediaKind::Audio);
    }

    #[tokio::test]
    async fn import_one_reuses_a_cached_probe_without_calling_ffmpeg() {
        let dir = std::env::temp_dir().join(format!("kriti-import-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("clip.mp4");
        std::fs::write(
            &path,
            b"not real media, but only the cache path is exercised here",
        )
        .unwrap();

        let db = Db::open_in_memory();
        let fp = fingerprint(&path).await.unwrap();
        db.upsert_media(&MediaRow {
            fingerprint: fp.sample_hash.clone(),
            size_bytes: fp.size_bytes,
            sample_hash: fp.sample_hash.clone(),
            info_json: serde_json::to_string(&video_info()).unwrap(),
            probed_with: "test".to_owned(),
            last_seen_path: path.display().to_string(),
            updated_at_ms: 0,
        })
        .unwrap();

        // No real ffmpeg on PATH is required here: a cache hit never invokes it.
        let imported = import_one(&path, &db, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(imported.kind, MediaKind::Video);
        assert_eq!(imported.suggested_name, "clip");
    }
}
