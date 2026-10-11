//! Gibbous for Windows and Linux: a native window around the Gibbous server, like desktop/Gibbous.swift on macOS.
//! Signs in to the LOCAL server by itself (GIBBOUS_HOME/login-url + secret.json), or to a server whose sign-in link you
//! pasted on the connect screen (ui/index.html). Page ⇄ app contract: web/src/desktopBridge.ts.
//! Builds with a bundled server (tauri.server.conf.json) start it when nothing answers locally: server.rs.
mod link;
mod notify;
mod server;

use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::menu::{CheckMenuItem, MenuBuilder, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};
use url::Url;

pub use link::*;

const MAIN: &str = "main";
const DEFAULT_SERVER: &str = "http://127.0.0.1:7878";

// ── remembered settings (app config dir/settings.json) ───────────────────────
#[derive(Default, Serialize, Deserialize, Clone)]
struct Saved {
    /// A server picked on the connect screen (absent: the local server's own login-url).
    server: Option<String>,
    /// Its token, when the pasted link had one (the cookie usually signs in anyway).
    token: Option<String>,
    /// Where you were, reopened on launch.
    route: Option<String>,
}

#[derive(Serialize, Clone)]
struct Status {
    server: String,
    /// connecting | unreachable | ok
    state: String,
    local: bool,
}

struct Shell {
    file: PathBuf,
    saved: Mutex<Saved>,
    status: Mutex<Status>,
    base: Mutex<Url>,
    autostart: Mutex<Option<CheckMenuItem<Wry>>>,
    /// resources/gibbous-server, when this build carries the server.
    bundle: Option<PathBuf>,
    server: server::LocalServer,
    background: Mutex<Option<CheckMenuItem<Wry>>>,
}

impl Shell {
    fn save(&self) {
        let s = self.saved.lock().unwrap().clone();
        if let Some(d) = self.file.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(&self.file, serde_json::to_vec_pretty(&s).unwrap_or_default());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.file, std::fs::Permissions::from_mode(0o600));
        }
    }
}

fn shell(app: &AppHandle) -> tauri::State<'_, Shell> {
    app.state::<Shell>()
}

// ── where the server is ──────────────────────────────────────────────────────
fn gibbous_home(app: &AppHandle) -> PathBuf {
    if let Some(h) = std::env::var_os("GIBBOUS_HOME").filter(|h| !h.is_empty()) {
        return PathBuf::from(h);
    }
    app.path().home_dir().unwrap_or_default().join(".gibbous")
}

struct Target {
    base: Url,
    token: String,
    local: bool,
}

/// $GIBBOUS_URL, else a server picked on the connect screen, else the local server's own link (follows a changed
/// port), else the default port. The local token is read fresh each time (the server may have re-keyed).
fn target(app: &AppHandle) -> Target {
    let home = gibbous_home(app);
    let local_link = std::fs::read_to_string(home.join("login-url")).ok().and_then(|s| parse_login_file(&s));
    let local_origin = local_link.as_ref().and_then(origin);
    let saved = shell(app).saved.lock().unwrap().clone();
    let saved_server = saved.server.as_deref().and_then(|s| Url::parse(s).ok()).and_then(|u| origin(&u));
    let env = std::env::var("GIBBOUS_URL").ok().and_then(|s| Url::parse(&s).ok()).and_then(|u| origin(&u));
    let base = env
        .or(saved_server.clone())
        .or(local_origin.clone())
        .unwrap_or_else(|| Url::parse(DEFAULT_SERVER).unwrap());
    let local = local_origin.as_ref().is_some_and(|o| same_origin(o, &base));
    let token = if local {
        let secret = std::fs::read_to_string(home.join("secret.json")).ok();
        local_token(secret.as_deref(), local_link.as_ref())
    } else if saved_server.as_ref().is_some_and(|s| same_origin(s, &base)) {
        saved.token.unwrap_or_default()
    } else {
        String::new()
    };
    Target { base, token, local }
}

fn is_loopback(u: &Url) -> bool {
    matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]" | "::1"))
}

