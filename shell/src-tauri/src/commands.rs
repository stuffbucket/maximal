use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::ShellExt;

use crate::native_i18n;
use crate::sidecar::{extract_error_reason, fetch_token_usage, respawn_sidecar};
use crate::state::{
    canonical_period, AppStatus, LocaleState, MenuBarOnly, ShellApiKey, TokenUsageEvent,
};
use crate::tray::refresh_tray;
use crate::windows::{open_dashboard_window, open_settings_window, retitle_windows};

/// How often `subscribe_token_usage` GETs `/token-usage` from the
/// sidecar. Each iteration also probes the `Channel<TokenUsageEvent>`
/// — when the JS side drops the channel, the next `send` returns Err
/// and the loop exits cleanly.
const DASHBOARD_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Streaming command: subscribes the caller to a steady feed of
/// `/token-usage?period=…` snapshots. The loop terminates when the
/// JS side drops the channel (next `send` returns Err) — which is
/// also how period changes work: the webview discards the current
/// channel + calls `subscribe_token_usage` again with the new period.
///
/// Errors during a single fetch are emitted as `Error` events but do
/// not terminate the loop — transient sidecar restarts shouldn't
/// require the dashboard to re-subscribe.
#[tauri::command]
pub(crate) async fn subscribe_token_usage(
    period: String,
    on_event: Channel<TokenUsageEvent>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let period = canonical_period(&period);

    loop {
        match fetch_token_usage(&client, period).await {
            Ok(payload) => {
                if on_event.send(TokenUsageEvent::Update { payload }).is_err() {
                    return Ok(());
                }
            }
            Err(message) => {
                if on_event.send(TokenUsageEvent::Error { message }).is_err() {
                    return Ok(());
                }
            }
        }
        tokio::time::sleep(DASHBOARD_POLL_INTERVAL).await;
    }
}

#[tauri::command]
pub(crate) fn get_shell_api_key(state: State<'_, ShellApiKey>) -> String {
    state.value().to_string()
}

/// The maximal app-data root, resolved to stay in LOCKSTEP with the
/// sidecar's own path convention (src/lib/paths.ts). Both must agree or
/// the tray's "reveal" menu items open a different folder than the one
/// the proxy reads/writes.
///
///   * `COPILOT_API_HOME` (env) wins on every platform when set.
///   * Windows → `%APPDATA%\maximal` (dictated path contract).
///   * Unix (macOS/Linux) → `~/.local/share/maximal`.
///
/// Returns None only if we can't even resolve the home/appdata base.
fn maximal_data_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    if let Some(home) = std::env::var_os("COPILOT_API_HOME") {
        let p = std::path::PathBuf::from(home);
        if !p.as_os_str().is_empty() {
            return Some(p);
        }
    }

    #[cfg(target_os = "windows")]
    {
        // %APPDATA% is the per-user roaming app-data root
        // (C:\Users\<user>\AppData\Roaming). Falls back to Tauri's
        // resolver if the env var is somehow unset.
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let p = std::path::PathBuf::from(appdata);
            if !p.as_os_str().is_empty() {
                return Some(p.join("maximal"));
            }
        }
        return app.path().app_data_dir().ok().map(|d| {
            // app_data_dir() yields %APPDATA%\<identifier>; redirect to the
            // sidecar's `maximal` folder so they stay in lockstep.
            d.parent()
                .map(|parent| parent.join("maximal"))
                .unwrap_or_else(|| d.join("maximal"))
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = app.path().home_dir().ok()?;
        Some(home.join(".local").join("share").join("maximal"))
    }
}

pub(crate) fn do_reveal_config_dir(app: &AppHandle) {
    let Some(dir) = maximal_data_dir(app) else {
        return;
    };
    let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
}

