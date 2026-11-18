use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{
    AppHandle, Manager, UserAttentionType, Webview, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use url::Url;

/// App address, fixed at build time from SANGSANGTALK_APP_URL (validated by build.rs;
/// default http://127.0.0.1:43123/). Always an origin followed by `/`.
const APP_URL: &str = env!("SANGSANGTALK_APP_URL");
/// Build-time SANGSANGTALK_CAPTURE_BLOCK=1: exclude the main window from screen capture
/// (Windows `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`, applied by Tauri's
/// `content_protected`). Off by default because it also blocks legitimate work captures.
const CAPTURE_BLOCK: bool = matches!(env!("SANGSANGTALK_CAPTURE_BLOCK").as_bytes(), b"1");
const OFFLINE_URL: &str = "http://sangsang.localhost/offline";

// Windows sign-in at startup is off unless the tray item "시작 시 실행" is checked.
// The autostart registration adds "--hidden" only after that item is enabled.

const OFFLINE_HTML: &str = r#"<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>상상톡 · 서버에 연결되지 않음</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f3efe6; color: #1d2418; font-family: "Segoe UI", sans-serif; }
    main { max-width: 28rem; padding: 2rem; }
    h1 { font-size: 1.45rem; margin: 0 0 0.75rem; }
    p { line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <main>
    <h1>서버에 연결되지 않음</h1>
    <p>상상톡 서버에 연결할 수 없습니다. 연결을 자동으로 다시 시도합니다.</p>
  </main>
</body>
</html>
"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LinkState {
    SignedIn,
    SignedOut,
    Disconnected,
}

struct Shell {
    quitting: AtomicBool,
    link: Mutex<Option<LinkState>>,
    misses: AtomicU8,
    unread: AtomicU32,
    /// Recent ordinary `notify` toasts, for the rate limit.
    notify_log: Mutex<VecDeque<Instant>>,
    /// Recent urgent toasts, limited separately.
    urgent_log: Mutex<VecDeque<Instant>>,
    /// An urgent (until-focused) taskbar flash is running; cleared when the window gets focus.
    urgent_flash: AtomicBool,
    /// Download destinations in progress, so two downloads never pick the same name.
    downloads: Mutex<HashMap<PathBuf, Url>>,
    /// Per-device PC app settings (close action, hotkey) as saved on disk.
    settings: Mutex<DesktopSettings>,
    /// Whether the saved hotkey is actually registered in this run.
    hotkey_active: AtomicBool,
}

const NOTIFY_TITLE_MAX: usize = 60;
const NOTIFY_BODY_MAX: usize = 200;
const NOTIFY_TARGET_MAX: usize = 64;
const NOTIFY_PER_SECOND: usize = 3;
const NOTIFY_WINDOW: Duration = Duration::from_secs(1);
const URGENT_PER_WINDOW: usize = 5;
const URGENT_WINDOW: Duration = Duration::from_secs(10);
const UNREAD_MAX: u32 = 999_999;

pub fn run() {
    let mut builder = tauri::Builder::default();
    // Must be the first plugin. Dev builds share the bundle identifier (and so the
    // instance lock) with an installed SangsangTalk, so they only opt in on request.
    if !tauri::is_dev() || std::env::var_os("SANGSANGTALK_SINGLE_INSTANCE").is_some() {
        builder = builder.plugin(tauri_plugin_single_instance::init(on_second_instance));
    }
    builder
        .invoke_handler(tauri::generate_handler![
            notify,
            set_unread,
            app_info,
            get_autostart,
            set_autostart,
            get_close_action,
            set_close_action,
            get_hotkey,
            set_hotkey
        ])
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        // Only Rust registers shortcuts; the page gets no global-shortcut permission.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        on_hotkey(app);
                    }
                })
                .build(),
        )
        .register_uri_scheme_protocol("sangsang", |_ctx, request| {
            if request.uri().path() == "/offline" {
                tauri::http::Response::builder()
                    .status(200)
                    .header("content-type", "text/html; charset=utf-8")
                    .body(OFFLINE_HTML.as_bytes().to_vec())
                    .unwrap()
            } else {
                tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap()
            }
        })
        .setup(|app| {
            let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            let open = MenuItem::with_id(app, "open", "열기", true, None::<&str>)?;
            let autostart = CheckMenuItem::with_id(
                app,
                "autostart",
                "시작 시 실행",
                true,
                autostart_enabled,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &autostart, &quit])?;
            let autostart_for_menu = autostart.clone();

            let hidden = std::env::args().any(|arg| arg == "--hidden");
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::External(app_url().clone()))
                    .title("상상톡")
                    .inner_size(1100.0, 760.0)
                    .min_inner_size(390.0, 560.0)
                    .center()
                    .visible(!hidden)
                    .on_navigation(|url| navigation_allowed(url))
                    .on_new_window(|_url, _features| NewWindowResponse::Deny)
                    .on_download(handle_download)
                    .content_protected(CAPTURE_BLOCK)
                    .build()?;
            let _ = window.set_icon(png_icon(include_bytes!("../icons/128x128.png")));

            let watched = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::Focused(true) = event {
                    // Windows stops the until-foreground flash itself; just forget it.
                    watched
                        .state::<Shell>()
                        .urgent_flash
                        .store(false, Ordering::SeqCst);
                }
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let shell = watched.state::<Shell>();
                    if shell.quitting.load(Ordering::SeqCst) {
                        return;
                    }
                    api.prevent_close();
                    let close_action = shell
                        .settings
                        .lock()
                        .map(|settings| settings.close_action)
                        .unwrap_or_default();
                    match close_action {
                        CloseAction::Tray => {
                            let _ = watched.hide();
                        }
                        CloseAction::Quit => {
                            shell.quitting.store(true, Ordering::SeqCst);
                            watched.app_handle().exit(0);
                        }
                    }
                }
            });

            app.manage(Shell {
                quitting: AtomicBool::new(false),
                link: Mutex::new(None),
                misses: AtomicU8::new(0),
                unread: AtomicU32::new(0),
                notify_log: Mutex::new(VecDeque::new()),
                urgent_log: Mutex::new(VecDeque::new()),
                urgent_flash: AtomicBool::new(false),
                downloads: Mutex::new(HashMap::new()),
                settings: Mutex::new(load_settings(app.handle())),
                hotkey_active: AtomicBool::new(false),
            });
            app.manage(TrayItems {
                autostart: autostart.clone(),
            });
            #[cfg(windows)]
            app.manage(toast::Shown::default());
            register_saved_hotkey(app.handle());

            TrayIconBuilder::with_id("tray")
                .icon(icon_for(LinkState::SignedOut))
                .tooltip("상상톡")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => open_from_tray(app),
                    "quit" => {
                        app.state::<Shell>().quitting.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    "autostart" => toggle_autostart(app, &autostart_for_menu),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        open_from_tray(tray.app_handle());
                    }
                })
                .build(app)?;

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(400));
                loop {
                    if let Some(probed) = probe(&handle) {
                        let handle_for_ui = handle.clone();
                        let _ = handle.run_on_main_thread(move || apply(&handle_for_ui, probed));
                    }
                    std::thread::sleep(Duration::from_secs(2));
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("sangsangtalk desktop failed to start");
}

