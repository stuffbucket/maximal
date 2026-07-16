use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

use crate::native_i18n;
use crate::state::{AppStatus, LatestUpdate, LocaleState, ShellApiKey, UpdateSnapshot};
use crate::tray::refresh_tray;

/// Update check: GET `/settings/api/update-status` against the sidecar and
/// hand the result to `apply_update`, which updates the "Upgrade to v…" tray
/// item and fires a single OS notification when a newer version first appears.
/// Returns true once a definitive 2xx response is seen (so the periodic caller
/// records the check time); false on a transient failure (unreachable /
/// non-2xx / unparseable) so it retries on the next poll tick. The sidecar
/// caches the upstream lookup for hours and honors `config.checkUpdates`, so
/// this stays cheap and is a no-op when the user opted out.
pub(crate) async fn check_for_update(app: &AppHandle, client: &reqwest::Client, url: &str) -> bool {
    let key = app.state::<ShellApiKey>().value().to_owned();
    let resp = match client.get(url).header("x-api-key", key).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return false, // transient — retry next tick
    };
    let payload: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return false,
    };
    let available = payload
        .get("update_available")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let next = if available {
        let latest = payload
            .get("latest")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_owned();
        let download_url = payload
            .get("url")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("https://mxml.sh/maximal/")
            .to_owned();
        Some(UpdateSnapshot {
            latest,
            url: download_url,
        })
    } else {
        None
    };
    apply_update(app, next);
    true // definitive response — recorded; the periodic loop re-checks later
}

/// Applies a fetched update snapshot to managed state. Fires a single OS
/// notification when a newer version first appears (or the target changes),
/// and refreshes the tray on any change so the "Upgrade to v…" item appears
/// (or clears once the user is current). Mirrors `apply_rejection`: an
/// unchanged snapshot is a no-op, so a repeated periodic check that finds the
/// same version doesn't re-nag or churn the menu.
fn apply_update(app: &AppHandle, next: Option<UpdateSnapshot>) {
    if !app.state::<LatestUpdate>().set(next.clone()) {
        return; // unchanged — no re-notify, no tray churn
    }
    if let Some(update) = &next {
        fire_update_notification(app, &update.latest, &update.url);
    }
    let current_state = app.state::<AppStatus>().get();
    if let Err(err) = refresh_tray(app, current_state) {
        eprintln!("[shell] tray refresh after update change failed: {err}");
    }
}

/// One-shot banner notification when a newer release is available. Same
/// best-effort caveats as `fire_rejection_notification` (dev `cargo run` may
/// silently no-op without a signed bundle). The body names the download page;
/// Settings → Diagnostics carries the clickable link.
fn fire_update_notification(app: &AppHandle, latest: &str, url: &str) {
    use tauri_plugin_notification::NotificationExt;
    let locale = app.state::<LocaleState>().get();
    let title = if latest.is_empty() {
        native_i18n::tr(&locale, "native-notify-update-title")
    } else {
        native_i18n::t(
            &locale,
            "native-notify-update-title-versioned",
            &[("latest", latest)],
        )
    };
    let body = native_i18n::t(&locale, "native-notify-update-body", &[("url", url)]);
    if let Err(err) = app.notification().builder().title(title).body(body).show() {
        eprintln!("[shell] update notification failed: {err}");
    }
}

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

/// Tray "Upgrade to v…" click. Attempts an in-place install — download the
/// signed `.app.tar.gz`, verify its Ed25519 signature against the configured
/// `pubkey`, swap the bundle, and relaunch — and falls back to opening the
/// download page in the browser whenever that path isn't available: a dev
/// build, an unreachable/absent updater endpoint, no signed artifact for this
/// platform yet, or a failed check. That keeps the button useful everywhere the
/// notify path surfaces it, even before the signed-artifact pipeline covers a
/// channel. Runs on the async runtime because the updater check does network I/O.
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

/// Native confirm → download+install → relaunch. The dialog is non-blocking
/// (mirrors `request_quit`); on confirm we download on the async runtime and
/// then `app.restart()`, which routes through RunEvent::ExitRequested →
/// `kill_sidecar` so the old sidecar is torn down before the fresh shell
/// relaunches and spawns the new one with `--replace`. A failed download leaves
/// the user on the download page rather than silently doing nothing.
fn prompt_and_install(app: &AppHandle, update: tauri_plugin_updater::Update) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let locale = app.state::<LocaleState>().get();
    let version = update.version.clone();
    let app_clone = app.clone();
    app.dialog()
        .message(native_i18n::tr(&locale, "native-update-install-body"))
        .title(native_i18n::t(
            &locale,
            "native-update-install-title",
            &[("latest", &version)],
        ))
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            native_i18n::tr(&locale, "native-update-install-confirm"),
            native_i18n::tr(&locale, "native-update-install-cancel"),
        ))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            let app_inner = app_clone.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = update
                    .download_and_install(|_chunk, _total| {}, || {})
                    .await
                {
                    eprintln!("[shell] in-place install failed: {err}");
                    open_update_url(&app_inner);
                    return;
                }
                // Bundle swapped in place; relaunch into the new version.
                app_inner.restart();
            });
        });
}
