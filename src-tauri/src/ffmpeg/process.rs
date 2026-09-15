//! Process supervision for FFmpeg children: no shell, captured output, a timeout, and
//! cancellation (docs/MEDIA-PIPELINE.md §1.2-1.3). Orphan prevention on a crash is
//! handled once for the whole app, not per child — see `crate::job_isolation`.

use std::ffi::OsStr;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, ErrorCode};

/// stderr beyond this is dropped from the tail kept for error messages and logs.
const STDERR_TAIL_BYTES: usize = 64 * 1024;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct RunOutput {
    pub stdout: Vec<u8>,
}

/// Runs `program` with `args` (which must include every flag the caller needs, in the
/// right order — this function adds no arguments of its own). Kills the child on
/// cancellation, on a non-zero exit, or if it runs longer than `timeout`.
pub async fn run(
    program: &Path,
    args: &[impl AsRef<OsStr>],
    timeout: Duration,
    cancellation: &CancellationToken,
) -> Result<RunOutput, AppError> {
    let mut command = Command::new(program);
    command.args(args);
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|e| AppError::from_io_error(&format!("starting {}", program.display()), &e))?;

    let mut stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| AppError::internal("child process has no stdout pipe"))?;
    let mut stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| AppError::internal("child process has no stderr pipe"))?;

    // Drained concurrently with waiting for exit: an unread stderr pipe is a classic way
    // to hang a child process once its OS buffer fills (docs/MEDIA-PIPELINE.md §1.3).
    let stdout_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf).await;
        buf
    });
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf).await;
        buf
    });

    let status = tokio::select! {
        result = tokio::time::timeout(timeout, child.wait()) => match result {
            Ok(Ok(status)) => status,
            Ok(Err(io_error)) => return Err(AppError::from_io_error("waiting for the process", &io_error)),
            Err(_elapsed) => {
                let _ = child.kill().await;
                return Err(AppError::new(
                    ErrorCode::FfmpegFailed,
                    format!("{} did not finish within {timeout:?} (stalled)", program.display()),
                ));
            }
        },
        () = cancellation.cancelled() => {
            let _ = child.kill().await;
            return Err(AppError::new(ErrorCode::Cancelled, "job was cancelled"));
        }
    };

    let stdout = stdout_task.await.unwrap_or_default();
    let stderr_bytes = stderr_task.await.unwrap_or_default();
    let stderr_tail = tail_string(&stderr_bytes, STDERR_TAIL_BYTES);

    if !status.success() {
        return Err(AppError::new(
            ErrorCode::FfmpegFailed,
            format!("{} exited with {status}", program.display()),
        )
        .with_details(serde_json::json!({ "stderrTail": stderr_tail })));
    }

    if !stderr_tail.is_empty() {
        // ffmpeg/ffprobe write informational output to stderr even on success; keep it
        // in the log without treating it as a problem. Not returned to the caller: only
        // a failure needs stderr past this point (it is already in the error above).
        tracing::debug!(%stderr_tail, program = %program.display(), "ffmpeg stderr");
    }

    Ok(RunOutput { stdout })
}

/// The last `max_bytes` of `bytes`, decoded lossily (stderr is not guaranteed UTF-8, and
/// `from_utf8_lossy` copes with a start position that lands mid-character on its own).
fn tail_string(bytes: &[u8], max_bytes: usize) -> String {
    let start = bytes.len().saturating_sub(max_bytes);
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_string_keeps_only_the_last_bytes_on_a_char_boundary() {
        let text = "hello world".repeat(10);
        let tail = tail_string(text.as_bytes(), 10);
        assert!(tail.len() <= 10);
        assert!(text.ends_with(&tail));
    }

    #[test]
    fn tail_string_returns_everything_when_under_the_limit() {
        assert_eq!(tail_string(b"short", 100), "short");
    }
}