fn toggle_autostart<R: tauri::Runtime>(app: &tauri::AppHandle<R>, item: &CheckMenuItem<R>) {
    use tauri_plugin_autostart::ManagerExt;
    let enable = !app.autolaunch().is_enabled().unwrap_or(false);
    let action = if enable {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    let checked = if action.is_ok() {
        enable
    } else {
        app.autolaunch().is_enabled().unwrap_or(false)
    };
    let _ = item.set_checked(checked);
}

fn open_from_tray(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let on_app = window.url().map(|url| is_app_url(&url)).unwrap_or(false);
    if !on_app {
        navigate_app(&window);
    }
}

fn apply(app: &tauri::AppHandle, probed: LinkState) {
    let shell = app.state::<Shell>();
    let previous = shell.link.lock().ok().and_then(|link| *link);
    let settled = settle(previous, &shell.misses, probed);
    {
        let mut link = match shell.link.lock() {
            Ok(link) => link,
            Err(_) => return,
        };
        if *link == Some(settled) {
            return;
        }
        *link = Some(settled);
    }
    if settled == LinkState::SignedOut {
        // The session is gone, so the previous account's unread count no longer applies.
        shell.unread.store(0, Ordering::SeqCst);
    }
    refresh_indicators(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(window_title(settled));
        match settled {
            LinkState::Disconnected => show_offline(&window),
            LinkState::SignedIn | LinkState::SignedOut => {
                if window
                    .url()
                    .map(|url| is_offline_url(&url))
                    .unwrap_or(false)
                {
                    navigate_app(&window);
                }
            }
        }
    }
    #[cfg(debug_assertions)]
    write_link_state(app, settled);
}

/// Debug builds only: records the settled state as one word in
/// `<app local data dir>\link-state.txt` (e.g. `%LOCALAPPDATA%\com.sangsangtalk.desktop`)
/// for checking the tray logic during development. Failures are ignored.
#[cfg(debug_assertions)]
fn write_link_state(app: &tauri::AppHandle, state: LinkState) {
    let Ok(dir) = app.path().app_local_data_dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(dir.join("link-state.txt"), state_word(state));
    }
}

fn settle(previous: Option<LinkState>, misses: &AtomicU8, probed: LinkState) -> LinkState {
    if probed != LinkState::Disconnected {
        misses.store(0, Ordering::SeqCst);
        return probed;
    }
    match previous {
        None | Some(LinkState::Disconnected) => LinkState::Disconnected,
        Some(current) => {
            let count = misses.fetch_add(1, Ordering::SeqCst) + 1;
            if count >= 2 {
                LinkState::Disconnected
            } else {
                current
            }
        }
    }
}

fn probe(app: &tauri::AppHandle) -> Option<LinkState> {
    let cookie = match session_cookie(app) {
        Ok(cookie) => cookie,
        Err(()) => return None,
    };
    Some(match request_signed_in(cookie.as_deref()) {
        None => LinkState::Disconnected,
        Some(true) => LinkState::SignedIn,
        Some(false) => LinkState::SignedOut,
    })
}

fn session_cookie(app: &tauri::AppHandle) -> Result<Option<String>, ()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(None);
    };
    let cookies = window.cookies_for_url(app_url().clone()).map_err(|_| ())?;
    let mut session = None;
    for cookie in cookies {
        if cookie.name() != "sangsang_sid" {
            continue;
        }
        let value = cookie.value();
        if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            session = Some(value.to_string());
        }
        break;
    }
    Ok(session)
}

fn request_signed_in(cookie: Option<&str>) -> Option<bool> {
    let url = app_url();
    let host = url.host_str()?;
    let addrs = url.socket_addrs(|| None).ok()?;
    let tcp = addrs
        .iter()
        .find_map(|addr| TcpStream::connect_timeout(addr, Duration::from_secs(2)).ok())?;
    tcp.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    tcp.set_write_timeout(Some(Duration::from_secs(2))).ok()?;

    // `Host` must match what the browser sends: host plus any non-default port.
    let authority = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let mut request = format!(
        "GET /api/session/status HTTP/1.1\r\n\
         Host: {authority}\r\n\
         Connection: close\r\n\
         Accept: application/json\r\n\
         User-Agent: SangsangTalkDesktop\r\n"
    );
    if let Some(value) = cookie {
        request.push_str("Cookie: sangsang_sid=");
        request.push_str(value);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");

    let received = if url.scheme() == "https" {
        exchange(tls_connect(host, tcp)?, request)?
    } else {
        exchange(tcp, request)?
    };
    let text = String::from_utf8_lossy(&received);
    let (head, body) = text.split_once("\r\n\r\n")?;
    let status = head.lines().next().unwrap_or("");
    if !(status.starts_with("HTTP/1.1 200") || status.starts_with("HTTP/1.0 200")) {
        return status.starts_with("HTTP/").then_some(false);
    }
    Some(body.contains("\"signedIn\":true"))
}

/// TLS through SChannel, which validates the server certificate against the Windows
/// certificate store (so an internal root CA deployed to the PC is trusted, same as
/// WebView2). Any certificate or handshake failure counts as "server unreachable".
#[cfg(windows)]
fn tls_connect(host: &str, tcp: TcpStream) -> Option<native_tls::TlsStream<TcpStream>> {
    let connector = native_tls::TlsConnector::new().ok()?;
    connector.connect(host, tcp).ok()
}

#[cfg(not(windows))]
fn tls_connect(_host: &str, _tcp: TcpStream) -> Option<TcpStream> {
    None
}

/// Sends the request and reads up to ~4 KiB of the response (the status reply is tiny).
fn exchange<S: Read + Write>(mut stream: S, request: String) -> Option<Vec<u8>> {
    stream.write_all(request.as_bytes()).ok()?;
    drop(request);
    let mut received = Vec::new();
    let mut buffer = [0u8; 1024];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                received.extend_from_slice(&buffer[..count]);
                if received.len() > 4096 {
                    break;
                }
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::TimedOut
                    || error.kind() == std::io::ErrorKind::WouldBlock =>
            {
                break;
            }
            // A TLS peer that closes without close_notify still delivered the reply.
            Err(_) if !received.is_empty() => break,
            Err(_) => return None,
        }
    }
    Some(received)
}

