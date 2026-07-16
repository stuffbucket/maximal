use std::time::Duration;

use tauri::{
    webview::PageLoadEvent, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

use crate::native_i18n;
use crate::state::{AppStatus, LocaleState, SidecarState, SplashDismissed};
use crate::SIDECAR_PORT;

/// Brand-minimum time the splash stays on screen once the sidecar reaches a
/// Running state, before it fades. The state-aware dismiss loop in
/// `create_splash` enforces this, and the first-run Settings auto-open
/// (`apply_state`) defers to it so Settings doesn't race up over the splash.
pub(crate) const SPLASH_MIN_DISPLAY: Duration = Duration::from_millis(1600);

// Two webview windows, both pointed at the sidecar:
//   settings  — http://localhost:4141/ui/settings/  (React app)
//   dashboard — http://localhost:4141/ui/dashboard/  (usage charts)
// Both UIs are embedded in the sidecar binary and served at /ui/* —
// see src/routes/ui/route.ts.
// Labels are referenced from capabilities/default.json `windows`.
pub(crate) const SETTINGS_WINDOW_LABEL: &str = "settings";
pub(crate) const DASHBOARD_WINDOW_LABEL: &str = "dashboard";

/// The app's release version (e.g. `0.4.31`), read from `tauri.conf.json`'s
/// `version`. `.macos-builder/build.sh` stamps that field with the real tag
/// at release time; in dev it's the `0.0.0` placeholder. Callers surface it
/// in the splash and the Settings title and suppress the dev placeholder so a
/// bare `v0.0.0` never ships in UI chrome.
pub(crate) fn app_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Pre-boot splash window. Created the instant the app launches so the
/// user gets immediate, visible feedback. This is a menu-bar-only app
/// (no Dock icon, no window at launch), so without it, double-clicking
/// the .app just adds a tray icon that's easy to miss. Loaded from the
/// bundled, self-contained `splash.html` via the Tauri asset protocol —
/// it can't be sidecar-served like Settings/Dashboard because the
/// sidecar isn't up yet. Retired by `dismiss_splash`.
pub(crate) fn create_splash(app: &AppHandle) {
    if app.get_webview_window("splash").is_some() {
        return;
    }
    let result = WebviewWindowBuilder::new(app, "splash", WebviewUrl::App("splash.html".into()))
        .title("Maximal")
        // Hand the splash its version before first paint (race-free — runs
        // ahead of page load, unlike an emitted event the page might miss).
        // The page renders it unless it's the dev `0.0.0` placeholder.
        .initialization_script(&format!(
            "window.__MAXIMAL_VERSION__ = {:?};",
            app_version(app)
        ))
        .inner_size(440.0, 240.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        // Build hidden and only show once the webview reports the DOM has
        // loaded. On Windows/WebView2 the native surface is presented before
        // the compositor draws its first frame, so a visible-from-launch
        // transparent window shows an empty outline for hundreds of ms–seconds
        // before the brand-red `.splash` div pops in. macOS/WKWebView paints in
        // lockstep with show, so this fires immediately there — no regression.
        .visible(false)
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = window.show();
            }
        })
        .center()
        .build();
    match result {
        Ok(_) => {
            // State-aware dismissal — the splash tracks the actual startup
            // instead of a blind timer, so live status stays visible on a
            // slow boot and a failure isn't cleared before it's read:
            //   - Running  → brief brand-minimum, then fade.
            //   - Failed   → hold so the user reads the reason (apply_state
            //                puts it on the splash), then fade after a grace
            //                period so an always-on-top window never strands;
            //                the notification + tray Retry/Logs persist.
            //   - Starting → keep waiting, up to a hard cap.
            // dismiss_splash is a one-shot, so racing the window-open path is
            // harmless.
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let start = std::time::Instant::now();
                let min_display = SPLASH_MIN_DISPLAY;
                let hard_cap = Duration::from_secs(35);
                loop {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    match handle.state::<AppStatus>().get() {
                        SidecarState::RunningAuthenticated
                        | SidecarState::RunningUnauthenticated => {
                            let elapsed = start.elapsed();
                            if elapsed < min_display {
                                tokio::time::sleep(min_display - elapsed).await;
                            }
                            dismiss_splash(&handle);
                            break;
                        }
                        SidecarState::Failed | SidecarState::Stopped => {
                            tokio::time::sleep(Duration::from_secs(12)).await;
                            dismiss_splash(&handle);
                            break;
                        }
                        SidecarState::Starting => {
                            if start.elapsed() >= hard_cap {
                                dismiss_splash(&handle);
                                break;
                            }
                        }
                    }
                }
            });
        }
        Err(err) => eprintln!("[shell] splash window failed: {err}"),
    }
}

