//! Native notifications with a click that opens the thread. Linux: freedesktop notifications over D-Bus (notify-rust,
//! "default" action = a click on the bubble). Windows: WinRT toasts (activation callback). Both call `on_click(url)`.
#[cfg(any(target_os = "linux", windows))]
use std::sync::Arc;

pub struct Note {
    pub title: String,
    pub body: String,
    pub url: String,
    pub tag: String,
}

#[cfg(target_os = "linux")]
pub fn show(_app_id: &str, n: Note, on_click: Arc<dyn Fn(String) + Send + Sync>) {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    // A newer notification with the same tag replaces the old bubble instead of stacking (like the Mac app's tags).
    static IDS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    let ids = IDS.get_or_init(Default::default);
    std::thread::spawn(move || {
        let mut x = notify_rust::Notification::new();
        x.appname("Gibbous")
            .summary(&n.title)
            .body(&n.body)
            .icon("gibbous")
            .action("default", "Open")
            .hint(notify_rust::Hint::DesktopEntry("gibbous".into()));
        if !n.tag.is_empty() {
            if let Some(id) = ids.lock().unwrap().get(&n.tag) {
                x.id(*id);
            }
        }
        match x.show() {
            Ok(h) => {
                if !n.tag.is_empty() {
                    ids.lock().unwrap().insert(n.tag.clone(), h.id());
                }
                let url = n.url.clone();
                h.wait_for_action(move |a| {
                    if a == "default" || a == "Open" {
                        on_click(url.clone())
                    }
                });
            }
            Err(e) => eprintln!("gibbous: notification failed: {e}"),
        }
    });
}

#[cfg(windows)]
pub fn show(app_id: &str, n: Note, on_click: Arc<dyn Fn(String) + Send + Sync>) {
    use tauri_winrt_notification::{Sound, Toast};
    let url = n.url.clone();
    let r = Toast::new(app_id)
        .title(&n.title)
        .text1(&n.body)
        .sound(Some(Sound::Default))
        .on_activated(move |_| {
            on_click(url.clone());
            Ok(())
        })
        .show();
    if let Err(e) = r {
        eprintln!("gibbous: notification failed: {e}");
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
pub fn show(_app_id: &str, n: Note, _on_click: std::sync::Arc<dyn Fn(String) + Send + Sync>) {
    // macOS keeps the Swift app (desktop/Gibbous.swift); this only exists so the crate builds there for tests.
    eprintln!("gibbous: notification: {} — {}", n.title, n.body);
}