fn navigate_app(window: &WebviewWindow) {
    let _ = window.navigate(app_url().clone());
}

fn app_url() -> &'static Url {
    static APP: std::sync::OnceLock<Url> = std::sync::OnceLock::new();
    APP.get_or_init(|| Url::parse(APP_URL).expect("build.rs validated SANGSANGTALK_APP_URL"))
}

fn show_offline(window: &WebviewWindow) {
    if window
        .url()
        .map(|url| is_offline_url(&url))
        .unwrap_or(false)
    {
        return;
    }
    if let Ok(url) = OFFLINE_URL.parse() {
        let _ = window.navigate(url);
    }
}

fn navigation_allowed(url: &Url) -> bool {
    is_blank(url) || is_app_url(url) || is_offline_url(url)
}

fn is_blank(url: &Url) -> bool {
    url.scheme() == "about" && (url.path() == "blank" || url.as_str() == "about:blank")
}

/// Same origin as APP_URL (scheme, host and effective port) and no credentials.
fn is_app_url(url: &Url) -> bool {
    let app = app_url();
    url.scheme() == app.scheme()
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str() == app.host_str()
        && url.port_or_known_default() == app.port_or_known_default()
}

fn is_offline_url(url: &Url) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/offline"
        && ((url.scheme() == "http"
            && url.host_str() == Some("sangsang.localhost")
            && url.port().is_none())
            || (url.scheme() == "sangsang" && url.host_str() == Some("localhost")))
}

fn tooltip(state: LinkState) -> &'static str {
    match state {
        LinkState::SignedIn => "상상톡 · 연결됨",
        LinkState::SignedOut => "상상톡 · 로그아웃",
        LinkState::Disconnected => "상상톡 · 서버에 연결되지 않음",
    }
}

fn window_title(state: LinkState) -> &'static str {
    match state {
        LinkState::Disconnected => "상상톡 · 서버에 연결되지 않음",
        LinkState::SignedIn | LinkState::SignedOut => "상상톡",
    }
}

#[cfg(debug_assertions)]
fn state_word(state: LinkState) -> &'static str {
    match state {
        LinkState::SignedIn => "signed-in",
        LinkState::SignedOut => "signed-out",
        LinkState::Disconnected => "disconnected",
    }
}

fn icon_for(state: LinkState) -> Image<'static> {
    let bytes = match state {
        LinkState::SignedIn => include_bytes!("../icons/tray-signed-in.png").as_slice(),
        LinkState::SignedOut => include_bytes!("../icons/tray-signed-out.png").as_slice(),
        LinkState::Disconnected => include_bytes!("../icons/tray-disconnected.png").as_slice(),
    };
    png_icon(bytes)
}

fn png_icon(bytes: &[u8]) -> Image<'static> {
    Image::from_bytes(bytes).expect("embedded PNG icon must be valid")
}

// ---------------------------------------------------------------------------
// Web bridge: the only Tauri commands the remote page may call.
// Granted to APP_URL by the web-bridge capability that build.rs generates; each command
// also re-checks the calling webview's URL.

/// `sound`, `flash` and `urgent` are optional so older pages keep working.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn notify(
    app: AppHandle,
    webview: Webview,
    title: String,
    body: String,
    target: String,
    sound: Option<String>,
    flash: Option<bool>,
    urgent: Option<bool>,
) -> Result<(), String> {
    require_app_caller(&webview)?;
    let style = ToastStyle {
        sound: NotifySound::parse(sound.as_deref()),
        urgent: urgent.unwrap_or(false),
    };
    let title = clean_text(&title, NOTIFY_TITLE_MAX, "제목")?;
    if title.is_empty() {
        return Err("알림 제목이 비어 있습니다.".into());
    }
    let body = clean_text(&body, NOTIFY_BODY_MAX, "본문")?;
    let click = if target.is_empty() {
        ToastClick::Focus
    } else if valid_target(&target) {
        ToastClick::Open(target)
    } else {
        return Err("알림 이동 경로가 올바르지 않습니다.".into());
    };
    // Urgent messages always flash; only the toast itself is rate limited.
    if flash.unwrap_or(true) || style.urgent {
        flash_taskbar(&app, style.urgent);
    }
    // Over the limit: drop quietly so a chatty page cannot flood the desktop. Urgent
    // toasts have their own, separate budget so ordinary ones cannot crowd them out.
    let shell = app.state::<Shell>();
    let allowed = if style.urgent {
        notify_allowed(
            &shell.urgent_log,
            Instant::now(),
            URGENT_PER_WINDOW,
            URGENT_WINDOW,
        )
    } else {
        notify_allowed(
            &shell.notify_log,
            Instant::now(),
            NOTIFY_PER_SECOND,
            NOTIFY_WINDOW,
        )
    };
    if allowed {
        show_toast(&app, title, body, click, style);
    }
    Ok(())
}

/// Flashes the taskbar button when the window is not in front: a few times normally,
/// and until the window comes forward for urgent messages. While an urgent flash is
/// running, ordinary notifications leave it alone (a short flash would cancel it).
fn flash_taskbar(app: &AppHandle, urgent: bool) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let in_front = window.is_visible().unwrap_or(false)
        && !window.is_minimized().unwrap_or(false)
        && window.is_focused().unwrap_or(false);
    if in_front {
        return;
    }
    let urgent_flash = &app.state::<Shell>().urgent_flash;
    let kind = if urgent {
        urgent_flash.store(true, Ordering::SeqCst);
        UserAttentionType::Critical
    } else if urgent_flash.load(Ordering::SeqCst) {
        return;
    } else {
        UserAttentionType::Informational
    };
    let _ = window.request_user_attention(Some(kind));
}

