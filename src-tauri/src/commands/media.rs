//! Media import, artifact generation, job control, and FFmpeg diagnostics
//! (docs/ARCHITECTURE.md §5.1, docs/MEDIA-PIPELINE.md §7-8).

use serde::Serialize;
use tauri::State;

use crate::cache::Cache;
use crate::db::Db;
use crate::error::AppError;
use crate::jobs::{JobScheduler, ResourceClass};
use crate::media::ImportedMedia;

/// One `media_import` result per requested path. A failure here is local to that file —
/// the rest of the batch still completes (docs/MEDIA-PIPELINE.md §2.1).
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ImportOutcome {
    #[serde(rename_all = "camelCase")]
    Imported {
        // Boxed: `ImportedMedia` carries a full `MediaInfoDto`, far larger than `Failed`'s
        // fields — without this every `ImportOutcome` pays for the largest variant.
        #[serde(flatten)]
        media: Box<ImportedMedia>,
    },
    #[serde(rename_all = "camelCase")]
    Failed { path: String, error: AppError },
}

#[tauri::command]
pub async fn media_import(
    db: State<'_, Db>,
    scheduler: State<'_, JobScheduler>,
    paths: Vec<String>,
) -> Result<Vec<ImportOutcome>, AppError> {
    let mut outcomes = Vec::with_capacity(paths.len());
    for path_str in paths {
        let path = std::path::PathBuf::from(&path_str);
        let (job_id, token) = scheduler.begin_job("import");
        let _permit = scheduler.acquire(ResourceClass::Probe).await;
        let result = crate::media::import_one(&path, &db, &token).await;
        scheduler.finish_job(
            &job_id,
            "import",
            &result.as_ref().map(|_| ()).map_err(Clone::clone),
        );

        outcomes.push(match result {
            Ok(media) => ImportOutcome::Imported {
                media: Box::new(media),
            },
            Err(error) => ImportOutcome::Failed {
                path: path_str,
                error,
            },
        });
    }
    Ok(outcomes)
}

/// Generates (or reuses a cached) poster for one asset. Called per grid item by the
/// media browser without blocking import, so posters stream in as they're ready
/// (docs/MEDIA-PIPELINE.md §4). Returns an absolute file path; the frontend loads it
/// through the asset protocol (scoped to the cache directory).
#[tauri::command]
pub async fn media_generate_poster(
    cache: State<'_, Cache>,
    db: State<'_, Db>,
    scheduler: State<'_, JobScheduler>,
    path: String,
    fingerprint: String,
    duration_flicks: i64,
) -> Result<String, AppError> {
    let (job_id, token) = scheduler.begin_job("poster");
    let _permit = scheduler.acquire(ResourceClass::Light).await;
    let result = crate::media::generate_poster(
        std::path::Path::new(&path),
        &fingerprint,
        duration_flicks,
        &cache,
        &db,
        &token,
    )
    .await;
    scheduler.finish_job(
        &job_id,
        "poster",
        &result.as_ref().map(|_| ()).map_err(Clone::clone),
    );
    result.map(|p| p.display().to_string())
}

/// Cancels a running job. `false` means it had already finished (or the id was unknown) —
/// not an error (docs/MEDIA-PIPELINE.md §7).
#[tauri::command]
pub async fn job_cancel(
    scheduler: State<'_, JobScheduler>,
    job_id: String,
) -> Result<bool, AppError> {
    Ok(scheduler.cancel_job(&job_id))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegDiagnostics {
    pub available: bool,
    pub ffmpeg_version: Option<String>,
    pub ffprobe_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// For Settings → Diagnostics (docs/MEDIA-PIPELINE.md §1.1). Never itself fails: an
/// unavailable FFmpeg is a normal, displayable result, not a command error.
#[tauri::command]
pub async fn ffmpeg_diagnostics() -> Result<FfmpegDiagnostics, AppError> {
    Ok(match crate::ffmpeg::binaries().await {
        Ok(bins) => FfmpegDiagnostics {
            available: true,
            ffmpeg_version: Some(bins.ffmpeg_version),
            ffprobe_version: Some(bins.ffprobe_version),
            error: None,
        },
        Err(error) => FfmpegDiagnostics {
            available: false,
            ffmpeg_version: None,
            ffprobe_version: None,
            error: Some(error.message),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::ffmpeg::{
        AudioStreamInfoDto, MediaInfoDto, MediaKind, RationalDto, VideoStreamInfoDto,
    };
    use crate::media::{FingerprintDto, ImportedMedia};
    use crate::test_support::assert_matches_fixture;

    fn sample_media_info() -> MediaInfoDto {
        MediaInfoDto {
            container: "mov,mp4,m4a,3gp,3g2,mj2".to_owned(),
            duration_flicks: 705_600_000,
            size_bytes: 1_000_000,
            bit_rate: Some(5_000_000),
            video: Some(VideoStreamInfoDto {
                stream_index: 0,
                codec: "h264".to_owned(),
                profile: Some("High".to_owned()),
                width: 1920,
                height: 1080,
                sample_aspect_ratio: RationalDto { num: 1, den: 1 },
                rotation: 0,
                frame_rate: RationalDto { num: 30, den: 1 },
                avg_frame_rate: RationalDto { num: 30, den: 1 },
                is_variable_frame_rate: false,
                pixel_format: "yuv420p".to_owned(),
                bit_depth: 8,
                color_primaries: Some("bt709".to_owned()),
                color_transfer: Some("bt709".to_owned()),
                color_space: Some("bt709".to_owned()),
                color_range: Some("tv".to_owned()),
                is_hdr: false,
                has_alpha: false,
                start_offset_flicks: 0,
                duration_flicks: 705_600_000,
            }),
            audio: vec![AudioStreamInfoDto {
                stream_index: 1,
                codec: "aac".to_owned(),
                sample_rate: 48000,
                channels: 2,
                channel_layout: Some("stereo".to_owned()),
                language: None,
                start_offset_flicks: 0,
                duration_flicks: 705_600_000,
            }],
            image: None,
            probed_with: "ffprobe-test".to_owned(),
        }
    }

    #[test]
    fn import_outcome_imported_serializes_to_the_contract_fixture() {
        let outcome = ImportOutcome::Imported {
            media: Box::new(ImportedMedia {
                path: r"C:\Media\clip.mp4".to_owned(),
                kind: MediaKind::Video,
                suggested_name: "clip".to_owned(),
                fingerprint: FingerprintDto {
                    size_bytes: 1_000_000,
                    modified_ms: 1_757_800_000_000,
                    sample_hash: "3fa2b1c0".to_owned(),
                },
                info: sample_media_info(),
            }),
        };
        assert_matches_fixture("import_outcome_imported.json", &outcome);
    }

    #[test]
    fn import_outcome_failed_serializes_to_the_contract_fixture() {
        let outcome = ImportOutcome::Failed {
            path: r"C:\Media\broken.mov".to_owned(),
            error: AppError::new(
                ErrorCode::FfmpegFailed,
                "ffprobe exited with a non-zero status",
            ),
        };
        assert_matches_fixture("import_outcome_failed.json", &outcome);
    }

    #[test]
    fn ffmpeg_diagnostics_available_serializes_to_the_contract_fixture() {
        let diagnostics = FfmpegDiagnostics {
            available: true,
            ffmpeg_version: Some("7.1".to_owned()),
            ffprobe_version: Some("7.1".to_owned()),
            error: None,
        };
        assert_matches_fixture("ffmpeg_diagnostics.json", &diagnostics);
    }
}