/// Dismiss the splash for good, on whichever comes first: the 3s timeout
/// (`create_splash`) or any other window opening (`open_settings_window`
/// / `open_dashboard_window`). One-shot via `SplashDismissed` — once gone
/// it never returns for the life of the process. Emits the CSS fade, then
/// closes the window after it. Best-effort throughout.
pub(crate) fn dismiss_splash(app: &AppHandle) {
    if !app.state::<SplashDismissed>().claim() {
        return;
    }
    const FADE_MS: u64 = 240; // ≥ the 200ms CSS fade, + a little slack
    let _ = app.emit("splash:leave", ());
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(FADE_MS)).await;
        if let Some(win) = handle.get_webview_window("splash") {
            let _ = win.close();
        }
    });
}

/// Opens (or focuses) the dashboard webview pointed at the sidecar's
/// settings page. The optional `section` becomes a URL fragment so the
/// frontend can scroll to / select that section.
pub(crate) fn open_settings_window(app: &AppHandle, section: Option<&str>) {
    // Any window taking the stage retires the splash (it's always-on-top
    // and would otherwise sit over this one — e.g. the first-launch
    // sign-in nudge).
    dismiss_splash(app);
    // The settings UI is served by the sidecar at /ui/settings/ (embedded
    // in the binary), in dev and prod alike — there is no separate dev
    // server to point at anymore.
    let settings_origin = format!("http://localhost:{SIDECAR_PORT}");
    let url_string = match section {
        Some(s) => format!("{settings_origin}/ui/settings/#{s}"),
        None => format!("{settings_origin}/ui/settings/"),
    };
    let url = match url::Url::parse(&url_string) {
        Ok(u) => u,
        Err(err) => {
            eprintln!("[shell] bad settings URL: {err}");
            return;
        }
    };

    if let Some(existing) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        // Navigation via re-creation is the simplest cross-platform
        // path; eval'ing window.location is fiddly with CSP-null.
        // Cheap on macOS — the webview process is reused.
        if let Err(err) = existing.navigate(url) {
            eprintln!("[shell] settings navigate failed: {err}");
        }
        present_window(app, &existing);
        return;
    }

    // Surface the version in the titlebar (window-level identity belongs in
    // the title, not a content H1 — see docs/design/failure-modes.md). Drop
    // the suffix in dev where the version is the `0.0.0` placeholder.
    let title = settings_title(app);
    let builder = WebviewWindowBuilder::new(app, SETTINGS_WINDOW_LABEL, WebviewUrl::External(url))
        .title(title)
        .inner_size(900.0, 760.0)
        .min_inner_size(600.0, 560.0);
    // Windows taskbar presence follows the menu-bar-only preference: default
    // (false) shows the window in the taskbar; menu-bar-only (true) keeps it
    // out for the tray-only feel. Shadow rather than `mut` so non-Windows
    // builds stay warning-clean. (The splash keeps its own skip_taskbar(true).)
    #[cfg(windows)]
    let builder = builder.skip_taskbar(app.state::<crate::state::MenuBarOnly>().get());

    match builder.build() {
        Ok(window) => {
            attach_hide_on_close(app, &window);
            present_window(app, &window);
        }
        Err(err) => {
            eprintln!("[shell] settings window build failed: {err}");
        }
    }
}

/// The Settings window title for the active locale — versioned unless the
/// version is the dev `0.0.0` placeholder. Shared by the window builder and the
/// live retitle on a locale change so the two can't diverge.
pub(crate) fn settings_title(app: &AppHandle) -> String {
    let version = app_version(app);
    let locale = app.state::<LocaleState>().get();
    if version == "0.0.0" {
        native_i18n::tr(&locale, "native-window-settings-title")
    } else {
        native_i18n::t(
            &locale,
            "native-window-settings-title-versioned",
            &[("version", &version)],
        )
    }
}