#[tauri::command]
fn set_unread(app: AppHandle, webview: Webview, count: u32) -> Result<(), String> {
    require_app_caller(&webview)?;
    app.state::<Shell>()
        .unread
        .store(count.min(UNREAD_MAX), Ordering::SeqCst);
    refresh_indicators(&app);
    Ok(())
}

fn require_app_caller(webview: &Webview) -> Result<(), String> {
    match webview.url() {
        Ok(url) if is_app_url(&url) => Ok(()),
        _ => Err("허용되지 않은 호출입니다.".into()),
    }
}

/// At most `limit` calls in any `window`-long period.
fn notify_allowed(
    log: &Mutex<VecDeque<Instant>>,
    now: Instant,
    limit: usize,
    window: Duration,
) -> bool {
    let Ok(mut log) = log.lock() else {
        return false;
    };
    while log
        .front()
        .is_some_and(|at| now.duration_since(*at) >= window)
    {
        log.pop_front();
    }
    if log.len() >= limit {
        return false;
    }
    log.push_back(now);
    true
}

/// Zero-width characters and bidi controls that could disguise notification text.
fn is_hidden_format_char(ch: char) -> bool {
    matches!(
        ch,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
    )
}

fn clean_text(value: &str, max_chars: usize, name: &str) -> Result<String, String> {
    let cleaned: String = value
        .chars()
        .filter(|ch| !is_hidden_format_char(*ch))
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .trim()
        .to_string();
    if cleaned.chars().count() > max_chars {
        return Err(format!(
            "알림 {name}은(는) {max_chars}자를 넘을 수 없습니다."
        ));
    }
    Ok(cleaned)
}

/// `#/` followed only by `[A-Za-z0-9/_-]`, at most NOTIFY_TARGET_MAX bytes.
fn valid_target(target: &str) -> bool {
    target.len() <= NOTIFY_TARGET_MAX
        && target.starts_with("#/")
        && target[2..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_'))
}

// ---------------------------------------------------------------------------
// Unread indicators: tray tooltip + tray dot, taskbar overlay badge.

fn refresh_indicators(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let state = shell
        .link
        .lock()
        .ok()
        .and_then(|link| *link)
        .unwrap_or(LinkState::SignedOut);
    let unread = shell.unread.load(Ordering::SeqCst);
    let show_unread = state == LinkState::SignedIn && unread > 0;
    if let Some(tray) = app.tray_by_id("tray") {
        let icon = icon_for(state);
        let icon = if show_unread { with_dot(icon) } else { icon };
        let _ = tray.set_icon(Some(icon));
        let tip = if show_unread {
            format!("상상톡 · 안읽음 {unread}")
        } else {
            tooltip(state).to_string()
        };
        let _ = tray.set_tooltip(Some(tip));
    }
    if let Some(window) = app.get_webview_window("main") {
        let overlay = show_unread.then(|| unread_badge(unread));
        let _ = window.set_overlay_icon(overlay);
    }
}

const BADGE_RED: [u8; 4] = [0xe5, 0x3e, 0x3e, 0xff];
const BADGE_WHITE: [u8; 4] = [0xff, 0xff, 0xff, 0xff];

fn put(rgba: &mut [u8], width: u32, x: u32, y: u32, color: [u8; 4]) {
    let at = ((y * width + x) * 4) as usize;
    if let Some(pixel) = rgba.get_mut(at..at + 4) {
        pixel.copy_from_slice(&color);
    }
}

fn fill_circle(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    center: (f32, f32),
    r: f32,
    color: [u8; 4],
) {
    for y in 0..height {
        for x in 0..width {
            let dx = x as f32 + 0.5 - center.0;
            let dy = y as f32 + 0.5 - center.1;
            if dx * dx + dy * dy <= r * r {
                put(rgba, width, x, y, color);
            }
        }
    }
}

/// Tray icon with a red dot in the top-right corner.
fn with_dot(icon: Image<'static>) -> Image<'static> {
    let (width, height) = (icon.width(), icon.height());
    let mut rgba = icon.rgba().to_vec();
    let size = width.min(height) as f32;
    let r = size * 0.22;
    let center = (width as f32 - r - size * 0.05, r + size * 0.05);
    fill_circle(
        &mut rgba,
        width,
        height,
        center,
        r + size * 0.05,
        BADGE_WHITE,
    );
    fill_circle(&mut rgba, width, height, center, r, BADGE_RED);
    Image::new_owned(rgba, width, height)
}

// 3x5 glyphs: digits 0-9, then '+'.
const GLYPHS: [[u8; 5]; 11] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b010, 0b010, 0b010],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
    [0b000, 0b010, 0b111, 0b010, 0b000],
];

/// Taskbar overlay: red circle with the count (1-9, or "9+").
fn unread_badge(count: u32) -> Image<'static> {
    const SIZE: u32 = 32;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    let half = SIZE as f32 / 2.0;
    fill_circle(&mut rgba, SIZE, SIZE, (half, half), half, BADGE_RED);
    let glyphs: &[usize] = if count > 9 {
        &[9, 10]
    } else {
        &[count as usize]
    };
    let scale: u32 = if glyphs.len() == 1 { 4 } else { 3 };
    let gap = scale;
    let count_w = glyphs.len() as u32;
    let text_w = count_w * 3 * scale + (count_w - 1) * gap;
    let left = (SIZE - text_w) / 2;
    let top = (SIZE - 5 * scale) / 2;
    for (index, glyph) in glyphs.iter().enumerate() {
        let origin = left + index as u32 * (3 * scale + gap);
        for (row, bits) in GLYPHS[*glyph].iter().enumerate() {
            for col in 0..3u32 {
                if bits & (0b100 >> col) == 0 {
                    continue;
                }
                for sy in 0..scale {
                    for sx in 0..scale {
                        let x = origin + col * scale + sx;
                        let y = top + row as u32 * scale + sy;
                        put(&mut rgba, SIZE, x, y, BADGE_WHITE);
                    }
                }
            }
        }
    }
    Image::new_owned(rgba, SIZE, SIZE)
}

// ---------------------------------------------------------------------------
// Toast notifications.

enum ToastClick {
    /// Bring the window forward and open this #/ route (already validated).
    Open(String),
    /// Bring the window forward without changing the route.
    Focus,
    /// Show the downloaded file in Explorer.
    Reveal(PathBuf),
}

