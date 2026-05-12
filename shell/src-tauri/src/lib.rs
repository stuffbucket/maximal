// Maximal tray + sidecar shell.
//
// Tauri 2 menu-bar app. Responsibilities:
//   1. Spawn the bundled `maximal` binary as a sidecar — proxy on
//      http://127.0.0.1:4142 (SIDECAR_PORT).
//   2. Poll /setup-status with ~250ms backoff for up to 5s while the
//      sidecar binds. Cache the latest SetupStatus and rebuild the
//      tray menu / icon to reflect ready vs. needs-setup.
//   3. Tray: "Open Maximal" (subtitled "Set up first" when not ready),
//      "Settings", "Quit Maximal". No standalone "Sign in" item —
//      that lives inside the Setup window's CTA (PRD §"Tray menu
//      while not ready").
//   4. On "Open Maximal" while not ready, open the Setup window
//      (Tauri WebviewWindow pointing at the Vite-built setup.html).
//      When ready: TODO dashboard (see docs/dashboard-window-prd.md).
//   5. SIGTERM the sidecar on ExitRequested.
//
// HTTP contract assumed (matches docs/first-run-setup-prd.md and the
// proxy-side agent's PR):
//   GET /setup-status -> { ready: bool, checks: {...}, nextStep: string|null }

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use image::{Rgba, RgbaImage};
use serde::Deserialize;
use tauri::image::Image as TauriImage;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// ---------- Sidecar process plumbing ----------

struct Sidecar(Mutex<Option<CommandChild>>);

impl Sidecar {
    fn new() -> Self {
        Self(Mutex::new(None))
    }
    fn set(&self, child: CommandChild) {
        *self.0.lock().expect("sidecar mutex poisoned") = Some(child);
    }
    fn take(&self) -> Option<CommandChild> {
        self.0.lock().expect("sidecar mutex poisoned").take()
    }
}

const SIDECAR_PORT: u16 = 4142;
const TRAY_ID: &str = "main";
const SETUP_WINDOW_LABEL: &str = "setup";

mod menu_id {
    pub const OPEN: &str = "open";
    pub const SETTINGS: &str = "settings";
    pub const QUIT: &str = "quit";
}

// ---------- Setup status (mirrors the proxy contract) ----------

