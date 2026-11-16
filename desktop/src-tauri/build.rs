fn main() {
    // Declaring the app commands makes Tauri generate `allow-notify` / `allow-set-unread`
    // permissions, so they are only reachable where a capability grants them.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["notify", "set_unread"])),
    )
    .expect("failed to run tauri-build");
}
