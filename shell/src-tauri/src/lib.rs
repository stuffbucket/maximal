// Maximal tray + sidecar shell.
//
// Tauri 2 menu-bar app. On launch we:
//   1. Mark state Starting and install the tray immediately — the
//      menubar must be reachable before the sidecar is ready, so the
//      user always has a Quit affordance.
//   2. Spawn the bundled `maximal` binary as a sidecar — it serves
//      the proxy on http://localhost:4141 (see SIDECAR_PORT below).
//   3. Poll http://127.0.0.1:4141/setup-status every 300ms until the
//      sidecar answers (or 30s elapses → Failed). The first response
//      flips state to RunningUnauthenticated / RunningAuthenticated
//      based on the `githubAuth.ok` check. After that, slower 5s
//      polling watches for the user signing in or out via Settings.
//   4. Hold the sidecar's CommandChild so we can SIGTERM it when the
//      user picks Quit. Tauri 2 issue #3564 documents the orphan-
//      child pitfall — keeping the handle and explicitly killing on
//      RunEvent::ExitRequested fixes it.
//
// No main window is created at launch (`app.windows = []` in
// tauri.conf.json); the tray is the only UI surface. The proxy's
// /ui/dashboard endpoint is reachable directly via the browser, and
// the `open_settings_at` Tauri command (or the tray's Settings… item)
// pops a webview window pointed at the sidecar's settings page.
//
// Window lifecycle / activation policy / quit flow
// -------------------------------------------------
// This is fundamentally a menu-bar app. The macOS Dock icon comes and
// goes with window visibility:
//   * Launch                       → ActivationPolicy::Accessory  (no Dock)
//   * Any Settings/Dashboard shown → ActivationPolicy::Regular    (Dock on)
//   * Last one hidden              → ActivationPolicy::Accessory
// The OS close button (red ✕) HIDES the Settings/Dashboard window rather
// than closing it — the tray stays alive. `update_activation_policy`
// is the single point of truth and is called from every show/hide path.
//
// Quit flow:
//   1. Tray "Quit Maximal" fires `menu_id::QUIT`.
//   2. `request_quit` pops a native confirm via tauri-plugin-dialog.
//      No webview involvement, no JS, no event-emit/listen race.
//   3. On accept → `app.exit(0)` → RunEvent::ExitRequested →
//      `kill_sidecar` (SIGTERM + 3s SIGKILL escalation) → process exit.

use tauri::{Manager, RunEvent};

/// Native-string i18n (tray, notifications, window titles, quit dialog),
/// backed by the same shell/src/i18n/*.json catalogs the webview renders with.
mod native_i18n;

mod commands;
mod sidecar;
mod state;
mod tray;
mod updater;
mod windows;

use crate::commands::*;
use crate::state::*;