/// Start the bundled server when this computer's Gibbous doesn't answer: not for a pasted remote server or
/// $GIBBOUS_URL, and never next to your own service or the background one (those start it themselves). True while
/// the app's own server is running (it may still be booting).
fn ensure_server(app: &AppHandle) -> bool {
    let sh = shell(app);
    let Some(bundle) = sh.bundle.clone() else { return false };
    if sh.server.running() {
        return true;
    }
    let t = target(app);
    let remote = sh.saved.lock().unwrap().server.is_some() || std::env::var_os("GIBBOUS_URL").is_some();
    if remote || !is_loopback(&t.base) || server::own_service() || server::background_enabled() || reachable(&t.base) {
        return false;
    }
    let port = t.base.port_or_known_default().unwrap_or(7878);
    match sh.server.start(&bundle, &gibbous_home(app), port) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("gibbous: {e}");
            false
        }
    }
}

fn reachable(u: &Url) -> bool {
    let Some(host) = u.host_str() else { return false };
    let port = u.port_or_known_default().unwrap_or(80);
    let host = host.trim_start_matches('[').trim_end_matches(']');
    (host, port)
        .to_socket_addrs()
        .map(|addrs| addrs.into_iter().any(|a| TcpStream::connect_timeout(&a, Duration::from_millis(800)).is_ok()))
        .unwrap_or(false)
}

/// The app's own pages (the connect screen): tauri://localhost on Linux, http://tauri.localhost on Windows.
fn is_app_page(u: &Url) -> bool {
    u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost")
}
fn app_page() -> Url {
    Url::parse(if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" }).unwrap()
}

/// Lets the pages of this server (and only them) call the bridge. Tauri denies remote origins any command that no
/// capability grants; the server can change at runtime (a pasted link), so the grant is added per origin.
fn allow_server(app: &AppHandle, base: &Url) {
    use std::collections::HashSet;
    use std::sync::OnceLock;
    static ALLOWED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let key = base.as_str().trim_end_matches('/').to_string();
    if !ALLOWED.get_or_init(Default::default).lock().unwrap().insert(key.clone()) {
        return;
    }
    let n = ALLOWED.get().unwrap().lock().unwrap().len();
    let cap = tauri::ipc::CapabilityBuilder::new(format!("gibbous-server-{n}"))
        .remote(format!("{key}/*"))
        .local(false)
        .window(MAIN)
        .permission("allow-bridge")
        .permission("allow-save-download");
    if let Err(e) = app.add_capability(cap) {
        eprintln!("gibbous: couldn't allow {key}: {e}");
    }
}

fn set_status(app: &AppHandle, base: &Url, state: &str, local: bool) {
    *shell(app).status.lock().unwrap() = Status { server: base.as_str().trim_end_matches('/').to_string(), state: state.into(), local };
}

/// Open Gibbous: sign in and land on the last route, or the connect screen when the server can't be reached (it
/// keeps retrying in the background, like the Mac app while launchd starts the server).
fn connect(app: &AppHandle, show_connect_page: bool) {
    let t = target(app);
    *shell(app).base.lock().unwrap() = t.base.clone();
    allow_server(app, &t.base);
    let Some(w) = app.get_webview_window(MAIN) else { return };
    if !show_connect_page && reachable(&t.base) {
        set_status(app, &t.base, "ok", t.local);
        let route = shell(app).saved.lock().unwrap().route.clone().unwrap_or_default();
        let _ = w.navigate(login_url(&t.base, &t.token, &route));
    } else {
        let starting = !show_connect_page && ensure_server(app);
        set_status(app, &t.base, if show_connect_page { "signin" } else if starting { "starting" } else { "unreachable" }, t.local);
        if !w.url().is_ok_and(|u| is_app_page(&u)) {
            let _ = w.navigate(app_page());
        }
    }
}

fn retry_loop(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(3));
        let st = shell(&app).status.lock().unwrap().clone();
        if st.state == "unreachable" || st.state == "starting" {
            let base = shell(&app).base.lock().unwrap().clone();
            if !reachable(&base) && ensure_server(&app) && st.state == "unreachable" {
                set_status(&app, &base, "starting", st.local);
            }
            if reachable(&base) {
                let a = app.clone();
                let _ = app.run_on_main_thread(move || connect(&a, false));
            }
        }
    });
}

// ── window ───────────────────────────────────────────────────────────────────
fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

fn show(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let was_hidden = !w.is_visible().unwrap_or(true);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        if was_hidden {
            let _ = w.eval("window.gibbousNative?.({ type: 'resume' })");
        }
    }
}

