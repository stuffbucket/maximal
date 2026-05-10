// Maximal tray + sidecar shell.
//
// Tauri 2 menu-bar app. On launch we:
//   1. Spawn the bundled `maximal` binary as a sidecar — it serves
//      the proxy on http://localhost:4141.
//   2. Show a tray icon with: Open Dashboard, Open Logs Folder, Quit.
//   3. Hold the sidecar's CommandChild so we can SIGTERM it when the
//      user picks Quit. Tauri 2 issue #3564 documents the orphan-
//      child pitfall — keeping the handle and explicitly killing on
//      RunEvent::ExitRequested fixes it.
//
// No main window is created at launch (`app.windows = []` in
// tauri.conf.json). "Open Dashboard" creates a webview window
// pointing at the proxy's /usage-viewer endpoint on demand.

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Holds the sidecar's CommandChild so the tray can kill it cleanly
/// at app-exit time. Wrapped in Mutex<Option<...>> because Tauri's
/// state machine wants Send + Sync, and the child handle is taken
/// out (option becomes None) once we've issued the kill.
struct Sidecar(Mutex<Option<CommandChild>>);

// The shelled sidecar binds 4142, not the CLI's default 4141. Lets
// the spike coexist with a hand-installed `maximal start` already
// listening on 4141 (the friendly EADDRINUSE detection in
// src/start.ts otherwise kills the sidecar before it can serve).
// Production Phase E will probably restore 4141 as the canonical
// port and assume the tray app is the only supervisor.
const SIDECAR_PORT: u16 = 4142;
const DASHBOARD_LABEL: &str = "dashboard";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            spawn_sidecar(app.handle())?;
            install_tray(app.handle())?;
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

fn spawn_sidecar(app: &tauri::AppHandle) -> tauri::Result<()> {
    // sidecar("maximal") looks up `bundle.externalBin[0]` from
    // tauri.conf.json and resolves the arch-suffixed binary
    // (binaries/maximal-aarch64-apple-darwin etc.) at build time.
    let port = SIDECAR_PORT.to_string();
    let cmd = app
        .shell()
        .sidecar("maximal")
        .map_err(|e| tauri::Error::Anyhow(anyhow::anyhow!(e)))?
        .args(["start", "--port", port.as_str()]);

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| tauri::Error::Anyhow(anyhow::anyhow!(e)))?;

    let state = app.state::<Sidecar>();
    *state.0.lock().expect("sidecar mutex poisoned") = Some(child);

    // Drain stdout/stderr so the sidecar's pipes don't fill and
    // block writes. For the spike we just print; production we'd
    // forward to a log file.
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
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

fn kill_sidecar(app: &tauri::AppHandle) {
    if let Some(child) = app
        .state::<Sidecar>()
        .0
        .lock()
        .expect("sidecar mutex poisoned")
        .take()
    {
        // CommandChild::kill() sends SIGTERM (POSIX) / TerminateProcess
        // (Windows). The Bun-compiled maximal handles SIGTERM cleanly
        // via the default Bun signal handlers — listening socket gets
        // released on exit so a fresh launch can rebind 4141 immediately.
        let _ = child.kill();
    }
}

fn install_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let dashboard = MenuItem::with_id(app, "open_dashboard", "Open dashboard", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "open_logs", "Open logs folder", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit maximal", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&dashboard, &logs, &quit])?;

    TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("maximal")
        .icon(app.default_window_icon().unwrap().clone())
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open_dashboard" => open_dashboard(app),
            "open_logs" => open_logs(app),
            "quit" => {
                kill_sidecar(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // Left-click already opens the menu (show_menu_on_left_click),
                // so the click handler is a no-op for now. Wired up so we
                // can swap to "left-click opens dashboard, right-click opens
                // menu" if that feels better.
                let _ = tray;
            }
        })
        .build(app)?;
    Ok(())
}

fn open_dashboard(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(DASHBOARD_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let proxy_url = format!("http://localhost:{SIDECAR_PORT}");
    let url = format!("{proxy_url}/usage-viewer?endpoint={proxy_url}/usage");
    let _ = WebviewWindowBuilder::new(
        app,
        DASHBOARD_LABEL,
        WebviewUrl::External(url.parse().expect("valid url")),
    )
    .title("maximal — dashboard")
    .inner_size(1100.0, 720.0)
    .build();
}

fn open_logs(app: &tauri::AppHandle) {
    // ~/.local/share/maximal/logs (matches src/lib/paths.ts after
    // the v0.3.5 rename). Spike implementation: shell out via
    // tauri-plugin-opener which on macOS will Reveal in Finder.
    use tauri_plugin_opener::OpenerExt;
    if let Some(home) = dirs_home_dir() {
        let logs = home.join(".local").join("share").join("maximal").join("logs");
        let _ = app.opener().open_path(logs.to_string_lossy(), None::<&str>);
    }
}

fn dirs_home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
}