/// N2 notification sounds (Windows system sounds).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum NotifySound {
    #[default]
    Default,
    Im,
    Mail,
    Reminder,
    None,
}

impl NotifySound {
    /// Missing or unknown names mean `default`, so newer pages keep working with this shell.
    fn parse(value: Option<&str>) -> Self {
        match value {
            Some("im") => Self::Im,
            Some("mail") => Self::Mail,
            Some("reminder") => Self::Reminder,
            Some("none") => Self::None,
            _ => Self::Default,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct ToastStyle {
    sound: NotifySound,
    /// N7: stays until dismissed (`scenario="reminder"`) and always rings the reminder sound.
    urgent: bool,
}

impl ToastStyle {
    /// The `<audio src>` to use, or `None` for the system default sound (or silence).
    fn audio_src(&self) -> Option<&'static str> {
        if self.urgent {
            return Some("ms-winsoundevent:Notification.Reminder");
        }
        match self.sound {
            NotifySound::Default | NotifySound::None => None,
            NotifySound::Im => Some("ms-winsoundevent:Notification.IM"),
            NotifySound::Mail => Some("ms-winsoundevent:Notification.Mail"),
            NotifySound::Reminder => Some("ms-winsoundevent:Notification.Reminder"),
        }
    }

    fn silent(&self) -> bool {
        !self.urgent && self.sound == NotifySound::None
    }
}

#[cfg(windows)]
fn show_toast(app: &AppHandle, title: String, body: String, click: ToastClick, style: ToastStyle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = toast::show(&app, &title, &body, click, style);
    });
}

#[cfg(not(windows))]
fn show_toast(
    _app: &AppHandle,
    _title: String,
    _body: String,
    _click: ToastClick,
    _style: ToastStyle,
) {
}

/// Builds the toast with WinRT directly so the app owns the `ToastNotification`.
/// Each shown toast is kept in `Shown` until it is clicked, closed by the user or
/// fails; otherwise the Activated handler can be lost once the toast moves to the
/// notification center.
#[cfg(windows)]
mod toast {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    use tauri::{AppHandle, Manager};
    use windows::core::{h, IInspectable, Result, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{
        ToastDismissalReason, ToastDismissedEventArgs, ToastFailedEventArgs, ToastNotification,
        ToastNotificationManager,
    };

    use super::{on_toast_click, ToastClick, ToastStyle};

    /// The PowerShell AppUserModelID, used by dev builds (no Start menu shortcut).
    const POWERSHELL_APP_ID: &str =
        "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
    /// Upper bound on toasts kept alive; the oldest is released first.
    const KEEP_MAX: usize = 50;

    #[derive(Default)]
    pub struct Shown {
        next: AtomicU64,
        toasts: Mutex<BTreeMap<u64, ToastNotification>>,
    }

    impl Shown {
        fn keep(&self, toast: ToastNotification) -> u64 {
            let id = self.next.fetch_add(1, Ordering::SeqCst);
            if let Ok(mut toasts) = self.toasts.lock() {
                toasts.insert(id, toast);
                while toasts.len() > KEEP_MAX {
                    toasts.pop_first();
                }
            }
            id
        }

        fn forget(&self, id: u64) {
            if let Ok(mut toasts) = self.toasts.lock() {
                toasts.remove(&id);
            }
        }
    }

    pub fn show(
        app: &AppHandle,
        title: &str,
        body: &str,
        click: ToastClick,
        style: ToastStyle,
    ) -> Result<()> {
        // Installed builds: the NSIS shortcut carries the bundle identifier as its
        // AppUserModelID. Dev builds borrow the PowerShell id, as tauri-plugin-notification does.
        let app_id = if tauri::is_dev() {
            HSTRING::from(POWERSHELL_APP_ID)
        } else {
            HSTRING::from(app.config().identifier.as_str())
        };

        let xml = XmlDocument::new()?;
        let toast_el = xml.CreateElement(h!("toast"))?;
        if let ToastClick::Open(target) = &click {
            // Passed to a relaunched exe if Windows starts the app from the toast;
            // the single-instance handler forwards it to the running window.
            toast_el.SetAttribute(h!("launch"), &HSTRING::from(target.as_str()))?;
        }
        let visual = xml.CreateElement(h!("visual"))?;
        let binding = xml.CreateElement(h!("binding"))?;
        binding.SetAttribute(h!("template"), h!("ToastGeneric"))?;
        for (id, text) in [("1", title), ("2", body)] {
            if text.is_empty() {
                continue;
            }
            let el = xml.CreateElement(h!("text"))?;
            el.SetAttribute(h!("id"), &HSTRING::from(id))?;
            // SetInnerText escapes the text; it is never parsed as XML.
            el.SetInnerText(&HSTRING::from(text))?;
            binding.AppendChild(&el)?;
        }
        visual.AppendChild(&binding)?;
        toast_el.AppendChild(&visual)?;

        if style.urgent {
            // Windows only honours the reminder scenario when the toast has a button.
            toast_el.SetAttribute(h!("scenario"), h!("reminder"))?;
            let actions = xml.CreateElement(h!("actions"))?;
            let open = xml.CreateElement(h!("action"))?;
            open.SetAttribute(h!("content"), h!("열기"))?;
            // The route rides along like `launch`, for a click that starts the app.
            let open_arguments = match &click {
                ToastClick::Open(target) => HSTRING::from(target.as_str()),
                _ => HSTRING::from("open"),
            };
            open.SetAttribute(h!("arguments"), &open_arguments)?;
            actions.AppendChild(&open)?;
            let close = xml.CreateElement(h!("action"))?;
            close.SetAttribute(h!("content"), h!("닫기"))?;
            close.SetAttribute(h!("arguments"), h!("dismiss"))?;
            close.SetAttribute(h!("activationType"), h!("system"))?;
            actions.AppendChild(&close)?;
            toast_el.AppendChild(&actions)?;
        }
        if let Some(src) = style.audio_src() {
            let audio = xml.CreateElement(h!("audio"))?;
            audio.SetAttribute(h!("src"), &HSTRING::from(src))?;
            toast_el.AppendChild(&audio)?;
        } else if style.silent() {
            let audio = xml.CreateElement(h!("audio"))?;
            audio.SetAttribute(h!("silent"), h!("true"))?;
            toast_el.AppendChild(&audio)?;
        }
        xml.AppendChild(&toast_el)?;

        let toast = ToastNotification::CreateToastNotification(&xml)?;
        let id = app.state::<Shown>().keep(toast.clone());
        let click = Arc::new(click);

        let handle = app.clone();
        toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
            move |_, _| {
                handle.state::<Shown>().forget(id);
                let app = handle.clone();
                let click = click.clone();
                let _ = handle.run_on_main_thread(move || on_toast_click(&app, &click));
                Ok(())
            },
        ))?;