#[derive(Debug, Clone, Deserialize)]
struct SetupStatus {
    ready: bool,
    #[serde(default, rename = "nextStep")]
    next_step: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct SetupState {
    /// Latest /setup-status; None until the first successful poll.
    status: Option<SetupStatus>,
    /// True once the sidecar bind+poll window has elapsed without
    /// any successful /setup-status response. Used to flip the tray
    /// tooltip to "Maximal failed to start" per PRD §Failure Modes.
    bind_failed: bool,
}

struct SharedSetupState(Mutex<SetupState>);

impl SharedSetupState {
    fn new() -> Self {
        Self(Mutex::new(SetupState::default()))
    }
    fn snapshot(&self) -> SetupState {
        self.0.lock().expect("setup state mutex poisoned").clone()
    }
    fn replace(&self, next: SetupState) {
        *self.0.lock().expect("setup state mutex poisoned") = next;
    }
}

// ---------- Entry ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar::new())
        .manage(SharedSetupState::new())
        .setup(|app| {
            spawn_sidecar(app.handle())?;
            install_tray(app.handle())?;
            start_setup_status_poller(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { .. } = event {
            kill_sidecar(app_handle);
        }
    });
}

// ---------- Sidecar lifecycle ----------

fn spawn_sidecar(app: &AppHandle) -> tauri::Result<()> {
    let port = SIDECAR_PORT.to_string();
    let cmd = app
        .shell()
        .sidecar("maximal")
        .map_err(|e| tauri::Error::Anyhow(e.into()))?
        .args(["start", "--port", port.as_str()]);

    let (mut rx, child) = cmd.spawn().map_err(|e| tauri::Error::Anyhow(e.into()))?;
    app.state::<Sidecar>().set(child);

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[maximal] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[maximal] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[maximal] sidecar exited: {:?}", payload);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

fn kill_sidecar(app: &AppHandle) {
    if let Some(child) = app.state::<Sidecar>().take() {
        let _ = child.kill();
    }
}

// ---------- Setup-status poller ----------

/// Polls /setup-status with 250ms backoff for up to 5s on initial
/// boot. Once the proxy answers, polls every 10s thereafter to pick
/// up auth-success transitions. Re-polls on demand are exposed via
/// `refresh_setup_status` (called when the Setup window opens or
/// closes successfully).
fn start_setup_status_poller(app: AppHandle) {
    thread::spawn(move || {
        let mut bound = false;
        for _ in 0..20 {
            // 20 × 250ms = 5s budget per PRD §Detection on shell launch
            if let Some(status) = fetch_setup_status() {
                update_state_with_status(&app, status);
                bound = true;
                break;
            }
            thread::sleep(Duration::from_millis(250));
        }
        if !bound {
            // Sidecar never answered; flip into the "failed to start"
            // tray state.
            let state = app.state::<SharedSetupState>();
            let mut snap = state.snapshot();
            snap.bind_failed = true;
            state.replace(snap);
            rebuild_tray(&app);
            return;
        }
        // Steady-state poll.
        loop {
            thread::sleep(Duration::from_secs(10));
            if let Some(status) = fetch_setup_status() {
                update_state_with_status(&app, status);
            }
        }
    });
}

fn fetch_setup_status() -> Option<SetupStatus> {
    let url = format!("http://127.0.0.1:{SIDECAR_PORT}/setup-status");
    let res = ureq::get(&url)
        .timeout(Duration::from_millis(2000))
        .call()
        .ok()?;
    let body = res.into_string().ok()?;
    serde_json::from_str(&body).ok()
}

fn update_state_with_status(app: &AppHandle, status: SetupStatus) {
    let state = app.state::<SharedSetupState>();
    let before = state.snapshot();
    let dirty = before
        .status
        .as_ref()
        .map(|s| s.ready != status.ready || s.next_step != status.next_step)
        .unwrap_or(true);
    state.replace(SetupState {
        status: Some(status),
        bind_failed: false,
    });
    if dirty {
        rebuild_tray(app);
    }
}

// ---------- Tray ----------

fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let (menu, _) = build_menu(app, &SetupState::default())?;
    let icon = icon_for_state(app, &SetupState::default());

    TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("maximal")
        .icon(icon)
        .on_menu_event(|app, event| match event.id().as_ref() {
            menu_id::OPEN => open_main_surface(app),
            menu_id::SETTINGS => open_settings(app),
            menu_id::QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|_tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            { /* reserved */ }
        })
        .build(app)?;
    Ok(())
}

/// Build a menu reflecting the current SetupState. The "Open Maximal"
/// item's label carries a subtitle while setup is incomplete; macOS
/// renders the second line in smaller type, matching the PRD ASCII
/// mock (`Open Maximal       (subtitled: "Set up first")`).
fn build_menu(
    app: &AppHandle,
    state: &SetupState,
) -> tauri::Result<(Menu<tauri::Wry>, bool)> {
    let needs_setup = setup_not_ready(state);
    let open_label = if needs_setup {
        // Two lines: macOS shows the second smaller and dimmer in
        // NSMenu. On Windows/Linux it becomes a single line — still
        // readable, just not visually subtitled.
        "Open Maximal\nSet up first"
    } else {
        "Open Maximal"
    };
    let open = MenuItem::with_id(app, menu_id::OPEN, open_label, true, None::<&str>)?;
    let settings = MenuItem::with_id(
        app,
        menu_id::SETTINGS,
        "Settings",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(
        app,
        menu_id::QUIT,
        "Quit Maximal",
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let menu = Menu::with_items(app, &[&open, &settings, &separator, &quit])?;
    Ok((menu, needs_setup))
}

fn setup_not_ready(state: &SetupState) -> bool {
    if state.bind_failed {
        return true;
    }
    match &state.status {
        Some(s) => !s.ready,
        // No status yet — assume "in progress", show neutral menu.
        None => false,
    }
}

fn rebuild_tray(app: &AppHandle) {
    let state = app.state::<SharedSetupState>().snapshot();
    let (menu, needs_setup) = match build_menu(app, &state) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[tray] menu rebuild failed: {e}");
            return;
        }
    };
    let icon = icon_for_state(app, &state);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_menu(Some(menu));
        let _ = tray.set_icon(Some(icon));
        let tooltip = if state.bind_failed {
            "Maximal failed to start"
        } else if needs_setup {
            "maximal — set up first"
        } else {
            "maximal"
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

// ---------- Tray icon (default + tinted badge variant) ----------

fn icon_for_state(app: &AppHandle, state: &SetupState) -> TauriImage<'static> {
    let default = app
        .default_window_icon()
        .cloned()
        .map(|img| img.to_owned())
        .expect("default window icon should always be available");
    if setup_not_ready(state) {
        match make_badge_icon(&default) {
            Some(img) => img,
            None => default,
        }
    } else {
        default
    }
}

/// Draws a small accent dot on the top-right of the default icon to
/// signal "needs setup." Quiet — not a bright red star, just a
/// noticeable hint per PRD §Tray menu.
///
/// Returns None if the icon bytes don't decode; the caller falls back
/// to the unbadged icon, which is preferable to a blank tray slot.
fn make_badge_icon(default: &TauriImage<'static>) -> Option<TauriImage<'static>> {
    let w = default.width();
    let h = default.height();
    let mut buf = RgbaImage::from_raw(w, h, default.rgba().to_vec())?;

    // Dot sized as a fraction of the icon; keeps proportions on
    // hidpi vs. 16/22px tray icons.
    let radius = ((w.min(h) as f32) * 0.18).round().max(2.0) as i32;
    let center_x = w as i32 - radius - 1;
    let center_y = radius + 1;
    let accent: Rgba<u8> = Rgba([200, 51, 74, 255]); // --accent (#c8334a)
    let ring: Rgba<u8> = Rgba([10, 10, 10, 255]); // soft halo so the dot reads on light backgrounds

    for y in 0..h as i32 {
        for x in 0..w as i32 {
            let dx = x - center_x;
            let dy = y - center_y;
            let d2 = dx * dx + dy * dy;
            let r2 = radius * radius;
            if d2 <= r2 {
                buf.put_pixel(x as u32, y as u32, accent);
            } else if d2 <= (radius + 1) * (radius + 1) {
                buf.put_pixel(x as u32, y as u32, ring);
            }
        }
    }

    // Tauri's Image wraps raw RGBA bytes plus width/height; no
    // re-encoding needed.
    let (w, h) = (buf.width(), buf.height());
    Some(TauriImage::new_owned(buf.into_raw(), w, h))
}

// ---------- Tray actions ----------

fn open_main_surface(app: &AppHandle) {
    let state = app.state::<SharedSetupState>().snapshot();
    if setup_not_ready(&state) {
        open_setup_window(app);
        // Re-poll once the user touches the window so a successful
        // CLI auth picks up quickly.
        let app_handle = app.clone();
        thread::spawn(move || {
            if let Some(status) = fetch_setup_status() {
                update_state_with_status(&app_handle, status);
            }
        });
    } else {
        // TODO: bridge to dashboard #connect when the Dashboard
        // window lands. See docs/dashboard-window-prd.md.
        open_setup_window(app);
    }
}

fn open_setup_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(SETUP_WINDOW_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let url = WebviewUrl::App("setup.html".into());
    let result = WebviewWindowBuilder::new(app, SETUP_WINDOW_LABEL, url)
        .title("Maximal — Setup")
        .inner_size(520.0, 620.0)
        .min_inner_size(480.0, 560.0)
        .max_inner_size(720.0, 800.0)
        .resizable(true)
        .center()
        .build();
    if let Err(e) = result {
        eprintln!("[setup] failed to open window: {e}");
    }
}

fn open_settings(app: &AppHandle) {
    // Until the Settings window ships, fall back to revealing the
    // app-data dir — same behavior as the previous spike code.
    let Ok(home) = app.path().home_dir() else {
        return;
    };
    let dir = home.join(".local").join("share").join("maximal");
    let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
}
