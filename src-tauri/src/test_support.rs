//! Contract-test helpers for the fixtures shared with the TS suite (ADR-008).

use std::path::PathBuf;

use serde::Serialize;

/// Set to `1` to rewrite fixtures from the current Rust types instead of comparing.
const UPDATE_ENV_VAR: &str = "KRITI_UPDATE_FIXTURES";

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join("ipc")
        .join(name)
}

pub fn read_fixture(name: &str) -> serde_json::Value {
    let path = fixture_path(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read fixture {}: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("fixture {} is not valid JSON: {error}", path.display()))
}

/// Asserts that `value` serializes to exactly the JSON stored in `fixtures/ipc/<name>`.
pub fn assert_matches_fixture<T: Serialize>(name: &str, value: &T) {
    let actual = serde_json::to_value(value).unwrap();
    if std::env::var(UPDATE_ENV_VAR).is_ok_and(|flag| flag == "1") {
        let mut text = serde_json::to_string_pretty(&actual).unwrap();
        text.push('\n');
        std::fs::write(fixture_path(name), text).unwrap();
        return;
    }
    assert_eq!(
        actual,
        read_fixture(name),
        "{name} no longer matches the Rust type. Update the Zod schema in src/ipc/contracts.ts \
         together with it, then rerun with {UPDATE_ENV_VAR}=1 to rewrite the fixture."
    );
}
