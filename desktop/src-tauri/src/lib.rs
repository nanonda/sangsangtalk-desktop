use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{
    AppHandle, Manager, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use url::Url;

const APP_URL: &str = "http://127.0.0.1:43123/";
const OFFLINE_URL: &str = "http://sangsang.localhost/offline";
const LINK_STATE_PATH: &str = r"C:\SangsangTalk\desktop\link-state.txt";

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
    /// Recent `notify` calls, for the rate limit.
    notify_log: Mutex<VecDeque<Instant>>,
    /// Download destinations in progress, so two downloads never pick the same name.
    downloads: Mutex<HashMap<PathBuf, Url>>,
}

const NOTIFY_TITLE_MAX: usize = 60;
const NOTIFY_BODY_MAX: usize = 200;
const NOTIFY_TARGET_MAX: usize = 64;
const NOTIFY_PER_SECOND: usize = 3;
const UNREAD_MAX: u32 = 999_999;

pub fn run() {
    let mut builder = tauri::Builder::default();
    // Must be the first plugin. Dev builds share the bundle identifier (and so the
    // instance lock) with an installed SangsangTalk, so they only opt in on request.
    if !tauri::is_dev() || std::env::var_os("SANGSANGTALK_SINGLE_INSTANCE").is_some() {
        builder = builder.plugin(tauri_plugin_single_instance::init(on_second_instance));
    }
    builder
        .invoke_handler(tauri::generate_handler![notify, set_unread])
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
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
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(APP_URL.parse().expect("app url")),
            )
            .title("상상톡")
            .inner_size(1100.0, 760.0)
            .min_inner_size(390.0, 560.0)
            .center()
            .visible(!hidden)
            .on_navigation(|url| navigation_allowed(url))
            .on_new_window(|_url, _features| NewWindowResponse::Deny)
            .on_download(handle_download)
            .build()?;
            let _ = window.set_icon(png_icon(include_bytes!("../icons/128x128.png")));

            let watched = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let shell = watched.state::<Shell>();
                    if !shell.quitting.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = watched.hide();
                    }
                }
            });

            app.manage(Shell {
                quitting: AtomicBool::new(false),
                link: Mutex::new(None),
                misses: AtomicU8::new(0),
                unread: AtomicU32::new(0),
                notify_log: Mutex::new(VecDeque::new()),
                downloads: Mutex::new(HashMap::new()),
            });
            #[cfg(windows)]
            app.manage(toast::Shown::default());

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
    let _ = std::fs::write(LINK_STATE_PATH, state_word(settled));
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
    let url = APP_URL.parse().map_err(|_| ())?;
    let cookies = window.cookies_for_url(url).map_err(|_| ())?;
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
    let addr: SocketAddr = "127.0.0.1:43123".parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .ok()?;
    let mut header = String::from(
        "GET /api/session/status HTTP/1.1\r\n\
         Host: 127.0.0.1:43123\r\n\
         Connection: close\r\n\
         Accept: application/json\r\n\
         User-Agent: SangsangTalkDesktop\r\n",
    );
    if let Some(value) = cookie {
        header.push_str("Cookie: sangsang_sid=");
        header.push_str(value);
        header.push_str("\r\n");
    }
    header.push_str("\r\n");
    stream.write_all(header.as_bytes()).ok()?;
    drop(header);

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
            Err(_) => return None,
        }
    }
    let text = String::from_utf8_lossy(&received);
    let (head, body) = text.split_once("\r\n\r\n")?;
    let status = head.lines().next().unwrap_or("");
    if !(status.starts_with("HTTP/1.1 200") || status.starts_with("HTTP/1.0 200")) {
        return status.starts_with("HTTP/").then_some(false);
    }
    Some(body.contains("\"signedIn\":true"))
}

fn navigate_app(window: &WebviewWindow) {
    if let Ok(url) = APP_URL.parse() {
        let _ = window.navigate(url);
    }
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

fn is_app_url(url: &Url) -> bool {
    url.scheme() == "http"
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(43123)
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
// Granted to http://127.0.0.1:43123 by capabilities/web-bridge.json; each command
// also re-checks the calling webview's URL.

#[tauri::command]
fn notify(
    app: AppHandle,
    webview: Webview,
    title: String,
    body: String,
    target: String,
) -> Result<(), String> {
    require_app_caller(&webview)?;
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
    if !notify_allowed(&app.state::<Shell>().notify_log, Instant::now()) {
        // Over the rate limit: drop quietly so a chatty page cannot flood the desktop.
        return Ok(());
    }
    show_toast(&app, title, body, click);
    Ok(())
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

/// At most NOTIFY_PER_SECOND calls in any one-second window.
fn notify_allowed(log: &Mutex<VecDeque<Instant>>, now: Instant) -> bool {
    let Ok(mut log) = log.lock() else {
        return false;
    };
    while log
        .front()
        .is_some_and(|at| now.duration_since(*at) >= Duration::from_secs(1))
    {
        log.pop_front();
    }
    if log.len() >= NOTIFY_PER_SECOND {
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

#[cfg(windows)]
fn show_toast(app: &AppHandle, title: String, body: String, click: ToastClick) {
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = toast::show(&app, &title, &body, click);
    });
}

#[cfg(not(windows))]
fn show_toast(_app: &AppHandle, _title: String, _body: String, _click: ToastClick) {}

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

    use super::{on_toast_click, ToastClick};

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

    pub fn show(app: &AppHandle, title: &str, body: &str, click: ToastClick) -> Result<()> {
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
                    show_toast(&app, "내려받기 완료".into(), name, ToastClick::Reveal(path));
                }
                _ => show_toast(
                    &app,
                    "내려받기 실패".into(),
                    "파일을 내려받지 못했습니다.".into(),
                    ToastClick::Focus,
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