// Canonical Maximal port. Apps integrating with the proxy (Claude
// Code, Cursor, custom scripts) only need to know this one URL:
// http://localhost:4141. The Tauri shell and the standalone CLI both
// bind here; the shell passes `--replace` when spawning so it always
// wins over a stale CLI instance (graceful eviction via
// /_internal/shutdown — see src/lib/replace-running.ts).
pub(crate) const SIDECAR_PORT: u16 = 4141;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Expanded exactly once — `generate_context!` embeds Info.plist as a symbol
    // and can't appear twice in one binary. Both the normal app and the harness
    // consume this same context.
    let context = tauri::generate_context!();

    // Debug-only isolation harness: `MAXIMAL_CONFIRM_HARNESS=1 cargo run` opens
    // ONLY the branded update-confirm window and drives its real WKWebView
    // measure→size→reveal→resolve handshake — no sidecar, no tray, no
    // single-instance plugin, so it can't collide with or poke a running prod
    // instance sharing this bundle identifier. See updater::run_confirm_harness_app.
    #[cfg(debug_assertions)]
    if std::env::var_os("MAXIMAL_CONFIRM_HARNESS").is_some() {
        crate::updater::run_confirm_harness_app(context);
        return;
    }

    let app = tauri::Builder::default()
        // MUST be the FIRST plugin registered. The single-instance
        // plugin's callback fires as part of plugin init; registering
        // it after another plugin lets the second-launch handler race
        // shell startup. Semantics:
        //   * argv contains "--replace" → existing instance shuts down
        //     gracefully (same path as the tray Quit item, minus the
        //     confirm dialog) so the second process can claim :4141.
        //   * otherwise → focus the most-likely-visible window
        //     (Settings preferred, Dashboard fallback, open Settings
        //     if neither exists yet). The second process exits silently.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let wants_replace = argv.iter().any(|a| a == "--replace");
            if wants_replace {
                graceful_shutdown(app);
            } else {
                crate::windows::focus_or_open_main_window(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // In-place self-update. Reads `plugins.updater.{pubkey,endpoints}` from
        // tauri.conf.json; the tray "Upgrade" item drives check/download/install
        // via `handle_upgrade`. Registration order is not sensitive (unlike
        // single-instance above) — it exposes no second-launch callback.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Sidecar::new())
        .manage(AppStatus::new())
        .manage(ShellApiKey::new())
        .manage(SetupPromptShown::new())
        .manage(StartupAnnounced::new())
        .manage(SplashDismissed::new())
        .manage(SidecarRestarting::new())
        .manage(LastRejection::new())
        .manage(LatestUpdate::new())
        .manage(LastSidecarError::new())
        .manage(MenuBarOnly::new())
        .manage(LocaleState::new())
        .invoke_handler(tauri::generate_handler![
            open_settings_at,
            open_dashboard,
            reveal_config_dir,
            reveal_logs_dir,
            restart_sidecar,
            uninstall_maximal,
            get_shell_api_key,
            subscribe_token_usage,
            set_menu_bar_only,
            set_locale,
        ])
        .setup(|app| {
            // Seed the runtime menu-bar-only flag from the persisted
            // `config.ui.menuBarOnly` preference (absent/false = DEFAULT:
            // ALSO show in Dock/taskbar; true = menu-bar/tray-only). Every
            // platform reads it once here; the flag drives Dock presence on
            // macOS and taskbar presence on Windows from now on.
            let menu_bar_only = read_menu_bar_only(app.handle());
            app.state::<MenuBarOnly>().set(menu_bar_only);

            // macOS Dock presence. Default (not menu-bar-only) launches
            // Regular so the Dock icon is present from the first frame — a
            // persistent, set-and-forget affordance that needs no open window.
            // When menu-bar-only we start Accessory (no Dock);
            // update_activation_policy then flips to Regular only while a
            // Settings/Dashboard window is visible, and back to Accessory when
            // the last one hides.
            #[cfg(target_os = "macos")]
            {
                let initial = if menu_bar_only {
                    tauri::ActivationPolicy::Accessory
                } else {
                    tauri::ActivationPolicy::Regular
                };
                let _ = app.set_activation_policy(initial);
                // Keep the POLICY_IS_REGULAR mirror in step with what we just
                // applied so update_activation_policy's no-op-skip stays honest.
                crate::windows::POLICY_IS_REGULAR
                    .store(!menu_bar_only, std::sync::atomic::Ordering::SeqCst);
                // Dock icon: in release the .app bundle's Info.plist
                // CFBundleIconFile (driven by `bundle.icon` in
                // tauri.conf.json) handles this. `cargo run` doesn't
                // produce a bundle, so set the icon explicitly in debug
                // builds only — release builds skip the FFI dance. Only the
                // Regular (Dock-visible) case needs it now; the Accessory case
                // gets it later via update_activation_policy when a window shows.
                #[cfg(debug_assertions)]
                if !menu_bar_only {
                    crate::tray::set_dock_icon();
                }
            }

            // Seed the native-UI locale BEFORE the tray is built so the very
            // first menu/tooltip render is already in the right language. Rust
            // can't read the webview's localStorage picker choice, but the
            // `set_locale` command persists that choice to disk, so a returning
            // user's pick wins here; a genuine first run (no persisted file)
            // falls back to the OS locale. Once a webview boots it re-pushes the
            // live choice via `set_locale` regardless.
            let persisted = persisted_locale(app.handle());
            let os_locale = sys_locale::get_locale();
            let seeded = native_i18n::resolve_locale(persisted.as_deref(), os_locale.as_deref());
            app.state::<LocaleState>().set(seeded);

            // Install the tray FIRST so the user has a Quit affordance
            // before the sidecar's spawn even returns. Any failure
            // downstream still leaves a clickable menubar.
            crate::tray::install_tray(app.handle())?;
            crate::sidecar::apply_state(app.handle(), SidecarState::Starting);

            // Immediate visible feedback. This is a menu-bar-only app, so
            // launching it otherwise just adds a tray icon the user may
            // not notice ("clicking did nothing"). The splash is closed by
            // apply_state on the first Running/Failed transition.
            crate::windows::create_splash(app.handle());

            // Spawn sidecar. If this fails synchronously we go straight
            // to Failed — the user still sees the menubar.
            if let Err(err) = crate::sidecar::spawn_sidecar(app.handle()) {
                eprintln!("[shell] sidecar spawn failed: {err}");
                crate::sidecar::apply_state(app.handle(), SidecarState::Failed);
                return Ok(());
            }

            // Kick off the polling task. Tokio task (via Tauri's
            // async_runtime) — cheap, doesn't need its own thread, and
            // reqwest's async client integrates cleanly.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                crate::sidecar::poll_sidecar_status(handle).await;
            });

            // Windows taskbar discoverability. Unlike macOS (which gets a
            // persistent Dock icon above), a taskbar button only exists while a
            // window is open, so with the default preference we open Settings on
            // launch — that window carries Maximal's taskbar presence. macOS is
            // deliberately NOT auto-opened here: its Dock icon already provides
            // discoverability, and set-and-forget means no window is forced open.
            // TODO(windows): a truly persistent taskbar button with NO window
            // open is a follow-up; for now an open window stands in for it.
            #[cfg(windows)]
            if !menu_bar_only {
                crate::windows::open_settings_window(app.handle(), None);
            }

            Ok(())
        })
        .build(context)
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { code, api, .. } => {
            // Tauri exits the process when the last window closes. This is
            // a menu-bar app: the tray — not any window — is the persistent
            // surface, and the splash is frequently the ONLY window open
            // (on an authenticated launch nothing else opens). When the
            // splash's 3s fade closes it, the open-window count hits zero
            // and Tauri requests an exit, tearing the whole app — tray
            // included — down. That's the "tray dies with the splash fade"
            // bug. `code == None` means this exit was driven by window
            // interaction (last window closed), not by us; veto it so the
            // tray-only app keeps running.
            //
            // Intentional quits all route through `app.exit(0)` (tray Quit,
            // clean sidecar exit, single-instance `--replace`), which yields
            // `code == Some(_)`. Those proceed and reach `kill_sidecar`.
            if code.is_none() {
                api.prevent_exit();
                return;
            }
            // Sole sidecar-kill site for a real shutdown.
            crate::sidecar::kill_sidecar(app_handle);
        }
        // macOS delivers Reopen when the app is re-activated — clicking its
        // notification banner ("Maximal is running"), its Dock icon, etc.
        // Desktop notifications can't carry a routable button (the plugin's
        // show() is fire-and-forget), so Reopen is how a banner click lands
        // somewhere: if nothing's on screen, open Settings. Route to the
        // account section when we're up but not signed in (the sign-in
        // nudge), otherwise plain Settings.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if !has_visible_windows {
                let section = if app_handle.state::<AppStatus>().get()
                    == SidecarState::RunningUnauthenticated
                {
                    Some("account")
                } else {
                    None
                };
                crate::windows::open_settings_window(app_handle, section);
            }
        }
        _ => {}
    });
}
