// Maximal tray + sidecar shell.
//
// Tauri 2 menu-bar app. On launch we:
//   1. Spawn the bundled `maximal` binary as a sidecar — it serves
//      the proxy on http://localhost:4142 (see SIDECAR_PORT below).
//   2. Show a tray icon with: Settings… (⌘,), Quit Maximal (⌘Q).
//   3. Hold the sidecar's CommandChild so we can SIGTERM it when the
//      user picks Quit. Tauri 2 issue #3564 documents the orphan-
//      child pitfall — keeping the handle and explicitly killing on
//      RunEvent::ExitRequested fixes it.
//
// No main window is created at launch (`app.windows = []` in
// tauri.conf.json); the tray is the only UI surface. The proxy's
// /usage-viewer endpoint is reachable directly via the browser.

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Owns the sidecar's CommandChild for the lifetime of the app.
///
/// Wrapped in `Mutex<Option<...>>` because Tauri's managed-state
/// API requires `Send + Sync`, and the child handle is consumed
/// (option becomes None) once `kill()` is issued so subsequent
/// kill calls become harmless no-ops.
struct Sidecar(Mutex<Option<CommandChild>>);

impl Sidecar {
    fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn set(&self, child: CommandChild) {
        // Mutex poisoning happens only if a thread panicked while
        // holding this lock. Nothing fallible runs in the critical
        // section, so panicking here is fine.
        *self.0.lock().expect("sidecar mutex poisoned") = Some(child);
    }

    fn take(&self) -> Option<CommandChild> {
        self.0.lock().expect("sidecar mutex poisoned").take()
    }
}

// The shelled sidecar binds 4142, not the CLI's default 4141. Lets
// the spike coexist with a hand-installed `maximal start` already
// listening on 4141 (the friendly EADDRINUSE detection in
// src/start.ts otherwise kills the sidecar before it can serve).
// Production Phase E will probably restore 4141 as the canonical
// port and assume the tray app is the only supervisor.
const SIDECAR_PORT: u16 = 4142;

mod menu_id {
    pub const SETTINGS: &str = "settings";
    pub const QUIT: &str = "quit";
}

const TRAY_ID: &str = "main";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar::new())
        .setup(|app| {
            spawn_sidecar(app.handle())?;
            install_tray(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Sole sidecar-kill site. The tray "Quit" item just calls
        // `app.exit(0)`, which routes through ExitRequested.
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
        .map_err(|e| tauri::Error::Anyhow(e.into()))?
        .args(["start", "--port", port.as_str()]);

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| tauri::Error::Anyhow(e.into()))?;

    app.state::<Sidecar>().set(child);

    // Drain stdout/stderr so the sidecar's pipes don't fill and
    // block writes. TODO(prod): swap to `tracing` + a rolling log
    // file under the same dir as `open_logs` resolves.
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
                    // TODO(prod): surface to the tray (error tooltip
                    // or icon-state change) instead of failing silently.
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

fn kill_sidecar(app: &tauri::AppHandle) {
    if let Some(child) = app.state::<Sidecar>().take() {
        // CommandChild::kill() sends SIGTERM (POSIX) / TerminateProcess
        // (Windows). The Bun-compiled maximal handles SIGTERM cleanly
        // via the default Bun signal handlers — listening socket gets
        // released on exit so a fresh launch can rebind the port
        // immediately.
        let _ = child.kill();
    }
}

fn install_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let settings = MenuItem::with_id(
        app,
        menu_id::SETTINGS,
        "Settings…",
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
    let menu = Menu::with_items(app, &[&settings, &separator, &quit])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("maximal")
        .icon(app.default_window_icon().unwrap().clone())
        .on_menu_event(|app, event| match event.id().as_ref() {
            menu_id::SETTINGS => open_settings(app),
            // app.exit() routes through RunEvent::ExitRequested,
            // which is where the sidecar gets killed. No need to
            // call kill_sidecar here directly.
            menu_id::QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|_tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // Reserved for future left-click behavior; the
                // current default is show_menu_on_left_click.
            }
        })
        .build(app)?;
    Ok(())
}

fn open_settings(app: &tauri::AppHandle) {
    // Opens the maximal app-data directory in the OS file browser.
    // The user's editable config.json lives at the root; logs/ and
    // secrets/ are visible as siblings. Resolves to the same path
    // src/lib/paths.ts uses: ~/.local/share/maximal on macOS/Linux,
    // %USERPROFILE%\.local\share\maximal on Windows.
    let Ok(home) = app.path().home_dir() else {
        return;
    };
    let dir = home
        .join(".local")
        .join("share")
        .join("maximal");
    let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
}