        let handle = app.clone();
        toast.Dismissed(&TypedEventHandler::<
            ToastNotification,
            ToastDismissedEventArgs,
        >::new(move |_, args| {
            let args: &Option<ToastDismissedEventArgs> = &args;
            let reason = args.as_ref().and_then(|args| args.Reason().ok());
            // A timed-out toast still sits in the notification center and can be clicked.
            if reason != Some(ToastDismissalReason::TimedOut) {
                handle.state::<Shown>().forget(id);
            }
            Ok(())
        }))?;

        let handle = app.clone();
        toast.Failed(
            &TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(move |_, _| {
                handle.state::<Shown>().forget(id);
                Ok(())
            }),
        )?;

        let shown = ToastNotificationManager::CreateToastNotifierWithId(&app_id)?.Show(&toast);
        if shown.is_err() {
            app.state::<Shown>().forget(id);
        }
        shown
    }
}

fn on_second_instance(app: &AppHandle, args: Vec<String>, _cwd: String) {
    // A second launch from autostart should not pop the window open.
    if args.iter().any(|arg| arg == "--hidden") {
        return;
    }
    match args.iter().skip(1).find(|arg| valid_target(arg)) {
        Some(target) => on_toast_click(app, &ToastClick::Open(target.clone())),
        None => open_from_tray(app),
    }
}

fn on_toast_click(app: &AppHandle, click: &ToastClick) {
    match click {
        ToastClick::Open(target) => {
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            let on_app = window.url().map(|url| is_app_url(&url)).unwrap_or(false);
            if on_app {
                // `target` passed valid_target(): only `#/` and [A-Za-z0-9/_-].
                let _ = window.eval(format!("location.hash = {target:?};"));
            } else if let Ok(url) = format!("{APP_URL}{target}").parse() {
                let _ = window.navigate(url);
            }
        }
        ToastClick::Focus => open_from_tray(app),
        ToastClick::Reveal(path) => reveal_in_explorer(path),
    }
}

#[cfg(windows)]
fn reveal_in_explorer(path: &Path) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{}\"", path.display()))
        .spawn();
}

#[cfg(not(windows))]
fn reveal_in_explorer(_path: &Path) {}

// ---------------------------------------------------------------------------
// Downloads: only /api/files/ on the app origin. Once a handler accepts, WebView2
// suppresses its own download UI, so the file is saved to the default (Downloads)
// path under a free name and a toast reports the result.

fn handle_download(webview: Webview, event: DownloadEvent<'_>) -> bool {
    let app = webview.app_handle().clone();
    let shell = app.state::<Shell>();
    match event {
        DownloadEvent::Requested { url, destination } => {
            if !(is_app_url(&url) && url.path().starts_with("/api/files/")) {
                return false;
            }
            if !destination.is_absolute() || destination.file_name().is_none() {
                let Ok(dir) = app.path().download_dir() else {
                    return false;
                };
                *destination = dir.join("download");
            }
            let Ok(mut in_progress) = shell.downloads.lock() else {
                return false;
            };
            let chosen = free_path(destination, |path| in_progress.contains_key(path));
            in_progress.insert(chosen.clone(), url);
            *destination = chosen;
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            if let Ok(mut in_progress) = shell.downloads.lock() {
                let reserved = path
                    .clone()
                    .filter(|path| in_progress.contains_key(path))
                    .or_else(|| {
                        in_progress
                            .iter()
                            .find(|(_, started)| **started == url)
                            .map(|(path, _)| path.clone())
                    });
                if let Some(reserved) = reserved {
                    in_progress.remove(&reserved);
                }
            }
            match (success, path) {
                (true, Some(path)) => {
                    let name = path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    show_toast(
                        &app,
                        "내려받기 완료".into(),
                        name,
                        ToastClick::Reveal(path),
                        ToastStyle::default(),
                    );
                }
                _ => show_toast(
                    &app,
                    "내려받기 실패".into(),
                    "파일을 내려받지 못했습니다.".into(),
                    ToastClick::Focus,
                    ToastStyle::default(),
                ),
            }
            true
        }
        _ => false,
    }
}

/// `name.ext`, then `name (1).ext`, `name (2).ext`, ... until the path neither exists
/// nor is reserved by a download in progress.
fn free_path(path: &Path, reserved: impl Fn(&Path) -> bool) -> PathBuf {
    let taken = |candidate: &Path| candidate.exists() || reserved(candidate);
    if !taken(path) {
        return path.to_path_buf();
    }
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    let ext = path
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy()))
        .unwrap_or_default();
    for n in 1..10_000 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !taken(&candidate) {
            return candidate;
        }
    }
    path.to_path_buf()
}

// ---------------------------------------------------------------------------
// PC app settings (P5): kept per device in `<app local data dir>\settings.json`.

const DEFAULT_HOTKEY: &str = "Ctrl+Shift+Space";
const HOTKEY_MAX: usize = 40;
const SETTINGS_FILE: &str = "settings.json";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum CloseAction {
    /// Closing the window hides it to the tray (default).
    #[default]
    Tray,
    /// Closing the window quits the app.
    Quit,
}