fn toggle(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        if std::env::var_os("GIBBOUS_DEBUG").is_some() {
            eprintln!("gibbous: toggle visible={:?} focused={:?} minimized={:?}", w.is_visible(), w.is_focused(), w.is_minimized());
        }
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show(app);
        }
    }
}

fn go_route(app: &AppHandle, hash: &str) {
    show(app);
    if let Some(w) = main_window(app) {
        if w.url().is_ok_and(|u| !is_app_page(&u)) {
            let _ = w.eval(&format!("location.hash = {}", json!(hash)));
        }
    }
}

fn open_from_notification(app: &AppHandle, url: &str) {
    show(app);
    if let Some(w) = main_window(app) {
        let _ = w.eval(&format!("window.gibbousNative?.({})", json!({ "type": "open", "url": url })));
    }
}

fn shell_script(app: &AppHandle) -> String {
    let platform = if cfg!(windows) { "windows" } else { "linux" };
    let info = app.package_info();
    let shell = json!({ "platform": platform, "version": info.version.to_string(), "build": env!("CARGO_PKG_VERSION") });
    include_str!("shell.js").replace("__SHELL__", &shell.to_string())
}

/// Main-frame navigations: Gibbous pages stay in the window; web links of other origins open in the default
/// browser, editor/mail links in their app; a file route opened as a page is saved instead of replacing the app.
fn allow_navigation(app: &AppHandle, u: &Url) -> bool {
    if is_app_page(u) || matches!(u.scheme(), "about" | "blob" | "data") {
        return true;
    }
    let base = shell(app).base.lock().unwrap().clone();
    if matches!(u.scheme(), "http" | "https") && same_origin(u, &base) {
        if matches!(u.path(), "/api/media" | "/api/image") {
            let name = u.query_pairs().find(|(k, _)| k == "path").map(|(_, v)| v.into_owned()).unwrap_or_default();
            if let Some(w) = main_window(app) {
                let _ = w.eval(&format!(
                    "window.gibbousDesktop.post('download', {})",
                    json!({ "url": u.as_str(), "filename": safe_filename(&name) })
                ));
            }
            return false;
        }
        return true;
    }
    open_external(app, u);
    false
}

fn open_external(app: &AppHandle, u: &Url) {
    if !openable(u) {
        return;
    }
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = app.opener().open_url(u.as_str(), None::<&str>) {
        eprintln!("gibbous: couldn't open {u}: {e}");
    }
}

fn downloads_dir(app: &AppHandle) -> PathBuf {
    app.path().download_dir().unwrap_or_else(|_| app.path().home_dir().unwrap_or_default().join("Downloads"))
}

fn native_notify(app: &AppHandle, title: &str, body: &str, url: &str, tag: &str) {
    let a = app.clone();
    let on_click = Arc::new(move |u: String| {
        let b = a.clone();
        let _ = a.run_on_main_thread(move || open_from_notification(&b, &u));
    });
    let id = app.config().identifier.clone();
    notify::show(&id, notify::Note { title: title.into(), body: body.into(), url: url.into(), tag: tag.into() }, on_click);
}

#[cfg(windows)]
fn badge_dot() -> tauri::image::Image<'static> {
    // A 16×16 dot for the taskbar overlay (Windows has no numeric taskbar badge; the title carries the count).
    let n = 16usize;
    let mut px = vec![0u8; n * n * 4];
    for y in 0..n {
        for x in 0..n {
            let (dx, dy) = (x as f32 - 7.5, y as f32 - 7.5);
            if dx * dx + dy * dy <= 7.0 * 7.0 {
                px[(y * n + x) * 4..][..4].copy_from_slice(&[0xe5, 0x48, 0x4d, 0xff]);
            }
        }
    }
    tauri::image::Image::new_owned(px, n as u32, n as u32)
}

fn set_badge(app: &AppHandle, n: i64) {
    if let Some(w) = main_window(app) {
        let _ = w.set_title(&if n > 0 { format!("({n}) Gibbous") } else { "Gibbous".into() });
        #[cfg(target_os = "linux")]
        let _ = w.set_badge_count(if n > 0 { Some(n) } else { None });
        #[cfg(windows)]
        let _ = w.set_overlay_icon(if n > 0 { Some(badge_dot()) } else { None });
    }
    if let Some(t) = app.tray_by_id(MAIN) {
        let _ = t.set_tooltip(Some(&if n > 0 { format!("Gibbous — {n} waiting on you") } else { "Gibbous".into() }));
        #[cfg(target_os = "linux")]
        let _ = t.set_title(Some(&if n > 0 { n.to_string() } else { String::new() }));
    }
}