/// Re-title any already-open Settings/Dashboard window to the active locale.
/// Called from `set_locale` so a picker change updates the OS-drawn titlebar
/// live, not just on the next window open. No-op for windows that aren't up.
pub(crate) fn retitle_windows(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        let _ = win.set_title(&settings_title(app));
    }
    if let Some(win) = app.get_webview_window(DASHBOARD_WINDOW_LABEL) {
        let locale = app.state::<LocaleState>().get();
        let _ = win.set_title(&native_i18n::tr(&locale, "native-window-dashboard-title"));
    }
}

/// Opens (or focuses) the usage dashboard webview pointed at the
/// sidecar's `/ui/dashboard/` endpoint. The dashboard (and settings) are
/// embedded in the sidecar binary and served at /ui/* (see
/// src/routes/ui/route.ts), so they ship inside the bundle with no extra
/// resource staging.
pub(crate) fn open_dashboard_window(app: &AppHandle) {
    dismiss_splash(app);
    let url_string = format!(
        "http://localhost:{SIDECAR_PORT}/ui/dashboard/\
         ?endpoint=http://localhost:{SIDECAR_PORT}/usage",
    );
    let url = match url::Url::parse(&url_string) {
        Ok(u) => u,
        Err(err) => {
            eprintln!("[shell] bad dashboard URL: {err}");
            return;
        }
    };

    if let Some(existing) = app.get_webview_window(DASHBOARD_WINDOW_LABEL) {
        present_window(app, &existing);
        return;
    }

    let builder = WebviewWindowBuilder::new(app, DASHBOARD_WINDOW_LABEL, WebviewUrl::External(url))
        .title(native_i18n::tr(
            &app.state::<LocaleState>().get(),
            "native-window-dashboard-title",
        ))
        .inner_size(1100.0, 760.0)
        .min_inner_size(720.0, 520.0);
    // See open_settings_window: Windows taskbar presence tracks menu-bar-only.
    #[cfg(windows)]
    let builder = builder.skip_taskbar(app.state::<crate::state::MenuBarOnly>().get());

    match builder.build() {
        Ok(window) => {
            attach_hide_on_close(app, &window);
            present_window(app, &window);
        }
        Err(err) => {
            eprintln!("[shell] dashboard window build failed: {err}");
        }
    }
}

/// Wires the OS close button (red ✕ on macOS) to HIDE the window
/// rather than close it. The tray remains the persistent UI surface,
/// so closing a settings/dashboard window is just a visibility change.
/// Also drives the Dock icon via `update_activation_policy`.
fn attach_hide_on_close(app: &AppHandle, window: &tauri::WebviewWindow) {
    let window_clone = window.clone();
    let app_clone = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window_clone.hide();
            update_activation_policy(&app_clone);
        }
    });
}

