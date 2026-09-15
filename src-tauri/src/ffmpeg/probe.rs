//! ffprobe → `MediaInfoDto`, the Rust mirror of `MediaInfo` in src/domain/model/media.ts
//! (docs/MEDIA-PIPELINE.md §3, ADR-008 — kept honest by shared contract fixtures).

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, ErrorCode};

/// Matches `FLICKS_PER_SECOND` in src/domain/time.ts.
pub const FLICKS_PER_SECOND: f64 = 705_600_000.0;
/// ffprobe rarely takes more than a second or two even on large files (it reads headers,
/// not the whole stream); this is a generous ceiling for the stall watchdog.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Video,
    Audio,
    Image,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RationalDto {
    pub num: i64,
    pub den: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStreamInfoDto {
    pub stream_index: u32,
    pub codec: String,
    pub profile: Option<String>,
    pub width: u32,
    pub height: u32,
    pub sample_aspect_ratio: RationalDto,
    pub rotation: i32,
    pub frame_rate: RationalDto,
    pub avg_frame_rate: RationalDto,
    pub is_variable_frame_rate: bool,
    pub pixel_format: String,
    pub bit_depth: u32,
    pub color_primaries: Option<String>,
    pub color_transfer: Option<String>,
    pub color_space: Option<String>,
    pub color_range: Option<String>,
    pub is_hdr: bool,
    pub has_alpha: bool,
    pub start_offset_flicks: i64,
    pub duration_flicks: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamInfoDto {
    pub stream_index: u32,
    pub codec: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub channel_layout: Option<String>,
    pub language: Option<String>,
    pub start_offset_flicks: i64,
    pub duration_flicks: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfoDto {
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfoDto {
    pub container: String,
    pub duration_flicks: i64,
    pub size_bytes: u64,
    pub bit_rate: Option<u64>,
    pub video: Option<VideoStreamInfoDto>,
    pub audio: Vec<AudioStreamInfoDto>,
    pub image: Option<ImageInfoDto>,
    pub probed_with: String,
}

pub async fn probe(
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<MediaInfoDto, AppError> {
    let bins = super::binaries().await?;
    let args: Vec<&OsStr> = vec![
        OsStr::new("-v"),
        OsStr::new("error"),
        OsStr::new("-print_format"),
        OsStr::new("json"),
        OsStr::new("-show_format"),
        OsStr::new("-show_streams"),
        path.as_os_str(),
    ];
    let output = super::run(&bins.ffprobe, &args, PROBE_TIMEOUT, cancellation).await?;

    let raw: RawProbeOutput = serde_json::from_slice(&output.stdout).map_err(|error| {
        AppError::new(
            ErrorCode::FfmpegFailed,
            format!(
                "could not parse ffprobe output for {}: {error}",
                path.display()
            ),
        )
    })?;

    build_media_info(raw, &bins.ffprobe_version)
}

// --- ffprobe's own JSON shape: numbers are inconsistently strings, fields are
// inconsistently present, so almost everything here is optional and parsed leniently. ---

#[derive(Debug, Deserialize)]
struct RawProbeOutput {
    #[serde(default)]
    streams: Vec<RawStream>,
    format: RawFormat,
}

#[derive(Debug, Deserialize)]
struct RawFormat {
    format_name: String,
    duration: Option<String>,
    size: Option<String>,
    bit_rate: Option<String>,
    start_time: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawStream {
    index: u32,
    codec_name: Option<String>,
    codec_type: Option<String>,
    profile: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    sample_aspect_ratio: Option<String>,
    r_frame_rate: Option<String>,
    avg_frame_rate: Option<String>,
    start_time: Option<String>,
    duration: Option<String>,
    nb_frames: Option<String>,
    bits_per_raw_sample: Option<String>,
    pix_fmt: Option<String>,
    color_range: Option<String>,
    color_space: Option<String>,
    color_transfer: Option<String>,
    color_primaries: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u32>,
    channel_layout: Option<String>,
    #[serde(default)]
    tags: HashMap<String, String>,
    #[serde(default)]
    side_data_list: Vec<RawSideData>,
    #[serde(default)]
    disposition: RawDisposition,
}

#[derive(Debug, Deserialize)]
struct RawSideData {
    side_data_type: Option<String>,
    rotation: Option<f64>,
}

#[derive(Debug, Deserialize, Default)]
struct RawDisposition {
    #[serde(default)]
    attached_pic: u32,
}

fn build_media_info(raw: RawProbeOutput, probed_with: &str) -> Result<MediaInfoDto, AppError> {
    let format_duration_secs = parse_f64(raw.format.duration.as_deref());
    let format_start_secs = parse_f64(raw.format.start_time.as_deref()).unwrap_or(0.0);
    let size_bytes = raw
        .format
        .size
        .as_deref()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let bit_rate = raw
        .format
        .bit_rate
        .as_deref()
        .and_then(|v| v.parse::<u64>().ok());

    let video_stream = raw
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video") && s.disposition.attached_pic == 0);
    let audio_streams: Vec<&RawStream> = raw
        .streams
        .iter()
        .filter(|s| s.codec_type.as_deref() == Some("audio"))
        .collect();

    let kind = classify(&raw.format.format_name, video_stream, &audio_streams);

    let video = if kind == MediaKind::Video {
        video_stream
            .map(|s| build_video_stream(s, format_start_secs))
            .transpose()?
    } else {
        None
    };
    let audio = if kind == MediaKind::Image {
        Vec::new()
    } else {
        audio_streams
            .iter()
            .map(|s| build_audio_stream(s, format_start_secs))
            .collect::<Result<Vec<_>, _>>()?
    };
    let image = if kind == MediaKind::Image {
        video_stream.and_then(|s| {
            Some(ImageInfoDto {
                width: s.width?,
                height: s.height?,
                has_alpha: has_alpha_pixel_format(s.pix_fmt.as_deref()),
            })
        })
    } else {
        None
    };

    Ok(MediaInfoDto {
        container: raw.format.format_name,
        duration_flicks: flicks_from_seconds(format_duration_secs.unwrap_or(0.0)),
        size_bytes,
        bit_rate,
        video,
        audio,
        image,
        probed_with: probed_with.to_owned(),
    })
}

/// Single-frame image containers vs. everything else (docs/MEDIA-PIPELINE.md §2.1).
/// Verified against real ffprobe output for `png_pipe`/`image2`/`mp3`/`mov,mp4,...`.
fn classify(format_name: &str, video: Option<&RawStream>, audio: &[&RawStream]) -> MediaKind {
    const IMAGE_CONTAINERS: &[&str] = &["png_pipe", "image2", "bmp_pipe", "tiff_pipe", "webp_pipe"];
    if IMAGE_CONTAINERS.contains(&format_name) {
        let frame_count = video
            .and_then(|s| s.nb_frames.as_deref())
            .and_then(|v| v.parse::<u32>().ok());
        let animated_webp = format_name == "webp_pipe" && frame_count.is_some_and(|n| n > 1);
        if !animated_webp {
            return MediaKind::Image;
        }
    }
    if video.is_some() {
        return MediaKind::Video; // includes animated GIF, whose container is "gif"
    }
    if !audio.is_empty() {
        return MediaKind::Audio;
    }
    MediaKind::Video
}

fn build_video_stream(
    s: &RawStream,
    format_start_secs: f64,
) -> Result<VideoStreamInfoDto, AppError> {
    let width = s.width.ok_or_else(|| {
        AppError::new(ErrorCode::FfmpegFailed, "video stream is missing its width")
    })?;
    let height = s.height.ok_or_else(|| {
        AppError::new(
            ErrorCode::FfmpegFailed,
            "video stream is missing its height",
        )
    })?;
    let sample_aspect_ratio = parse_rational(s.sample_aspect_ratio.as_deref(), ':')
        .unwrap_or(RationalDto { num: 1, den: 1 });
    let frame_rate =
        parse_rational(s.r_frame_rate.as_deref(), '/').unwrap_or(RationalDto { num: 0, den: 1 });
    let avg_frame_rate =
        parse_rational(s.avg_frame_rate.as_deref(), '/').unwrap_or_else(|| frame_rate.clone());
    let is_variable_frame_rate = avg_frame_rate.num != 0 && frame_rate != avg_frame_rate;

    let stream_start = parse_f64(s.start_time.as_deref()).unwrap_or(format_start_secs);
    let stream_duration = parse_f64(s.duration.as_deref()).unwrap_or(0.0);
    let color_transfer = s.color_transfer.clone();

    Ok(VideoStreamInfoDto {
        stream_index: s.index,
        codec: s.codec_name.clone().unwrap_or_default(),
        profile: s.profile.clone(),
        width,
        height,
        sample_aspect_ratio,
        rotation: normalize_rotation(read_rotation_degrees(s)),
        frame_rate,
        avg_frame_rate,
        is_variable_frame_rate,
        pixel_format: s.pix_fmt.clone().unwrap_or_default(),
        bit_depth: s
            .bits_per_raw_sample
            .as_deref()
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|&d| d > 0)
            .unwrap_or_else(|| default_bit_depth(s.pix_fmt.as_deref())),
        color_primaries: s.color_primaries.clone(),
        is_hdr: matches!(
            color_transfer.as_deref(),
            Some("smpte2084" | "arib-std-b67")
        ),
        color_transfer,
        color_space: s.color_space.clone(),
        color_range: s.color_range.clone(),
        has_alpha: has_alpha_pixel_format(s.pix_fmt.as_deref()),
        start_offset_flicks: flicks_from_seconds(stream_start - format_start_secs),
        duration_flicks: flicks_from_seconds(stream_duration),
    })
}

fn build_audio_stream(
    s: &RawStream,
    format_start_secs: f64,
) -> Result<AudioStreamInfoDto, AppError> {
    let stream_start = parse_f64(s.start_time.as_deref()).unwrap_or(format_start_secs);
    let stream_duration = parse_f64(s.duration.as_deref()).unwrap_or(0.0);
    Ok(AudioStreamInfoDto {
        stream_index: s.index,
        codec: s.codec_name.clone().unwrap_or_default(),
        sample_rate: s
            .sample_rate
            .as_deref()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0),
        channels: s.channels.unwrap_or(0),
        channel_layout: s.channel_layout.clone(),
        language: s.tags.get("language").cloned(),
        start_offset_flicks: flicks_from_seconds(stream_start - format_start_secs),
        duration_flicks: flicks_from_seconds(stream_duration),
    })
}

fn parse_f64(value: Option<&str>) -> Option<f64> {
    value.and_then(|v| v.parse::<f64>().ok())
}

fn parse_rational(value: Option<&str>, separator: char) -> Option<RationalDto> {
    let (num_str, den_str) = value?.split_once(separator)?;
    let num = num_str.parse::<i64>().ok()?;
    let den = den_str.parse::<i64>().ok()?;
    (den != 0).then_some(RationalDto { num, den })
}

/// Prefers the `Display Matrix` side data ffprobe reports for recent streams (mobile
/// video); falls back to the older `rotate` metadata tag.
fn read_rotation_degrees(s: &RawStream) -> f64 {
    let from_side_data = s.side_data_list.iter().find_map(|sd| {
        (sd.side_data_type.as_deref() == Some("Display Matrix"))
            .then_some(sd.rotation)
            .flatten()
    });
    from_side_data
        .or_else(|| s.tags.get("rotate").and_then(|v| v.parse::<f64>().ok()))
        .unwrap_or(0.0)
}

fn normalize_rotation(degrees: f64) -> i32 {
    let normalized = (degrees.round() as i64).rem_euclid(360);
    match normalized {
        315..360 | 0..45 => 0,
        45..135 => 90,
        135..225 => 180,
        _ => 270,
    }
}

fn default_bit_depth(pixel_format: Option<&str>) -> u32 {
    match pixel_format {
        Some(fmt) if fmt.ends_with("10le") || fmt.ends_with("10be") => 10,
        Some(fmt) if fmt.ends_with("12le") || fmt.ends_with("12be") => 12,
        Some(fmt) if fmt.ends_with("16le") || fmt.ends_with("16be") => 16,
        _ => 8,
    }
}

fn has_alpha_pixel_format(pixel_format: Option<&str>) -> bool {
    let Some(fmt) = pixel_format else {
        return false;
    };
    fmt.starts_with("yuva")
        || fmt.starts_with("rgba")
        || fmt.starts_with("bgra")
        || fmt.starts_with("argb")
        || fmt.starts_with("abgr")
        || fmt.starts_with("gbrap")
        || fmt == "ya8"
}

fn flicks_from_seconds(seconds: f64) -> i64 {
    (seconds * FLICKS_PER_SECOND).round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(codec_type: &str) -> RawStream {
        RawStream {
            index: 0,
            codec_name: None,
            codec_type: Some(codec_type.to_owned()),
            profile: None,
            width: Some(1920),
            height: Some(1080),
            sample_aspect_ratio: None,
            r_frame_rate: None,
            avg_frame_rate: None,
            start_time: None,
            duration: None,
            nb_frames: None,
            bits_per_raw_sample: None,
            pix_fmt: None,
            color_range: None,
            color_space: None,
            color_transfer: None,
            color_primaries: None,
            sample_rate: None,
            channels: None,
            channel_layout: None,
            tags: HashMap::new(),
            side_data_list: Vec::new(),
            disposition: RawDisposition::default(),
        }
    }

    #[test]
    fn classifies_by_container_first_matching_confirmed_ffprobe_output() {
        assert_eq!(
            classify("png_pipe", Some(&stream("video")), &[]),
            MediaKind::Image
        );
        assert_eq!(
            classify("image2", Some(&stream("video")), &[]),
            MediaKind::Image
        );
        assert_eq!(
            classify("mov,mp4,m4a,3gp,3g2,mj2", Some(&stream("video")), &[]),
            MediaKind::Video
        );
        assert_eq!(classify("mp3", None, &[&stream("audio")]), MediaKind::Audio);
    }

    #[test]
    fn classifies_an_animated_webp_as_video() {
        let mut multi_frame = stream("video");
        multi_frame.nb_frames = Some("12".to_owned());
        assert_eq!(
            classify("webp_pipe", Some(&multi_frame), &[]),
            MediaKind::Video
        );
    }

    #[test]
    fn classifies_a_single_frame_webp_as_image() {
        let mut one_frame = stream("video");
        one_frame.nb_frames = Some("1".to_owned());
        assert_eq!(
            classify("webp_pipe", Some(&one_frame), &[]),
            MediaKind::Image
        );
    }

    #[test]
    fn parse_rational_splits_on_the_given_separator() {
        assert_eq!(
            parse_rational(Some("30/1"), '/'),
            Some(RationalDto { num: 30, den: 1 })
        );
        assert_eq!(
            parse_rational(Some("1:1"), ':'),
            Some(RationalDto { num: 1, den: 1 })
        );
        assert_eq!(parse_rational(Some("30/0"), '/'), None);
        assert_eq!(parse_rational(None, '/'), None);
    }

    #[test]
    fn normalize_rotation_snaps_to_the_nearest_quarter_turn() {
        assert_eq!(normalize_rotation(0.0), 0);
        assert_eq!(normalize_rotation(-90.0), 270);
        assert_eq!(normalize_rotation(90.0), 90);
        assert_eq!(normalize_rotation(180.0), 180);
        assert_eq!(normalize_rotation(-180.0), 180);
        assert_eq!(normalize_rotation(-270.0), 90);
    }

    #[test]
    fn default_bit_depth_reads_the_pixel_format_suffix() {
        assert_eq!(default_bit_depth(Some("yuv420p")), 8);
        assert_eq!(default_bit_depth(Some("yuv420p10le")), 10);
        assert_eq!(default_bit_depth(Some("yuv422p12be")), 12);
        assert_eq!(default_bit_depth(None), 8);
    }

    #[test]
    fn has_alpha_pixel_format_recognizes_common_alpha_formats() {
        assert!(has_alpha_pixel_format(Some("yuva420p")));
        assert!(has_alpha_pixel_format(Some("rgba")));
        assert!(!has_alpha_pixel_format(Some("yuv420p")));
        assert!(!has_alpha_pixel_format(None));
    }

    #[test]
    fn flicks_from_seconds_matches_the_ts_conversion() {
        assert_eq!(flicks_from_seconds(1.0), 705_600_000);
        assert_eq!(flicks_from_seconds(0.0), 0);
    }

    #[test]
    fn parses_a_real_video_probe_json() {
        // Captured from `ffprobe -show_format -show_streams` on a generated 1s/30fps H.264 file.
        const JSON: &str = r#"{
            "streams": [{
                "index": 0, "codec_name": "h264", "codec_type": "video", "profile": "High",
                "width": 320, "height": 240, "sample_aspect_ratio": "1:1",
                "r_frame_rate": "30/1", "avg_frame_rate": "30/1", "start_time": "0.000000",
                "duration": "1.000000", "nb_frames": "30", "pix_fmt": "yuv420p",
                "color_range": "tv", "color_space": "bt709", "color_transfer": "bt709",
                "color_primaries": "bt709"
            }],
            "format": { "format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "1.000000", "size": "12345", "bit_rate": "98765", "start_time": "0.000000" }
        }"#;
        let raw: RawProbeOutput = serde_json::from_str(JSON).unwrap();
        let info = build_media_info(raw, "ffprobe-test").unwrap();

        assert_eq!(info.container, "mov,mp4,m4a,3gp,3g2,mj2");
        assert_eq!(info.duration_flicks, 705_600_000);
        assert_eq!(info.size_bytes, 12345);
        let video = info.video.unwrap();
        assert_eq!(video.codec, "h264");
        assert_eq!(video.width, 320);
        assert_eq!(video.frame_rate, RationalDto { num: 30, den: 1 });
        assert!(!video.is_variable_frame_rate);
        assert_eq!(video.rotation, 0);
        assert!(!video.is_hdr);
    }

    #[test]
    fn parses_a_real_image_probe_json_with_no_duration_field() {
        // Captured from a generated PNG: ffprobe reports no "duration" at all.
        const JSON: &str = r#"{
            "streams": [{
                "index": 0, "codec_name": "png", "codec_type": "video",
                "width": 320, "height": 240, "r_frame_rate": "25/1", "avg_frame_rate": "25/1",
                "pix_fmt": "rgba"
            }],
            "format": { "format_name": "png_pipe" }
        }"#;
        let raw: RawProbeOutput = serde_json::from_str(JSON).unwrap();
        let info = build_media_info(raw, "ffprobe-test").unwrap();

        assert!(info.video.is_none());
        let image = info.image.unwrap();
        assert_eq!(image.width, 320);
        assert!(image.has_alpha);
    }

    #[test]
    fn detects_variable_frame_rate_from_diverging_r_and_avg_frame_rate() {
        const JSON: &str = r#"{
            "streams": [{
                "index": 0, "codec_name": "h264", "codec_type": "video",
                "width": 320, "height": 240, "r_frame_rate": "60/1", "avg_frame_rate": "3847/128"
            }],
            "format": { "format_name": "matroska,webm" }
        }"#;
        let raw: RawProbeOutput = serde_json::from_str(JSON).unwrap();
        let info = build_media_info(raw, "ffprobe-test").unwrap();
        assert!(info.video.unwrap().is_variable_frame_rate);
    }

    #[cfg(feature = "media-tests")]
    mod with_real_ffmpeg {
        use super::*;
        use std::path::PathBuf;

        fn scratch_dir(name: &str) -> PathBuf {
            let dir = std::env::temp_dir()
                .join(format!("kriti-probe-test-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        /// Runs ffmpeg synchronously (std::process, not the module under test) purely to
        /// generate a fixture file; never mind cancellation/timeouts for this.
        fn generate(args: &[&str]) {
            let status = std::process::Command::new("ffmpeg")
                .args(["-y", "-v", "error"])
                .args(args)
                .status()
                .expect("ffmpeg must be on PATH to run media-tests");
            assert!(status.success(), "ffmpeg generation failed: {args:?}");
        }

        #[tokio::test]
        async fn probes_a_generated_video_file() {
            let dir = scratch_dir("video");
            let path = dir.join("video.mp4");
            generate(&[
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x240:duration=1:rate=30",
                "-pix_fmt",
                "yuv420p",
                path.to_str().unwrap(),
            ]);

            let info = probe(&path, &CancellationToken::new()).await.unwrap();
            let video = info.video.unwrap();
            assert_eq!(video.width, 320);
            assert_eq!(video.height, 240);
            assert_eq!(video.frame_rate, RationalDto { num: 30, den: 1 });
            assert!(!video.is_variable_frame_rate);
        }

        #[tokio::test]
        async fn probes_a_generated_png_as_an_image_with_no_video_stream() {
            let dir = scratch_dir("png");
            let path = dir.join("pic.png");
            generate(&[
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x240:duration=1",
                // Without this, the default 25fps source yields 25 frames that the
                // image2 muxer refuses to all write to one fixed filename.
                "-frames:v",
                "1",
                path.to_str().unwrap(),
            ]);

            let info = probe(&path, &CancellationToken::new()).await.unwrap();
            assert!(info.video.is_none());
            let image = info.image.unwrap();
            assert_eq!((image.width, image.height), (320, 240));
        }

        #[tokio::test]
        async fn probes_a_generated_audio_file() {
            let dir = scratch_dir("audio");
            let path = dir.join("audio.mp3");
            generate(&[
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                path.to_str().unwrap(),
            ]);

            let info = probe(&path, &CancellationToken::new()).await.unwrap();
            assert!(info.video.is_none());
            assert_eq!(info.audio.len(), 1);
        }

        #[tokio::test]
        async fn probe_is_cancellable() {
            let dir = scratch_dir("cancel");
            let path = dir.join("video.mp4");
            generate(&[
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x240:duration=1:rate=30",
                "-pix_fmt",
                "yuv420p",
                path.to_str().unwrap(),
            ]);

            let token = CancellationToken::new();
            token.cancel();
            let result = probe(&path, &token).await;
            assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
        }
    }
}