// ── page → app ───────────────────────────────────────────────────────────────
fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// window.gibbousDesktop.post(name, body) from web/src/desktopBridge.ts and the connect screen.
#[tauri::command]
fn bridge(app: AppHandle, webview: tauri::Webview, name: String, body: Value) -> Result<Value, String> {
    let from_app_page = webview.url().is_ok_and(|u| is_app_page(&u));
    match name.as_str() {
        "notify" => native_notify(&app, &s(&body, "title"), &s(&body, "body"), &s(&body, "url"), &s(&body, "tag")),
        "badge" => set_badge(&app, body.get("count").and_then(Value::as_i64).unwrap_or(0)),
        "open" => {
            let u = Url::parse(&s(&body, "url")).map_err(|e| e.to_string())?;
            if !openable(&u) {
                return Err(format!("won't open {} links", u.scheme()));
            }
            open_external(&app, &u)
        }
        "reveal" => {
            let p = PathBuf::from(s(&body, "path"));
            if !p.starts_with(downloads_dir(&app)) {
                return Err("only files in Downloads".into());
            }
            tauri_plugin_opener::reveal_item_in_dir(&p).map_err(|e| e.to_string())?
        }
        "route" => {
            let r = s(&body, "route");
            if is_route(&r) {
                let sh = shell(&app);
                sh.saved.lock().unwrap().route = Some(r);
                sh.save();
            }
        }
        // The connect screen only (a page of the server can't repoint the app).
        "status" if from_app_page => return Ok(serde_json::to_value(shell(&app).status.lock().unwrap().clone()).unwrap()),
        "retry" if from_app_page => connect(&app, false),
        "connect" if from_app_page => {
            let p = parse_pasted(&s(&body, "link")).ok_or("That doesn't look like a sign-in link")?;
            let sh = shell(&app);
            {
                let mut saved = sh.saved.lock().unwrap();
                if let Some(server) = &p.server {
                    // The local server's own address: keep following its login-url (port, token) instead of pinning it.
                    let home = gibbous_home(&app);
                    let local = std::fs::read_to_string(home.join("login-url")).ok().and_then(|s| parse_login_file(&s)).and_then(|u| origin(&u));
                    if local.is_some_and(|l| same_origin(&l, server)) {
                        saved.server = None;
                        saved.token = None;
                    } else {
                        saved.server = Some(server.to_string());
                        saved.token = p.token.clone();
                    }
                    saved.route = None;
                } else {
                    saved.token = p.token.clone();
                }
            }
            sh.save();
            let t = target(&app);
            if !reachable(&t.base) {
                connect(&app, false);
                return Err(format!("Can't reach {}", t.base.as_str().trim_end_matches('/')));
            }
            // A pasted token for a server we already follow wins over the stored one for this sign-in.
            let token = p.token.unwrap_or(t.token);
            *sh.base.lock().unwrap() = t.base.clone();
            allow_server(&app, &t.base);
            set_status(&app, &t.base, "ok", t.local);
            if let Some(w) = main_window(&app) {
                let _ = w.navigate(login_url(&t.base, &token, ""));
            }
        }
        "forget" if from_app_page => {
            let sh = shell(&app);
            *sh.saved.lock().unwrap() = Saved::default();
            sh.save();
            connect(&app, false);
        }
        _ => return Err(format!("unknown message {name}")),
    }
    Ok(Value::Null)
}

