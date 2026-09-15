fn main() {
    // Registering commands generates `allow-<command>` permissions, so capabilities/default.json
    // must grant every command explicitly (docs/ARCHITECTURE.md §5.4).
    let manifest = tauri_build::AppManifest::new().commands(&[
        "app_info",
        "log_write",
        "project_save",
        "project_open",
        "project_autosave",
        "recent_projects_list",
        "session_check_recovery",
        "session_set_active_project",
    ]);
    if let Err(error) =
        tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
    {
        // Build scripts report failure by panicking; there is no caller to return an error to.
        panic!("tauri-build failed: {error:#}");
    }
}