/// Reads the persisted `config.ui.menuBarOnly` preference from
/// `<maximal-data-dir>/config.json` (the same directory the "Reveal config"
/// item opens, via `maximal_data_dir` — so it honors COPILOT_API_HOME and the
/// per-OS data root). Every failure mode — no data dir, missing file,
/// unparseable JSON, or a missing / non-boolean field — collapses to the
/// DEFAULT `false` (show in Dock/taskbar). Never panics; the on-disk write
/// itself is owned by another layer.
pub(crate) fn read_menu_bar_only(app: &AppHandle) -> bool {
    let Some(path) = maximal_data_dir(app).map(|d| d.join("config.json")) else {
        return false;
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return false;
    };
    json["ui"]["menuBarOnly"].as_bool().unwrap_or(false)
}

/// Path to the persisted locale file — a one-line BCP-47 tag written by the
/// `set_locale` command. Lives beside the sidecar's data so it survives
/// restarts and, crucially, is readable BEFORE any webview loads: the
/// first-launch "Maximal is running" banner needs a locale before the picker
/// has ever run this session, and the last explicit choice beats the OS locale.
fn locale_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    maximal_data_dir(app).map(|d| d.join("locale"))
}

/// The persisted picker choice, if present and still a locale we ship.
pub(crate) fn persisted_locale(app: &AppHandle) -> Option<String> {
    let path = locale_file(app)?;
    let tag = std::fs::read_to_string(path).ok()?.trim().to_string();
    native_i18n::AVAILABLE
        .contains(&tag.as_str())
        .then_some(tag)
}

/// Persist the picker choice so the NEXT launch's pre-webview strings match it.
/// Best-effort: a write failure just means the next cold start falls back to the
/// OS locale until the webview re-pushes the choice.
fn write_locale(app: &AppHandle, tag: &str) {
    let Some(path) = locale_file(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(err) = std::fs::write(&path, tag) {
        eprintln!("[shell] could not persist locale {tag}: {err}");
    }
}

pub(crate) fn do_reveal_logs_dir(app: &AppHandle) {
    let Some(dir) = maximal_data_dir(app).map(|d| d.join("logs")) else {
        return;
    };
    // Sidecar creates this lazily on first request log. Create it
    // here so the menu item always lands somewhere, even on first
    // boot before any request has been served.
    if let Err(err) = std::fs::create_dir_all(&dir) {
        eprintln!("[shell] could not create logs dir {dir:?}: {err}");
    }
    let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
}

/// Entry point for the tray's "Quit Maximal" item. Pops a native
/// confirm dialog via `tauri-plugin-dialog`; on accept, calls
/// `app.exit(0)` which routes through `RunEvent::ExitRequested` →
/// `kill_sidecar` (graceful SIGTERM + 3s SIGKILL escalation).
///
/// Previous implementation opened the Settings webview, emitted an
/// `app://quit-requested` event, and listened from a React modal
/// (QuitConfirmDialog island). That fought a `tauri://load-end` race
/// when Settings was hidden-but-loaded (close-to-tray state) — the
/// event fired before the modal could re-mount, and the dialog
/// silently never appeared. The native dialog has no such race: it's
/// owned by the OS, not by our webview's lifecycle.
pub(crate) fn request_quit(app: &AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let locale = app.state::<LocaleState>().get();
    let app_clone = app.clone();
    app.dialog()
        .message(native_i18n::tr(&locale, "native-quit-body"))
        .title(native_i18n::tr(&locale, "native-quit-title"))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            native_i18n::tr(&locale, "native-quit-confirm"),
            native_i18n::tr(&locale, "native-quit-cancel"),
        ))
        .show(move |confirmed| {
            if confirmed {
                app_clone.exit(0);
            }
        });
}

/// Graceful shutdown from the single-instance `--replace` path.
///
/// Reuses the same teardown path as the tray Quit item, MINUS the
/// confirm dialog: a second `maximal --replace` invocation is the
/// user (or a CLI/installer) explicitly asking the running instance
/// to release :4141, so prompting them would just be in the way.
///
/// `app.exit(0)` routes through `RunEvent::ExitRequested` →
/// `kill_sidecar` (SIGTERM + 3s SIGKILL escalation), which is exactly
/// the cleanup we need. Kept as its own function so the intent of the
/// single-instance callback stays legible.
pub(crate) fn graceful_shutdown(app: &AppHandle) {
    app.exit(0);
}