/// The bytes of a download the page fetched with its cookies (desktopDownload); saved into Downloads, never
/// overwriting. Header x-filename: the suggested name (URI-encoded). Returns the saved path.
#[tauri::command]
fn save_download(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let bytes: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        tauri::ipc::InvokeBody::Json(Value::Array(a)) => a.iter().map(|v| v.as_u64().unwrap_or(0) as u8).collect(),
        tauri::ipc::InvokeBody::Json(Value::Object(o)) => {
            // A Uint8Array serialized as {"0":1,"1":2,…} by a JSON-only transport.
            let mut v: Vec<(usize, u8)> = o.iter().filter_map(|(k, v)| Some((k.parse().ok()?, v.as_u64()? as u8))).collect();
            v.sort_unstable_by_key(|p| p.0);
            v.into_iter().map(|p| p.1).collect()
        }
        _ => return Err("expected the file's bytes".into()),
    };
    let raw = request.headers().get("x-filename").and_then(|v| v.to_str().ok()).unwrap_or("");
    let name = url::form_urlencoded::parse(format!("n={}", raw.replace('+', "%2B")).as_bytes()).next().map(|(_, v)| v.into_owned()).unwrap_or_default();
    let dir = downloads_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = unique_path(&dir, &safe_filename(&name), |p| p.exists());
    std::fs::write(&path, bytes).map_err(|e| format!("couldn't save {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

// ── app ──────────────────────────────────────────────────────────────────────
fn build_window(app: &AppHandle, hidden: bool) -> tauri::Result<WebviewWindow> {
    let t = target(app);
    *shell(app).base.lock().unwrap() = t.base.clone();
    allow_server(app, &t.base);
    let up = reachable(&t.base);
    let starting = !up && ensure_server(app);
    set_status(app, &t.base, if up { "ok" } else if starting { "starting" } else { "unreachable" }, t.local);
    let start = if up {
        let route = shell(app).saved.lock().unwrap().route.clone().unwrap_or_default();
        WebviewUrl::External(login_url(&t.base, &t.token, &route))
    } else {
        WebviewUrl::App("index.html".into())
    };
    let nav = app.clone();
    let dl = app.clone();
    let nw = app.clone();
    WebviewWindowBuilder::new(app, MAIN, start)
        .title("Gibbous")
        .inner_size(1280.0, 860.0)
        .min_inner_size(400.0, 360.0)
        .center()
        .visible(!hidden)
        .background_color(tauri::window::Color(0x16, 0x18, 0x1d, 0xff))
        .zoom_hotkeys_enabled(false)
        .initialization_script(shell_script(app))
        .on_navigation(move |u| allow_navigation(&nav, u))
        .on_new_window(move |u, _features| {
            // target=_blank / window.open: never a second Gibbous window. Files are saved, the rest opens outside.
            allow_navigation(&nw, &u);
            NewWindowResponse::Deny
        })
        .on_download(move |_w, event| {
            match event {
                DownloadEvent::Requested { destination, .. } => {
                    let name = destination.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    let dir = downloads_dir(&dl);
                    let _ = std::fs::create_dir_all(&dir);
                    *destination = unique_path(&dir, &safe_filename(&name), |p| p.exists());
                }
                DownloadEvent::Finished { path, success, .. } => {
                    if success {
                        let name = path.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                        native_notify(&dl, "Saved to Downloads", &name, "", "");
                    }
                }
                _ => {}
            }
            true
        })
        .on_page_load(|w, p| {
            // A stale token (server re-keyed) answers 401 at /login: show the page's own Sign in screen instead.
            if p.event() == PageLoadEvent::Finished && p.url().path() == "/login" && !is_app_page(p.url()) {
                let mut root = p.url().clone();
                root.set_path("/");
                root.set_query(None);
                let _ = w.navigate(root);
            }
        })
        .build()
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri_plugin_autostart::ManagerExt;
    let on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(app, "autostart", "Launch at login", true, on, None::<&str>)?;
    let menu = MenuBuilder::new(app)
        .item(&MenuItem::with_id(app, "open", "Open Gibbous   Ctrl+Alt+Space", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "new", "New thread", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "inbox", "Inbox", true, None::<&str>)?)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&autostart);
    let menu = if shell(app).bundle.is_some() {
        // Your own install (scripts/install-service.*) already runs Gibbous at login; the app leaves it alone.
        let bg = CheckMenuItem::with_id(app, "background", "Keep Gibbous running in the background", !server::own_service(), server::background_enabled(), None::<&str>)?;
        *shell(app).background.lock().unwrap() = Some(bg.clone());
        menu.item(&bg)
    } else {
        menu
    };
    let menu = menu
        .item(&MenuItem::with_id(app, "signin", "Sign in with a link…", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "reload", "Reload", true, None::<&str>)?)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&MenuItem::with_id(app, "quit", "Quit Gibbous", true, None::<&str>)?)
        .build()?;
    *shell(app).autostart.lock().unwrap() = Some(autostart);
    let mut tray = TrayIconBuilder::with_id(MAIN).tooltip("Gibbous").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, e| match e.id().as_ref() {
        "open" => show(app),
        "new" => go_route(app, "#/new"),
        "inbox" => go_route(app, "#/inbox"),
        "signin" => {
            show(app);
            connect(app, true)
        }
        "reload" => {
            show(app);
            connect(app, false)
        }
        "autostart" => {
            use tauri_plugin_autostart::ManagerExt;
            let al = app.autolaunch();
            let want = !al.is_enabled().unwrap_or(false);
            let r = if want { al.enable() } else { al.disable() };
            if let Err(e) = r {
                eprintln!("gibbous: launch at login: {e}");
            }
            if let Some(i) = shell(app).autostart.lock().unwrap().as_ref() {
                let _ = i.set_checked(al.is_enabled().unwrap_or(false));
            }
        }
        "background" => {
            let a = app.clone();
            std::thread::spawn(move || {
                let on = !server::background_enabled();
                let sh = shell(&a);
                // The service takes over the same port: stop ours first; turning it off starts ours again.
                if on {
                    sh.server.stop();
                }
                if let Err(e) = server::set_background(on) {
                    eprintln!("gibbous: background server: {e}");
                    native_notify(&a, "Couldn't change the background server", &e, "", "");
                }
                if let Some(i) = sh.background.lock().unwrap().as_ref() {
                    let _ = i.set_checked(server::background_enabled());
                }
                std::thread::sleep(Duration::from_secs(1));
                let b = a.clone();
                let _ = a.run_on_main_thread(move || connect(&b, false));
            });
        }
        "quit" => app.exit(0),
        _ => {}
    })
    .on_tray_icon_event(|tray, e| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
            toggle(tray.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}

fn register_hotkey(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
    let sc = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
    // Not fatal: Wayland sessions and some desktops don't allow global shortcuts.
    if let Err(e) = app.global_shortcut().on_shortcut(sc, |app, _, ev| {
        if ev.state == ShortcutState::Pressed {
            toggle(app)
        }
    }) {
        eprintln!("gibbous: Ctrl+Alt+Space unavailable: {e}");
    }
}

pub fn run() {
    let ctx = tauri::generate_context!();
    // `gibbous --serve`: the background service's entry point, no window.
    if std::env::args().any(|a| a == "--serve") {
        let dir = tauri::utils::platform::resource_dir(ctx.package_info(), &tauri::Env::default()).ok();
        let Some(bundle) = server::bundle_dir(dir) else {
            eprintln!("gibbous --serve: this build has no bundled server");
            std::process::exit(1)
        };
        std::process::exit(server::serve(&bundle));
    }
    let hidden = std::env::args().any(|a| a == "--hidden");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![bridge, save_download])
        .setup(move |app| {
            let h = app.handle().clone();
            let file = h.path().app_config_dir()?.join("settings.json");
            let saved: Saved = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            let bundle = server::bundle_dir(h.path().resource_dir().ok());
            h.manage(Shell {
                file,
                saved: Mutex::new(saved),
                status: Mutex::new(Status { server: String::new(), state: "connecting".into(), local: false }),
                base: Mutex::new(Url::parse(DEFAULT_SERVER).unwrap()),
                autostart: Mutex::new(None),
                bundle,
                server: Default::default(),
                background: Mutex::new(None),
            });
            build_window(&h, hidden)?;
            if let Err(e) = build_tray(&h) {
                eprintln!("gibbous: no tray icon: {e}");
            }
            register_hotkey(&h);
            retry_loop(h);
            Ok(())
        })
        .on_window_event(|w, e| {
            // Closing the window keeps Gibbous in the tray (notifications keep coming); Quit is in the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = e {
                if w.label() == MAIN && w.app_handle().tray_by_id(MAIN).is_some() {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
        })
        .build(ctx)
        .expect("error while running Gibbous")
        .run(|app, e| {
            // Quit stops the server this app started (a background service or your own one keeps running).
            if let RunEvent::Exit = e {
                if let Some(sh) = app.try_state::<Shell>() {
                    sh.server.stop();
                }
            }
        });
}
