use std::borrow::Cow;

use serde::Deserialize;

use crate::error::AppError;

/// Upper bound per call. The UI logger sends at most 50 (src/lib/logger.ts).
const MAX_ENTRIES_PER_CALL: usize = 100;
/// Longer text is truncated rather than rejected, so a log line is never lost.
const MAX_TEXT_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UiLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

/// One frontend log entry. Mirrored by `UiLogEntrySchema` in src/ipc/contracts.ts.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiLogEntry {
    pub level: UiLogLevel,
    pub message: String,
    pub context: Option<String>,
}

/// Writes frontend log entries into the core's log under the `ui` target.
#[tauri::command]
pub async fn log_write(entries: Vec<UiLogEntry>) -> Result<(), AppError> {
    check_batch_size(&entries)?;
    entries.iter().for_each(emit);
    Ok(())
}

fn check_batch_size(entries: &[UiLogEntry]) -> Result<(), AppError> {
    if entries.len() > MAX_ENTRIES_PER_CALL {
        return Err(AppError::invalid_argument(format!(
            "log_write accepts at most {MAX_ENTRIES_PER_CALL} entries per call (got {})",
            entries.len()
        ))
        .with_details(serde_json::json!({ "maxEntries": MAX_ENTRIES_PER_CALL })));
    }
    Ok(())
}

fn emit(entry: &UiLogEntry) {
    let message = truncate(&entry.message, MAX_TEXT_BYTES);
    let text = match &entry.context {
        Some(context) => format!("{message}\n{}", truncate(context, MAX_TEXT_BYTES)),
        None => message.into_owned(),
    };
    match entry.level {
        UiLogLevel::Debug => tracing::debug!(target: "ui", "{text}"),
        UiLogLevel::Info => tracing::info!(target: "ui", "{text}"),
        UiLogLevel::Warn => tracing::warn!(target: "ui", "{text}"),
        UiLogLevel::Error => tracing::error!(target: "ui", "{text}"),
    }
}

/// Cuts `text` to at most `max_bytes` on a character boundary and notes what was dropped.
fn truncate(text: &str, max_bytes: usize) -> Cow<'_, str> {
    if text.len() <= max_bytes {
        return Cow::Borrowed(text);
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Cow::Owned(format!(
        "{} … [{} bytes truncated]",
        &text[..end],
        text.len() - end
    ))
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use super::{MAX_ENTRIES_PER_CALL, UiLogEntry, UiLogLevel, check_batch_size, truncate};
    use crate::test_support::{assert_matches_fixture, read_fixture};

    fn entry() -> UiLogEntry {
        UiLogEntry {
            level: UiLogLevel::Info,
            message: "x".to_owned(),
            context: None,
        }
    }

    #[test]
    fn deserializes_the_contract_fixture() {
        let entries: Vec<UiLogEntry> =
            serde_json::from_value(read_fixture("log_write_entries.json")).unwrap();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].context, None);
        assert_eq!(entries[1].level, UiLogLevel::Error);
    }

    #[test]
    fn rejects_an_oversized_batch_with_the_contract_error() {
        let error = check_batch_size(&vec![entry(); MAX_ENTRIES_PER_CALL + 1]).unwrap_err();
        assert_matches_fixture("app_error.json", &error);
    }

    #[test]
    fn accepts_a_full_batch() {
        assert!(check_batch_size(&vec![entry(); MAX_ENTRIES_PER_CALL]).is_ok());
    }

    #[test]
    fn truncates_on_a_character_boundary() {
        // "नमस्ते" is six 3-byte characters; a 4-byte limit falls inside the second one.
        let truncated = truncate("नमस्ते", 4);
        assert_eq!(truncated, "न … [15 bytes truncated]");
    }

    #[test]
    fn leaves_short_text_untouched() {
        assert!(matches!(truncate("ok", 8), Cow::Borrowed("ok")));
    }
}