impl CloseAction {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "tray" => Some(Self::Tray),
            "quit" => Some(Self::Quit),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct HotkeySetting {
    enabled: bool,
    accelerator: String,
}

impl Default for HotkeySetting {
    fn default() -> Self {
        Self {
            enabled: false,
            accelerator: DEFAULT_HOTKEY.to_string(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct DesktopSettings {
    close_action: CloseAction,
    hotkey: HotkeySetting,
}

impl DesktopSettings {
    /// Unknown or broken files fall back to the defaults; a bad accelerator is reset.
    fn from_json(text: &str) -> Self {
        let mut settings: Self = serde_json::from_str(text).unwrap_or_default();
        if parse_hotkey(&settings.hotkey.accelerator).is_err() {
            settings.hotkey = HotkeySetting::default();
        }
        settings
    }
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join(SETTINGS_FILE))
}

fn load_settings(app: &AppHandle) -> DesktopSettings {
    settings_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|text| DesktopSettings::from_json(&text))
        .unwrap_or_default()
}

/// Writes a temporary file and renames it over the old one.
fn save_settings(app: &AppHandle, settings: &DesktopSettings) -> Result<(), String> {
    const FAILED: &str = "설정을 저장하지 못했습니다.";
    let path = settings_path(app).ok_or(FAILED)?;
    let dir = path.parent().ok_or(FAILED)?;
    std::fs::create_dir_all(dir).map_err(|_| FAILED)?;
    let text = serde_json::to_string_pretty(settings).map_err(|_| FAILED)?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|_| FAILED)?;
    std::fs::rename(&temp, &path).map_err(|_| {
        let _ = std::fs::remove_file(&temp);
        FAILED.to_string()
    })
}

fn current_settings(app: &AppHandle) -> DesktopSettings {
    app.state::<Shell>()
        .settings
        .lock()
        .map(|settings| settings.clone())
        .unwrap_or_default()
}

/// Parses an accelerator such as `Ctrl+Shift+Space`. It needs the Windows key or at
/// least two of Ctrl/Alt/Shift, so everyday shortcuts (Ctrl+C, Ctrl+V, Ctrl+Z, Alt+F4,
/// Shift+key, ...) cannot be taken over system-wide. A few well-known system
/// combinations are refused outright.
fn parse_hotkey(accelerator: &str) -> Result<Shortcut, String> {
    let accelerator = accelerator.trim();
    if accelerator.is_empty() || accelerator.len() > HOTKEY_MAX {
        return Err("단축키 형식이 올바르지 않습니다.".into());
    }
    let shortcut: Shortcut = accelerator
        .parse()
        .map_err(|_| "단축키 형식이 올바르지 않습니다.".to_string())?;
    let mods = shortcut.mods;
    let plain_modifiers = [Modifiers::CONTROL, Modifiers::ALT, Modifiers::SHIFT]
        .iter()
        .filter(|modifier| mods.contains(**modifier))
        .count();
    if !mods.contains(Modifiers::SUPER) && plain_modifiers < 2 {
        return Err(
            "단축키에는 Ctrl·Alt·Shift 중 두 개 이상 또는 Windows 키가 들어가야 합니다.".into(),
        );
    }
    let reserved = [
        (Modifiers::CONTROL | Modifiers::SHIFT, Code::Escape),
        (Modifiers::CONTROL | Modifiers::ALT, Code::Delete),
    ];
    if reserved
        .iter()
        .any(|(reserved_mods, key)| mods == *reserved_mods && shortcut.key == *key)
    {
        return Err("Windows가 쓰는 단축키는 지정할 수 없습니다.".into());
    }
    Ok(shortcut)
}

/// The global hotkey brings the window forward, or hides it when it is already in front.
fn on_hotkey(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let in_front = window.is_visible().unwrap_or(false)
        && !window.is_minimized().unwrap_or(false)
        && window.is_focused().unwrap_or(false);
    if in_front {
        let _ = window.hide();
    } else {
        open_from_tray(app);
    }
}

/// At startup: registers the saved hotkey. If another program holds it, it stays
/// inactive for this run only (`hotkey_active` false); the saved setting is untouched, so
/// it is retried next start and is never written back as "off".
fn register_saved_hotkey(app: &AppHandle) {
    let hotkey = current_settings(app).hotkey;
    let registered = hotkey.enabled
        && parse_hotkey(&hotkey.accelerator)
            .ok()
            .is_some_and(|shortcut| app.global_shortcut().register(shortcut).is_ok());
    app.state::<Shell>()
        .hotkey_active
        .store(registered, Ordering::SeqCst);
}

/// `get_hotkey`/`set_hotkey` reply: the saved setting plus whether it is live right now.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HotkeyState {
    enabled: bool,
    accelerator: String,
    /// True when the hotkey is registered in this run. `enabled && !active` means another
    /// program held it at startup.
    active: bool,
}

fn hotkey_state(app: &AppHandle) -> HotkeyState {
    let hotkey = current_settings(app).hotkey;
    HotkeyState {
        enabled: hotkey.enabled,
        accelerator: hotkey.accelerator,
        active: app.state::<Shell>().hotkey_active.load(Ordering::SeqCst),
    }
}

// ---------------------------------------------------------------------------
// P5 bridge commands. Like `notify`, each checks that the caller is the app page.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    capture_block: bool,
}

#[tauri::command]
fn app_info(app: AppHandle, webview: Webview) -> Result<AppInfo, String> {
    require_app_caller(&webview)?;
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        capture_block: CAPTURE_BLOCK,
    })
}

