use std::path::{Path, PathBuf};

/// Default app address (local development).
const DEFAULT_APP_URL: &str = "http://127.0.0.1:43123/";
const APP_URL_VAR: &str = "SANGSANGTALK_APP_URL";
const CAPTURE_BLOCK_VAR: &str = "SANGSANGTALK_CAPTURE_BLOCK";

/// App commands the web page may call. Each gets an `allow-<name>` permission, granted
/// only to APP_URL by the generated web-bridge capability.
const BRIDGE_COMMANDS: &[&str] = &[
    "notify",
    "set_unread",
    "app_info",
    "get_autostart",
    "set_autostart",
    "get_close_action",
    "set_close_action",
    "get_hotkey",
    "set_hotkey",
];

/// SANGSANGTALK_CAPTURE_BLOCK: unset or "0" = off (default), "1" = exclude the main
/// window from screen capture. Any other value, including empty, fails the build.
fn capture_block() -> bool {
    match std::env::var(CAPTURE_BLOCK_VAR) {
        Err(std::env::VarError::NotPresent) => false,
        Ok(value) if value == "0" => false,
        Ok(value) if value == "1" => true,
        Ok(value) => panic!("{CAPTURE_BLOCK_VAR}={value:?} is invalid; use 1 (on) or 0 (off)"),
        Err(std::env::VarError::NotUnicode(_)) => {
            panic!("{CAPTURE_BLOCK_VAR} is not valid Unicode; use 1 (on) or 0 (off)")
        }
    }
}

fn main() {
    let app_url = app_url();
    // The validated address is compiled in as `env!("SANGSANGTALK_APP_URL")`.
    println!("cargo:rustc-env={APP_URL_VAR}={app_url}");
    println!("cargo:rerun-if-env-changed={APP_URL_VAR}");

    // Compiled in as `env!("SANGSANGTALK_CAPTURE_BLOCK")`: "1" or "0".
    let capture_block = if capture_block() { "1" } else { "0" };
    println!("cargo:rustc-env={CAPTURE_BLOCK_VAR}={capture_block}");
    println!("cargo:rerun-if-env-changed={CAPTURE_BLOCK_VAR}");

    let capabilities = write_capabilities(&app_url);
    // tauri-build wants a &'static str; build scripts run once, so leaking is fine.
    let pattern: &'static str = Box::leak(capabilities.into_boxed_str());

    // Declaring the app commands makes Tauri generate an `allow-<command>` permission for
    // each, so they are only reachable where a capability grants them.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(BRIDGE_COMMANDS))
            .capabilities_path_pattern(pattern),
    )
    .expect("failed to run tauri-build");
}

/// Reads SANGSANGTALK_APP_URL and fails the build unless it is exactly
/// `http(s)://host[:port]/` — host a lowercase DNS name or IPv4 address, no credentials,
/// path, query or fragment. Unset means the development default (with a warning); set
/// but empty is an error, so a release build cannot silently fall back to the default.
fn app_url() -> String {
    let raw = match std::env::var(APP_URL_VAR) {
        Ok(value) if value.trim().is_empty() => panic!(
            "{APP_URL_VAR} is set but empty; unset it to use {DEFAULT_APP_URL:?} or give a URL"
        ),
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => {
            println!(
                "cargo:warning={APP_URL_VAR} is not set; using the development default {DEFAULT_APP_URL}"
            );
            DEFAULT_APP_URL.to_string()
        }
        Err(std::env::VarError::NotUnicode(_)) => {
            panic!("{APP_URL_VAR} is not valid Unicode")
        }
    };
    let parsed = url::Url::parse(&raw)
        .unwrap_or_else(|error| panic!("{APP_URL_VAR}={raw:?} is not a valid URL: {error}"));
    let problem = if !matches!(parsed.scheme(), "http" | "https") {
        Some("the scheme must be http or https")
    } else if let Some(problem) = host_problem(parsed.host()) {
        Some(problem)
    } else if parsed.port() == Some(0) {
        Some("port 0 is not allowed")
    } else if !parsed.username().is_empty() || parsed.password().is_some() {
        Some("credentials are not allowed")
    } else if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
        Some("only the origin followed by `/` is allowed (no path, query or fragment)")
    } else if parsed.as_str() != raw {
        Some("write it in canonical form, ending with `/`")
    } else {
        None
    };
    if let Some(problem) = problem {
        panic!(
            "{APP_URL_VAR}={raw:?} is invalid: {problem}. Expected e.g. {DEFAULT_APP_URL:?} or \
             \"https://talk.example.local/\"; canonical form of this value: {:?}",
            parsed.as_str()
        );
    }
    raw
}

/// Allows a DNS name of lowercase `[a-z0-9-]` labels (1–63 chars, no leading or trailing
/// `-`, no empty label, so no trailing dot) or an IPv4 address. Everything else, IPv6
/// included, is rejected.
fn host_problem(host: Option<url::Host<&str>>) -> Option<&'static str> {
    match host {
        None => Some("a host is required"),
        Some(url::Host::Ipv4(_)) => None,
        Some(url::Host::Ipv6(_)) => Some("IPv6 hosts are not supported; use a DNS name or IPv4"),
        Some(url::Host::Domain(domain)) => {
            let label_ok = |label: &str| {
                (1..=63).contains(&label.len())
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            };
            if domain.ends_with('.') {
                Some("the host must not end with `.`")
            } else if domain.len() > 253 || !domain.split('.').all(label_ok) {
                Some(
                    "the host must be lowercase letters, digits, `-` and `.` \
                     (labels of 1-63 chars, not starting or ending with `-`)",
                )
            } else {
                None
            }
        }
    }
}

/// Copies the fixed capabilities and generates `web-bridge.json` for this app URL into
/// OUT_DIR, returning the glob tauri-build should read. The source tree stays unchanged
/// whichever URL is built.
fn write_capabilities(app_url: &str) -> String {
    let source = Path::new("capabilities");
    println!("cargo:rerun-if-changed=capabilities");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("capabilities");
    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(&out).expect("create capabilities dir");

    for entry in std::fs::read_dir(source).expect("read capabilities dir") {
        let path = entry.expect("capabilities entry").path();
        if path.extension().is_some_and(|ext| ext == "json") {
            let name = path.file_name().expect("file name");
            assert!(
                name != "web-bridge.json",
                "capabilities/web-bridge.json is generated by build.rs; remove the file"
            );
            std::fs::copy(&path, out.join(name)).expect("copy capability");
        }
    }

    // app_url passed app_url(): only the scheme, `://`, a host of [a-z0-9.-] or IPv4, an
    // optional `:port` and `/`, so it cannot break out of the JSON string or the URL pattern.
    // Command names are fixed lowercase identifiers from BRIDGE_COMMANDS.
    let permissions = BRIDGE_COMMANDS
        .iter()
        .map(|command| format!("\"allow-{}\"", command.replace('_', "-")))
        .collect::<Vec<_>>()
        .join(", ");
    let bridge = format!(
        r#"{{
  "identifier": "web-bridge",
  "description": "The SangsangTalk web app at {app_url} may only call the app's own bridge commands (notifications, unread count, PC app settings).",
  "windows": ["main"],
  "remote": {{ "urls": ["{app_url}*"] }},
  "permissions": [{permissions}]
}}
"#
    );
    std::fs::write(out.join("web-bridge.json"), bridge).expect("write web-bridge capability");

    format!("{}/*.json", out.display()).replace('\\', "/")
}
