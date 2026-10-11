fn main() {
    // App commands get ACL permissions (allow-bridge, allow-save-download): the connect screen has them through
    // capabilities/default.json, a Gibbous server's pages through a capability added at runtime for its origin only.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["bridge", "save_download"])),
    )
    .expect("failed to run tauri-build");
}