/// Tauri command exposed to the frontend.
///
/// Lets the dashboard JS request a deep-link to a specific Settings
/// section (`account`, `proxy`, etc.). Same behavior as the tray's
/// "Sign in to GitHub…" item.
#[tauri::command]
pub(crate) fn open_settings_at(app: AppHandle, section: String) {
    let section_trimmed = section.trim();
    let section_opt = if section_trimmed.is_empty() {
        None
    } else {
        Some(section_trimmed)
    };
    open_settings_window(&app, section_opt);
}

/// Tauri command — open (or focus) the usage dashboard.
#[tauri::command]
pub(crate) fn open_dashboard(app: AppHandle) {
    open_dashboard_window(&app);
}

/// Tauri command — reveal the maximal config directory in Finder/Explorer.
/// Wired to the "Reveal config" button in the Settings footer.
#[tauri::command]
pub(crate) fn reveal_config_dir(app: AppHandle) {
    do_reveal_config_dir(&app);
}

/// Tauri command — reveal the maximal logs directory in Finder/Explorer.
/// Wired to the "Open logs" buttons in the Settings UI.
#[tauri::command]
pub(crate) fn reveal_logs_dir(app: AppHandle) {
    do_reveal_logs_dir(&app);
}

/// Tauri command — apply the menu-bar-only preference LIVE. The Settings UI
/// calls this with `{ menuBarOnly: boolean }` after persisting the value to
/// config.json (that on-disk write is another layer's job). We mirror it into
/// the runtime `MenuBarOnly` flag and re-derive platform presence right away:
/// on macOS through `update_activation_policy` (Dock icon on when NOT
/// menu-bar-only, else the show-only-while-a-window-is-visible behavior); on
/// Windows by toggling taskbar presence on any open Settings/Dashboard windows,
/// opening Settings if turning presence on while nothing is showing.
#[tauri::command]
pub(crate) fn set_menu_bar_only(app: AppHandle, menu_bar_only: bool) {
    app.state::<MenuBarOnly>().set(menu_bar_only);

    // macOS: no-op-skip inside update_activation_policy keeps this cheap when
    // the effective policy doesn't actually change.
    #[cfg(target_os = "macos")]
    crate::windows::update_activation_policy(&app);

    // Windows: flip taskbar presence on windows that already exist…
    #[cfg(windows)]
    {
        for label in [
            crate::windows::SETTINGS_WINDOW_LABEL,
            crate::windows::DASHBOARD_WINDOW_LABEL,
        ] {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.set_skip_taskbar(menu_bar_only);
            }
        }
        // …and, when turning taskbar presence ON with nothing open, open
        // Settings so a taskbar button exists (mirrors the launch-time open).
        // TODO(windows): a persistent taskbar button with no window open is a
        // follow-up; until then an open window stands in for it.
        if !menu_bar_only
            && app
                .get_webview_window(crate::windows::SETTINGS_WINDOW_LABEL)
                .is_none()
            && app
                .get_webview_window(crate::windows::DASHBOARD_WINDOW_LABEL)
                .is_none()
        {
            open_settings_window(&app, None);
        }
    }
}

/// Tauri command — deliberately reboot the sidecar. The UI calls this after a
/// sign-out (the on-disk token is already deleted, so the fresh process boots
/// unauthenticated) and, in future, after an account switch (boot into the
/// newly-active account). Rebooting reconstructs all auth/discovery state from
/// the on-disk config instead of editing the running instance, so the
/// refresh-loop / cached-model teardown can't be done half-way. Unlike
/// `retry_startup`, this runs from any state including Ready — the UI gates the
/// intent (an explicit user action), not this command.
#[tauri::command]
pub(crate) fn restart_sidecar(app: AppHandle) {
    eprintln!("[shell] sidecar restart requested");
    respawn_sidecar(&app);
}