/// macOS-only: flips the activation policy between Regular (Dock icon
/// visible) and Accessory (menu-bar-only, no Dock) based on whether
/// any of our managed webview windows are currently visible.
///
/// On Windows/Linux this is a no-op — there is no equivalent concept.
/// Tracks the activation policy we last successfully applied, so
/// `update_activation_policy` can skip a redundant `set_activation_policy`
/// call. Every call to AppKit's `setActivationPolicy:` makes it re-resolve
/// NSApplication's icon from the bundle — which, for a dev `cargo run` binary
/// with no Info.plist icon, is the generic "exec" image; `set_dock_icon`
/// re-applies our branded icon a frame later. So a *redundant* policy set —
/// e.g. closing one window while another stays open (Regular→Regular) — still
/// flashes the Dock icon exec→branded. Skipping no-op transitions removes the
/// flash. Starts `false` to match the Accessory policy set at startup.
#[cfg(target_os = "macos")]
pub(crate) static POLICY_IS_REGULAR: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "macos")]
pub(crate) fn update_activation_policy(app: &AppHandle) {
    use std::sync::atomic::Ordering;

    // The Dock icon is Regular when EITHER the persistent-Dock preference is
    // on (default: not menu-bar-only) OR a Settings/Dashboard window is
    // currently visible. Menu-bar-only mode keeps the classic behavior where
    // the Dock icon comes and goes with window visibility.
    let menu_bar_only = app.state::<crate::state::MenuBarOnly>().get();
    let labels = [SETTINGS_WINDOW_LABEL, DASHBOARD_WINDOW_LABEL];
    let want_regular = !menu_bar_only
        || labels.iter().any(|label| {
            app.get_webview_window(label)
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false)
        });

    // Skip when the policy isn't actually changing. Beyond avoiding the
    // dev-only Dock-icon flash, this dodges needless AppKit churn on every
    // window show/close. All callers run on the main thread, so the
    // load-then-store is race-free.
    if POLICY_IS_REGULAR.load(Ordering::SeqCst) == want_regular {
        return;
    }

    let next = if want_regular {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    };
    if let Err(err) = app.set_activation_policy(next) {
        eprintln!("[shell] set_activation_policy failed: {err}");
        return; // don't record a policy we failed to apply
    }
    POLICY_IS_REGULAR.store(want_regular, Ordering::SeqCst);

    // Re-apply the Dock icon in debug builds only. AppKit re-resolves
    // NSApplication.applicationIconImage on the policy change above; without
    // this re-apply, a `cargo run` dev binary falls back to the generic
    // "exec" icon (no Info.plist CFBundleIconFile exists). Release builds
    // carry a real bundle icon and never run this path.
    #[cfg(debug_assertions)]
    if want_regular {
        crate::tray::set_dock_icon();
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn update_activation_policy(_app: &AppHandle) {}

/// macOS: make Maximal the active (frontmost) application. An Accessory
/// menu-bar app is not active by default, so even after flipping to Regular
/// a freshly-shown window won't take the foreground until the app itself is
/// activated — that's the "had to click the Dock icon" symptom. No-op off
/// macOS, and a no-op when not called on the main thread.
#[cfg(target_os = "macos")]
fn activate_app() {
    use objc2_app_kit::NSApplication;
    use objc2_foundation::MainThreadMarker;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    // `activateIgnoringOtherApps:` is deprecated on macOS 14+, but it remains
    // the reliable way to pull an Accessory→Regular app to the foreground; the
    // newer `activate()` no-ops when the app isn't already considered active —
    // exactly our case on the first show.
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
}

#[cfg(not(target_os = "macos"))]
fn activate_app() {}

/// Bring a managed window to the foreground reliably, from any thread.
///
/// This is the fix for "Settings/Dashboard doesn't come up on the first
/// invoke / needs a Dock click." The ordering is load-bearing: the window
/// must be VISIBLE, the app must be a Regular (Dock) app, and the app must be
/// ACTIVATED *before* the window is focused. The previous code focused while
/// the app was still Accessory and only flipped the policy afterward, so a
/// menu-bar app couldn't raise the window — it sat behind whatever was front.
///
/// The whole sequence runs in one closure on the main thread: the AppKit
/// calls (activation policy, NSApp activate, Dock icon) require it, and Tauri
/// command handlers run OFF the main thread — where reading `is_visible()`
/// right after `show()` (as `update_activation_policy` does) could race and
/// pick the wrong policy. Dispatching from the main thread (tray/menu) is
/// fine: `run_on_main_thread` queues the closure to run right after the
/// current event handler returns, it does not block or re-enter.
pub(crate) fn present_window(app: &AppHandle, window: &tauri::WebviewWindow) {
    let app_for_closure = app.clone();
    let window = window.clone();
    let present = move || {
        let _ = window.unminimize();
        let _ = window.show();
        update_activation_policy(&app_for_closure);
        activate_app();
        let _ = window.set_focus();
    };
    if let Err(err) = app.run_on_main_thread(present) {
        eprintln!("[shell] present_window: main-thread dispatch failed: {err}");
    }
}

/// Focus an existing main window, or open Settings if none exists.
///
/// Called from the single-instance plugin callback when the user
/// re-launches Maximal without `--replace` — the natural "they double-
/// clicked the dock icon" case. Settings is the default surface;
/// Dashboard is the fallback if Settings isn't built yet but
/// Dashboard is. If neither exists we open Settings fresh, which
/// also runs `update_activation_policy` to bring the Dock icon back.
pub(crate) fn focus_or_open_main_window(app: &AppHandle) {
    for label in [SETTINGS_WINDOW_LABEL, DASHBOARD_WINDOW_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            present_window(app, &window);
            return;
        }
    }
    // Nothing built yet — fall through to opening Settings, which
    // also handles the activation-policy flip.
    open_settings_window(app, None);
}
