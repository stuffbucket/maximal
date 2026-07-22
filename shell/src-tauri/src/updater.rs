use tauri::{AppHandle, Listener, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

use crate::native_i18n;
use crate::{LatestUpdate, LocaleState};

// The update-DETECTION half (poll → `LatestUpdate` → notification) lives inline
// in lib.rs (`check_for_update` / `apply_update` / `fire_update_notification`).
// This module owns the in-place INSTALL half: the tray/UI "Upgrade" action drives
// `handle_upgrade`, which downloads the signed bundle, verifies it, and relaunches.

/// Opens the install-channel-neutral download page for the available update
/// (the same URL the OS notification points at). No-op if we somehow have no
/// snapshot — the item is only built when one exists.
fn open_update_url(app: &AppHandle) {
    let Some(update) = app.state::<LatestUpdate>().get() else {
        return;
    };
    if let Err(err) = app.opener().open_url(update.url, None::<&str>) {
        eprintln!("[shell] failed to open update url: {err}");
    }
}

/// The "Upgrade to v…" action (browser-tab Settings button → sidecar
/// `@@MAXIMAL_UPDATE@@` marker → shell). Attempts an in-place install — download
/// the signed `.app.tar.gz`, verify its Ed25519 signature against the configured
/// `pubkey`, swap the bundle, and relaunch — and falls back to opening the
/// download page in the browser whenever that path isn't available: a dev build,
/// an unreachable/absent updater endpoint, no signed artifact for this platform
/// yet, or a failed check. That keeps the button useful everywhere the notify
/// path surfaces it, even before the signed-artifact pipeline covers a channel.
/// Runs on the async runtime because the updater check does network I/O.
pub(crate) fn handle_upgrade(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match check_inplace_update(&app).await {
            Ok(Some(update)) => prompt_and_install(&app, update),
            // Endpoint reachable but nothing installable in the signed channel —
            // still send the user somewhere useful.
            Ok(None) => open_update_url(&app),
            Err(err) => {
                eprintln!("[shell] in-place update unavailable ({err}); opening download page");
                open_update_url(&app);
            }
        }
    });
}

/// Runs a signed-update check via the Tauri updater. Honors an optional
/// `MAXIMAL_UPDATE_ENDPOINT` override so an isolated build can be pointed at a
/// local `latest.json` + test bundle and exercised end-to-end without touching
/// the production endpoint or shipping a release (see docs/dev/self-updater.md).
/// Returns the pending `Update` when one is available, `None` when the signed
/// channel has nothing newer, or an error when the updater can't run here.
async fn check_inplace_update(
    app: &AppHandle,
) -> tauri_plugin_updater::Result<Option<tauri_plugin_updater::Update>> {
    let mut builder = app.updater_builder();
    if let Ok(endpoint) = std::env::var("MAXIMAL_UPDATE_ENDPOINT") {
        let endpoint = endpoint.trim();
        if !endpoint.is_empty() {
            let parsed: std::result::Result<url::Url, _> = endpoint.parse();
            match parsed {
                Ok(url) => builder = builder.endpoints(vec![url])?,
                Err(err) => eprintln!("[shell] ignoring invalid MAXIMAL_UPDATE_ENDPOINT: {err}"),
            }
        }
    }
    builder.build()?.check().await
}

/// Branded confirm → download+install → relaunch. Builds the confirm surface
/// with the localized install copy, and on confirm downloads on the async
/// runtime and then `app.restart()`, which routes through
/// RunEvent::ExitRequested → `kill_sidecar` so the old sidecar is torn down
/// before the fresh shell relaunches and spawns the new one with `--replace`. A
/// failed download (or a window that never opened) leaves the user on the
/// download page rather than silently doing nothing.
fn prompt_and_install(app: &AppHandle, update: tauri_plugin_updater::Update) {
    let locale = app.state::<LocaleState>().get();
    let version = update.version.clone();
    // Resolve the localized copy and hand it to the surface race-free.
    let payload = serde_json::json!({
        "version": version,
        "title": native_i18n::t(&locale, "native-update-install-title", &[("latest", &version)]),
        "body": native_i18n::tr(&locale, "native-update-install-body"),
        "confirmLabel": native_i18n::tr(&locale, "native-update-install-confirm"),
        "cancelLabel": native_i18n::tr(&locale, "native-update-install-cancel"),
    });

    let opened = open_confirm_window(app, payload, move |app, confirmed| {
        if !confirmed {
            return;
        }
        let app_inner = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(err) = update.download_and_install(|_chunk, _total| {}, || {}).await {
                eprintln!("[shell] in-place install failed: {err}");
                open_update_url(&app_inner);
                return;
            }
            // Bundle swapped in place; relaunch into the new version.
            app_inner.restart();
        });
    });

    if !opened {
        eprintln!("[shell] update-confirm window failed; opening download page");
        open_update_url(app);
    }
}