/// Tauri command — run the in-app uninstall. Spawns the bundled sidecar with
/// `maximal uninstall --unattended --keep-app --force` (plus `--purge` when the
/// Settings webview asks). `--force` is mandatory here: the in-app flow is an
/// explicit "uninstall now" action that can't surface the CLI's
/// refuse-while-apps-enabled message, so the CLI disables any enabled app
/// integrations itself and reverts them through the registry. `--keep-app` is
/// likewise mandatory: the running `.app` can't delete the bundle it's
/// executing from, so the CLI removes the launchd agent, the
/// `~/.local/bin/maximal` PATH symlink, and the other PATH binaries, then the
/// user drags Maximal to the Trash to finish. Returns `Err(String)` (a
/// human-readable reason) on a missing binary or non-zero exit so the webview
/// can surface a non-blocking inline error instead of silently stranding the
/// user. Mirrors the spawn+`.output()` shape of `reconcile_claude_code_revert`.
#[tauri::command]
pub(crate) async fn uninstall_maximal(app: AppHandle, purge: bool) -> Result<(), String> {
    eprintln!("[shell] in-app uninstall requested (purge={purge})");
    let mut args: Vec<String> = vec![
        "uninstall".to_string(),
        "--unattended".to_string(),
        "--keep-app".to_string(),
        "--force".to_string(),
    ];
    if purge {
        args.push("--purge".to_string());
    }
    let command = app
        .shell()
        .sidecar("maximal")
        .map_err(|err| format!("could not build uninstall command: {err}"))?
        .args(args);
    let output = command
        .output()
        .await
        .map_err(|err| format!("uninstall failed to run: {err}"))?;
    if output.status.success() {
        eprintln!("[shell] in-app uninstall completed");
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason = extract_error_reason(&stderr)
            .unwrap_or_else(|| format!("uninstall exited {:?}", output.status.code()));
        eprintln!("[shell] in-app uninstall failed: {reason}");
        Err(reason)
    }
}

/// Tauri command — adopt the locale the in-app picker just selected so the
/// native chrome (tray menu, tooltip, later notifications) follows the same
/// language as the webview. The webview persists its own choice to
/// localStorage; this command carries that choice across the process boundary
/// into `LocaleState` and rebuilds the tray so the OS-drawn strings re-resolve
/// through `native_i18n` immediately. An unrecognized tag (not in
/// `native_i18n::AVAILABLE`) is rejected so a typo can't strand the native UI
/// on a locale we don't ship.
#[tauri::command]
pub(crate) fn set_locale(
    app: AppHandle,
    locale: State<'_, LocaleState>,
    tag: String,
) -> Result<(), String> {
    if !native_i18n::AVAILABLE.contains(&tag.as_str()) {
        return Err(format!("unsupported locale: {tag}"));
    }
    // The webview pushes on every boot, not just on a picker change, so skip the
    // tray rebuild / retitle when nothing actually changed (avoids a needless
    // menu flicker each time a window opens).
    if locale.get() == tag {
        return Ok(());
    }
    locale.set(tag.clone());
    eprintln!("[shell] native locale set to {tag}");
    // Persist so the NEXT launch's pre-webview strings (startup banner) match
    // this choice instead of falling back to the OS locale.
    write_locale(&app, &tag);
    // Re-render the OS-drawn chrome NOW: rebuild the tray menu/tooltip and
    // retitle any open Settings/Dashboard window so the switch is live, not
    // deferred to the next open. Later notifications/dialogs read LocaleState.
    let state = app.state::<AppStatus>().get();
    if let Err(err) = refresh_tray(&app, state) {
        eprintln!("[shell] tray refresh after locale change failed: {err}");
    }
    retitle_windows(&app);
    Ok(())
}