#[tauri::command]
fn get_autostart(app: AppHandle, webview: Webview) -> Result<bool, String> {
    require_app_caller(&webview)?;
    app.autolaunch()
        .is_enabled()
        .map_err(|_| "시작 시 실행 상태를 확인하지 못했습니다.".to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, webview: Webview, enabled: bool) -> Result<bool, String> {
    require_app_caller(&webview)?;
    let changed = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    let actual = app.autolaunch().is_enabled().unwrap_or(false);
    sync_autostart_item(&app, actual);
    match changed {
        Ok(()) => Ok(actual),
        Err(_) => Err("시작 시 실행 설정을 바꾸지 못했습니다.".into()),
    }
}

#[tauri::command]
fn get_close_action(app: AppHandle, webview: Webview) -> Result<CloseAction, String> {
    require_app_caller(&webview)?;
    Ok(current_settings(&app).close_action)
}

#[tauri::command]
fn set_close_action(
    app: AppHandle,
    webview: Webview,
    action: String,
) -> Result<CloseAction, String> {
    require_app_caller(&webview)?;
    let action = CloseAction::parse(&action)
        .ok_or_else(|| "창 닫기 동작 값이 올바르지 않습니다.".to_string())?;
    let updated = {
        let shell = app.state::<Shell>();
        let mut settings = shell
            .settings
            .lock()
            .map_err(|_| "설정을 바꾸지 못했습니다.")?;
        settings.close_action = action;
        settings.clone()
    };
    save_settings(&app, &updated)?;
    Ok(action)
}

#[tauri::command]
fn get_hotkey(app: AppHandle, webview: Webview) -> Result<HotkeyState, String> {
    require_app_caller(&webview)?;
    Ok(hotkey_state(&app))
}

/// `accelerator` may be omitted to keep the current one. If registering or saving fails,
/// the previous registration and in-memory setting are restored.
#[tauri::command]
fn set_hotkey(
    app: AppHandle,
    webview: Webview,
    enabled: bool,
    accelerator: Option<String>,
) -> Result<HotkeyState, String> {
    require_app_caller(&webview)?;
    let shell = app.state::<Shell>();
    let previous_settings = current_settings(&app);
    let previous = previous_settings.hotkey.clone();
    let was_active = shell.hotkey_active.load(Ordering::SeqCst);
    let accelerator = accelerator
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| previous.accelerator.clone());
    let shortcut = parse_hotkey(&accelerator)?;

    let shortcuts = app.global_shortcut();
    // Only a registration that actually happened in this run is undone or restored.
    let previous_shortcut = parse_hotkey(&previous.accelerator)
        .ok()
        .filter(|_| was_active);
    let restore_previous = || {
        if let Some(old) = previous_shortcut {
            let _ = shortcuts.register(old);
        }
        shell.hotkey_active.store(was_active, Ordering::SeqCst);
    };
    if let Some(old) = previous_shortcut {
        let _ = shortcuts.unregister(old);
    }
    shell.hotkey_active.store(false, Ordering::SeqCst);
    if enabled {
        if shortcuts.register(shortcut).is_err() {
            restore_previous();
            return Err("다른 프로그램이 쓰는 단축키입니다.".into());
        }
        shell.hotkey_active.store(true, Ordering::SeqCst);
    }

    let updated = {
        let mut settings = shell
            .settings
            .lock()
            .map_err(|_| "설정을 바꾸지 못했습니다.")?;
        settings.hotkey = HotkeySetting {
            enabled,
            accelerator,
        };
        settings.clone()
    };
    if let Err(error) = save_settings(&app, &updated) {
        if enabled {
            let _ = shortcuts.unregister(shortcut);
        }
        restore_previous();
        if let Ok(mut settings) = shell.settings.lock() {
            *settings = previous_settings;
        }
        return Err(error);
    }
    Ok(hotkey_state(&app))
}

/// Keeps the tray "시작 시 실행" check mark in step with the real registration.
fn sync_autostart_item(app: &AppHandle, enabled: bool) {
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.autostart.set_checked(enabled);
    }
}

struct TrayItems {
    autostart: CheckMenuItem<tauri::Wry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets() {
        assert!(valid_target("#/dm/5"));
        assert!(valid_target("#/group/12"));
        assert!(!valid_target("#dm"));
        assert!(!valid_target("javascript:alert(1)"));
        assert!(!valid_target("#/dm/5?x=1"));
        assert!(!valid_target(&format!("#/{}", "a".repeat(80))));
    }

    #[test]
    fn notification_text() {
        assert_eq!(
            clean_text(" a\u{200B}b\u{202E}c\n ", 10, "본문").unwrap(),
            "abc"
        );
        assert!(clean_text(&"가".repeat(61), 60, "제목").is_err());
    }

    #[test]
    fn notify_rate_limit() {
        let log = Mutex::new(VecDeque::new());
        let start = Instant::now();
        let allowed = |at| notify_allowed(&log, at, NOTIFY_PER_SECOND, NOTIFY_WINDOW);
        assert!((0..3).all(|_| allowed(start)));
        assert!(!allowed(start));
        assert!(allowed(start + Duration::from_secs(1)));

        // Urgent toasts use their own log and budget.
        let urgent_log = Mutex::new(VecDeque::new());
        let urgent = |at| notify_allowed(&urgent_log, at, URGENT_PER_WINDOW, URGENT_WINDOW);
        assert!((0..URGENT_PER_WINDOW).all(|_| urgent(start)));
        assert!(!urgent(start + Duration::from_secs(9)));
        assert!(urgent(start + URGENT_WINDOW));
    }

    #[test]
    fn sounds() {
        assert_eq!(NotifySound::parse(None), NotifySound::Default);
        assert_eq!(NotifySound::parse(Some("im")), NotifySound::Im);
        assert_eq!(NotifySound::parse(Some("none")), NotifySound::None);
        // Unknown names fall back to the default sound instead of failing the call.
        assert_eq!(NotifySound::parse(Some("beep")), NotifySound::Default);
        // Urgent always rings the reminder sound, even when muted.
        let urgent = ToastStyle {
            sound: NotifySound::None,
            urgent: true,
        };
        assert_eq!(
            urgent.audio_src(),
            Some("ms-winsoundevent:Notification.Reminder")
        );
        assert_eq!(ToastStyle::default().audio_src(), None);
    }

    #[test]
    fn hotkeys() {
        assert!(parse_hotkey(DEFAULT_HOTKEY).is_ok());
        assert!(parse_hotkey("Ctrl+Alt+K").is_ok());
        assert!(parse_hotkey("Super+K").is_ok());
        assert!(parse_hotkey("Space").is_err());
        assert!(parse_hotkey("Shift+A").is_err());
        // Single-modifier everyday shortcuts are refused.
        for taken in ["Ctrl+C", "Ctrl+V", "Ctrl+Z", "Alt+F4", "Alt+F9"] {
            assert!(parse_hotkey(taken).is_err(), "{taken}");
        }
        assert!(parse_hotkey("Ctrl+Shift+Escape").is_err());
        assert!(parse_hotkey("Ctrl+Alt+Delete").is_err());
        assert!(parse_hotkey("Ctrl+Nope").is_err());
        assert!(parse_hotkey("").is_err());
    }

    #[test]
    fn settings_file() {
        assert_eq!(
            DesktopSettings::from_json("not json"),
            DesktopSettings::default()
        );
        let saved = DesktopSettings::from_json(
            r#"{"closeAction":"quit","hotkey":{"enabled":true,"accelerator":"Ctrl+Alt+K"}}"#,
        );
        assert_eq!(saved.close_action, CloseAction::Quit);
        assert!(saved.hotkey.enabled);
        let broken =
            DesktopSettings::from_json(r#"{"hotkey":{"enabled":true,"accelerator":"Space"}}"#);
        assert_eq!(broken.hotkey, HotkeySetting::default());
        assert_eq!(CloseAction::parse("tray"), Some(CloseAction::Tray));
        assert_eq!(CloseAction::parse("hide"), None);
    }
}
