use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
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
}

pub fn run() {
    tauri::Builder::default()
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
            .on_download(|_webview, _event| false)
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
            });

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
    if let Some(tray) = app.tray_by_id("tray") {
        let _ = tray.set_icon(Some(icon_for(settled)));
        let _ = tray.set_tooltip(Some(tooltip(settled)));
    }
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