/// Opens the self-contained `update-confirm.html` webview (the app's design
/// language, not the native OS alert) and drives the full
/// measure→size→reveal→resolve handshake, invoking `on_resolve(app, confirmed)`
/// exactly once with the user's choice (after closing the window). Split out of
/// `prompt_and_install` so this same window/handshake path can be exercised in
/// isolation by the debug harness (`run_confirm_harness_app`) — it otherwise
/// only ever ran in a browser preview, never in a real WKWebView.
///
/// Same race-safe pattern as `create_splash`: `payload` (version + localized
/// title/body/button copy) is injected as `window.__UPDATE__` via an
/// init-script BEFORE first paint. The window is created HIDDEN at a provisional
/// size and sized to the height the webview reports via `update:size` — Rust
/// can't measure the laid-out webview (height depends on engine font metrics,
/// locale copy length, user font scaling), so the surface measures itself and
/// we fit the window to it, then reveal, correct across engines/locales/scaling.
/// A short fallback timer reveals it at the provisional size if that handshake
/// never lands. Returns false only if the window couldn't be created (the caller
/// then falls back); an already-open window is focused and counts as handled.
fn open_confirm_window<F>(app: &AppHandle, payload: serde_json::Value, on_resolve: F) -> bool
where
    F: FnOnce(&AppHandle, bool) + Send + 'static,
{
    // Clicked twice while the window is up — focus it, don't stack a second
    // window or a second one-shot listener.
    if let Some(existing) = app.get_webview_window("update-confirm") {
        let _ = existing.set_focus();
        return true;
    }

    let init = format!("window.__UPDATE__ = {payload};");

    // Fixed width controls the wrap; the height is provisional. 285 is only the
    // fallback height used if the size handshake never lands.
    const CONFIRM_WIDTH: f64 = 360.0;
    const CONFIRM_FALLBACK_HEIGHT: f64 = 285.0;
    let built = WebviewWindowBuilder::new(
        app,
        "update-confirm",
        WebviewUrl::App("update-confirm.html".into()),
    )
    .title("Maximal")
    .initialization_script(&init)
    .inner_size(CONFIRM_WIDTH, CONFIRM_FALLBACK_HEIGHT)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .center()
    .build();

    if let Err(err) = built {
        eprintln!("[shell] update-confirm window failed ({err})");
        return false;
    }

    // The webview reports its measured content height once fonts + layout settle;
    // size the window to it, recenter, and reveal. Clamp to a sane band so a bad
    // payload can't produce a degenerate window. One-shot — the surface emits
    // this exactly once.
    let sizing_app = app.clone();
    app.once("update:size", move |event| {
        let height = serde_json::from_str::<serde_json::Value>(event.payload())
            .ok()
            .and_then(|v| v.get("height").and_then(serde_json::Value::as_f64))
            .unwrap_or(CONFIRM_FALLBACK_HEIGHT)
            .clamp(160.0, 700.0);
        if let Some(window) = sizing_app.get_webview_window("update-confirm") {
            let _ = window.set_size(LogicalSize::new(CONFIRM_WIDTH, height));
            let _ = window.center();
            let _ = window.show();
            let _ = window.set_focus();
            eprintln!("[shell] update-confirm sized via update:size (height={height})");
        }
    });

    // Fallback: never leave the window stranded hidden. If the size handshake
    // hasn't revealed it within a short grace (JS error / no fonts event), show
    // it at the provisional size.
    let fallback_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        if let Some(window) = fallback_app.get_webview_window("update-confirm") {
            if !window.is_visible().unwrap_or(false) {
                let _ = window.show();
                let _ = window.set_focus();
                eprintln!("[shell] update-confirm revealed via fallback timer (size handshake missed)");
            }
        }
    });

    // One-shot: the surface emits `update:resolve` = {confirm: bool}. Close the
    // window on either choice, then hand the result to the caller. `once` fires
    // at most once, so `on_resolve` (FnOnce) is sound.
    let resolve_app = app.clone();
    app.once("update:resolve", move |event| {
        let confirmed = serde_json::from_str::<serde_json::Value>(event.payload())
            .ok()
            .and_then(|v| v.get("confirm").and_then(serde_json::Value::as_bool))
            .unwrap_or(false);
        if let Some(window) = resolve_app.get_webview_window("update-confirm") {
            let _ = window.close();
        }
        on_resolve(&resolve_app, confirmed);
    });

    true
}

/// Debug-only isolated harness for the branded confirm surface. Builds a
/// minimal Tauri app — crucially WITHOUT the single-instance plugin, so it can
/// coexist with a running production instance sharing the same bundle
/// identifier — that opens the confirm window via the real `open_confirm_window`
/// and drives the actual WKWebView self-measure → `update:size` → Rust set_size
/// + reveal → `update:resolve` handshake, WITHOUT the updater endpoint, a real
/// `Update`, the sidecar, or any bundle swap. On resolve it logs the choice and
/// exits. Gated by `run()` behind `MAXIMAL_CONFIRM_HARNESS`; compiled out of
/// release. See docs/dev/self-updater.md.
#[cfg(debug_assertions)]
pub(crate) fn run_confirm_harness_app(context: tauri::Context) {
    tauri::Builder::default()
        .manage(LocaleState::new())
        .setup(|app| {
            // A normal, focusable, screenshot-able window (the real app is a
            // tray/Accessory app; the harness just needs the surface on screen).
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

            let locale =
                native_i18n::resolve_locale(None, sys_locale::get_locale().as_deref());
            app.state::<LocaleState>().set(locale.clone());

            let version =
                std::env::var("MAXIMAL_CONFIRM_VERSION").unwrap_or_else(|_| "0.99.0".to_string());
            let payload = serde_json::json!({
                "version": version,
                "title": native_i18n::t(&locale, "native-update-install-title", &[("latest", &version)]),
                "body": native_i18n::tr(&locale, "native-update-install-body"),
                "confirmLabel": native_i18n::tr(&locale, "native-update-install-confirm"),
                "cancelLabel": native_i18n::tr(&locale, "native-update-install-cancel"),
            });
            eprintln!("[harness] opening branded confirm for v{version}");

            let opened = open_confirm_window(app.handle(), payload, |app, confirmed| {
                eprintln!("[harness] update:resolve confirm={confirmed} — exiting");
                app.exit(0);
            });
            if !opened {
                eprintln!("[harness] update-confirm window failed to open");
                app.handle().exit(1);
            }
            Ok(())
        })
        .build(context)
        .expect("error while building confirm harness")
        .run(|_app, _event| {});
}
