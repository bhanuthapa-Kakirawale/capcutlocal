//! The error envelope every command rejects with (docs/ARCHITECTURE.md §5.2 and §7).

use serde::Serialize;

/// Closed set of error codes shared with the UI (`ErrorCodeSchema` in src/ipc/contracts.ts).
/// Change both together; the contract fixtures catch one-sided changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    /// A bug or an unexpected environment failure. Details are in the log.
    Internal,
    /// The UI sent a request the core cannot accept.
    InvalidArgument,
    /// The requested file does not exist.
    NotFound,
    /// The file exceeds the size this operation accepts.
    TooLarge,
    /// The file is not a Kriti project (docs/PROJECT-MODEL.md §5.1's envelope check).
    InvalidProjectFile,
    /// The target volume has no free space left.
    DiskFull,
    /// The OS denied access to the file (locked, or an unwritable permission).
    PermissionDenied,
    /// No usable FFmpeg/ffprobe was found, or it is older than the minimum supported version.
    FfmpegUnavailable,
    /// An FFmpeg/ffprobe child process failed (non-zero exit, crash, or stalled).
    FfmpegFailed,
    /// The job was cancelled before it finished.
    Cancelled,
}

/// Serialized as `{ code, message, retryable, details? }`.
#[derive(Debug, Clone, PartialEq, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl AppError {
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument, message)
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            details: None,
        }
    }

    /// Classifies an I/O failure into the closed error-code set, preserving the OS message.
    pub fn from_io_error(context: &str, error: &std::io::Error) -> Self {
        let (code, retryable) = match error.kind() {
            std::io::ErrorKind::NotFound => (ErrorCode::NotFound, false),
            std::io::ErrorKind::PermissionDenied => (ErrorCode::PermissionDenied, true),
            std::io::ErrorKind::StorageFull => (ErrorCode::DiskFull, true),
            _ => (ErrorCode::Internal, false),
        };
        let built = Self::new(code, format!("{context}: {error}"));
        if retryable { built.retryable() } else { built }
    }
}

impl From<tauri::Error> for AppError {
    fn from(error: tauri::Error) -> Self {
        tracing::error!(%error, "tauri runtime error");
        Self::internal(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::AppError;

    #[test]
    fn omits_details_when_absent() {
        let json = serde_json::to_value(AppError::internal("boom")).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "code": "INTERNAL", "message": "boom", "retryable": false })
        );
    }
}
