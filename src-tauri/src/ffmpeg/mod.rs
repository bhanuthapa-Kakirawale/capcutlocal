//! The only module that spawns `ffmpeg`/`ffprobe` (ADR-004, docs/MEDIA-PIPELINE.md §1).
//! Binary resolution and version detection here; typed probe/artifact commands in their
//! sibling modules.

mod probe;
mod process;

pub use probe::{FLICKS_PER_SECOND, MediaInfoDto, MediaKind, probe};
// Leaf DTOs: not named directly by non-test code (they're only ever reached through
// `MediaInfoDto`'s own fields), but other modules' tests build fixtures with them.
#[cfg(test)]
pub use probe::{AudioStreamInfoDto, ImageInfoDto, RationalDto, VideoStreamInfoDto};
pub(crate) use process::run;

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::sync::OnceCell;

use crate::error::{AppError, ErrorCode};

/// FFmpeg builds tagged with a real release number below this are rejected
/// (docs/MEDIA-PIPELINE.md §1.1). A `N-...` git/nightly build has no such number and is
/// assumed current.
const MINIMUM_MAJOR_VERSION: u32 = 7;

#[derive(Clone)]
pub struct FfmpegBinaries {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub ffmpeg_version: String,
    pub ffprobe_version: String,
}

/// Resolved once per process and cached; every caller awaits the same check.
static BINARIES: OnceCell<Result<FfmpegBinaries, AppError>> = OnceCell::const_new();

/// Locates and version-checks ffmpeg/ffprobe (env override, else `PATH` —
/// docs/MEDIA-PIPELINE.md §1.1; bundled-sidecar resolution is a packaging-phase addition).
pub async fn binaries() -> Result<FfmpegBinaries, AppError> {
    BINARIES.get_or_init(resolve).await.clone()
}

fn resolve_binary(default_name: &str, env_var: &str) -> PathBuf {
    match std::env::var(env_var) {
        Ok(path) if !path.is_empty() => PathBuf::from(path),
        _ => PathBuf::from(default_name), // resolved against PATH when spawned
    }
}

async fn resolve() -> Result<FfmpegBinaries, AppError> {
    let ffmpeg = resolve_binary("ffmpeg", "KRITI_FFMPEG_PATH");
    let ffprobe = resolve_binary("ffprobe", "KRITI_FFPROBE_PATH");

    let ffmpeg_version = read_version(&ffmpeg).await?;
    let ffprobe_version = read_version(&ffprobe).await?;

    for (label, version) in [("ffmpeg", &ffmpeg_version), ("ffprobe", &ffprobe_version)] {
        if let Some(major) = parse_major_version(version) {
            if major < MINIMUM_MAJOR_VERSION {
                return Err(AppError::new(
                    ErrorCode::FfmpegUnavailable,
                    format!(
                        "{label} {major} is older than the minimum supported version ({MINIMUM_MAJOR_VERSION})"
                    ),
                ));
            }
        }
    }

    Ok(FfmpegBinaries {
        ffmpeg,
        ffprobe,
        ffmpeg_version,
        ffprobe_version,
    })
}

async fn read_version(program: &Path) -> Result<String, AppError> {
    let output = run(
        program,
        &["-hide_banner", "-version"],
        Duration::from_secs(5),
        &Default::default(),
    )
    .await
    .map_err(|_| {
        AppError::new(
            ErrorCode::FfmpegUnavailable,
            format!(
                "could not run {} — is it installed and on PATH?",
                program.display()
            ),
        )
    })?;
    let text = String::from_utf8_lossy(&output.stdout);
    let first_line = text.lines().next().unwrap_or_default();
    Ok(first_line.to_owned())
}

/// Extracts a release major version from a `"<program> version <token> ..."` line.
/// Returns `None` for a git/nightly build (a leading `N-` or `n` token), which is
/// treated as new enough since it tracks the latest source.
fn parse_major_version(version_line: &str) -> Option<u32> {
    let rest = version_line
        .strip_prefix("ffmpeg version ")
        .or_else(|| version_line.strip_prefix("ffprobe version "))?;
    let token = rest.split_whitespace().next()?;
    if token.starts_with("N-") || token.starts_with('n') {
        return None;
    }
    let digits: String = token.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::parse_major_version;

    #[test]
    fn parses_a_release_version() {
        assert_eq!(
            parse_major_version("ffmpeg version 7.1 Copyright (c) 2000-2026"),
            Some(7)
        );
        assert_eq!(
            parse_major_version("ffprobe version 4.4.2-0ubuntu0.22.04.1 Copyright"),
            Some(4)
        );
    }

    #[test]
    fn treats_a_git_build_as_current() {
        assert_eq!(
            parse_major_version("ffmpeg version N-122897-g9a7e0f1052-20260220 Copyright"),
            None
        );
    }

    #[test]
    fn returns_none_for_an_unrecognized_line() {
        assert_eq!(parse_major_version("garbage"), None);
    }
}
