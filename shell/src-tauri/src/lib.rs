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

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    ipc::Channel,
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// Canonical Maximal port. Apps integrating with the proxy (Claude
// Code, Cursor, custom scripts) only need to know this one URL:
// http://localhost:4141. The Tauri shell and the standalone CLI both
// bind here; the shell passes `--replace` when spawning so it always
// wins over a stale CLI instance (graceful eviction via
// /_internal/shutdown — see src/lib/replace-running.ts).
const SIDECAR_PORT: u16 = 4141;

/// Prefix the sidecar prints (stdout) for structured boot-status lines we
/// relay to the splash. MUST match `BOOT_STATUS_MARKER` in src/start.ts.
const BOOT_STATUS_MARKER: &str = "@@MAXIMAL_STATUS@@";

/// Brand-minimum time the splash stays on screen once the sidecar reaches a
/// Running state, before it fades. The state-aware dismiss loop in
/// `create_splash` enforces this, and the first-run Settings auto-open
/// (`apply_state`) defers to it so Settings doesn't race up over the splash.
const SPLASH_MIN_DISPLAY: Duration = Duration::from_millis(1600);

/// How often `subscribe_token_usage` GETs `/token-usage` from the
/// sidecar. Each iteration also probes the `Channel<TokenUsageEvent>`
/// — when the JS side drops the channel, the next `send` returns Err
/// and the loop exits cleanly.
const DASHBOARD_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// How often the phase-2 poll re-checks for a newer release. Generous on
/// purpose — releases are rare and the sidecar caches the upstream lookup for
/// hours — but finite so a long-running menu-bar session still notices a
/// release published after launch. Aligns with the sidecar's cache TTL.
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Allowed values for the dashboard's `period` query parameter.
/// Anything else from the webview is clamped to "day".
const DASHBOARD_PERIODS: &[&str] = &["day", "week", "month"];

const TRAY_ID: &str = "main";
// Two webview windows, both pointed at the sidecar:
//   settings  — http://localhost:4141/ui/settings/  (React app)
//   dashboard — http://localhost:4141/ui/dashboard/  (usage charts)
// Both UIs are embedded in the sidecar binary and served at /ui/* —
// see src/routes/ui/route.ts.
// Labels are referenced from capabilities/default.json `windows`.
const SETTINGS_WINDOW_LABEL: &str = "settings";
const DASHBOARD_WINDOW_LABEL: &str = "dashboard";

// Tray icon assets — embedded at compile time so we don't have to
// resolve resource paths at runtime. The SVG sources live alongside
// at icons/tray/*.svg; the PNGs are pre-rendered at the @2x retina
// size (44×44) so AppKit downsamples cleanly to the 22pt menu-bar
// height that HIG calls for. Loading the 1× 22-pixel PNG instead
// made the icon visibly smaller than its neighbors on retina because
// AppKit treats the pixel size as the logical size by default.
// Tauri's image-png feature decodes these via the `image` crate.
const TRAY_ICON_NORMAL: &[u8] = include_bytes!("../icons/tray/icon@2x.png");
const TRAY_ICON_STARTING: &[u8] = include_bytes!("../icons/tray/icon-starting@2x.png");
const TRAY_ICON_ATTENTION: &[u8] = include_bytes!("../icons/tray/icon-attention@2x.png");

mod menu_id {
    pub const SETTINGS: &str = "settings";
    pub const DASHBOARD: &str = "dashboard";
    pub const QUIT: &str = "quit";
    pub const SIGN_IN: &str = "sign_in";
    pub const ACCOUNT_INFO: &str = "account_info";
    pub const STARTING: &str = "starting";
    pub const FAILED: &str = "failed";
    pub const SHOW_LOGS: &str = "show_logs";
    pub const RETRY: &str = "retry";
    pub const OPEN_CONFIG: &str = "open_config";
    pub const UPGRADE: &str = "upgrade";
}

/// High-level tray state. Each transition rebuilds the menu and swaps
/// the tray icon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SidecarState {
    Starting,
    RunningUnauthenticated,
    RunningAuthenticated,
    #[allow(dead_code)]
    Stopped,
    Failed,
}

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
        *self.0.lock().expect("sidecar mutex poisoned") = Some(child);
    }

    fn take(&self) -> Option<CommandChild> {
        self.0.lock().expect("sidecar mutex poisoned").take()
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        // Last-resort cleanup if RunEvent::ExitRequested didn't fire
        // (e.g. a Rust panic inside `app.run`, or some other abnormal
        // teardown). We skip the SIGTERM-then-SIGKILL escalation that
        // `kill_sidecar` does — Drop is the abnormal-exit path, where
        // graceful shutdown isn't on the table anyway. CommandChild::kill()
        // is SIGKILL under the hood, which is exactly what we want here:
        // don't leak a zombie.
        if let Ok(mut guard) = self.0.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}

/// Snapshot of the last non-fatal upstream rejection (quota exhausted,
/// model not on plan, transient upstream error). Pulled from the
/// sidecar's `/settings/api/auth/github/status` endpoint and used to
/// drive the ATTENTION tray icon and a one-shot OS notification on
/// rejection-state entry.
#[derive(Clone, Debug, PartialEq, Eq)]
struct RejectionSnapshot {
    message: String,
    status: u16,
    at: String,
    remediation_url: Option<String>,
}

/// Tracks the most recent rejection snapshot the rejection poller has
/// observed. None = no recent non-fatal rejection (healthy). Wrapped
/// in Mutex because both the polling task and tray-refresh path read it.
struct LastRejection(Mutex<Option<RejectionSnapshot>>);

impl LastRejection {
    fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn get(&self) -> Option<RejectionSnapshot> {
        self.0.lock().expect("rejection mutex poisoned").clone()
    }

    /// Returns true if the state transitioned from None → Some. Callers
    /// use that signal to fire the one-shot OS notification.
    fn set(&self, next: Option<RejectionSnapshot>) -> RejectionTransition {
        let mut guard = self.0.lock().expect("rejection mutex poisoned");
        let prev = guard.clone();
        if prev == next {
            return RejectionTransition::Unchanged;
        }
        *guard = next.clone();
        match (prev, next) {
            (None, Some(_)) => RejectionTransition::Entered,
            (Some(_), None) => RejectionTransition::Cleared,
            _ => RejectionTransition::Changed,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RejectionTransition {
    Unchanged,
    /// None → Some: notification fires here.
    Entered,
    /// Some → None: tray icon restores to NORMAL.
    Cleared,
    /// Some → Some(different): tray stays in ATTENTION, no re-notify.
    Changed,
}

/// The latest available release, as last reported by the sidecar's
/// `/settings/api/update-status`. None = up to date (or unknown). Drives the
/// "Upgrade to v…" tray item and a one-shot OS notification when a newer
/// version first appears. Mutex because the poll task writes it while the
/// tray-refresh and menu-event paths read it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct UpdateSnapshot {
    /// Latest version, no leading "v".
    latest: String,
    /// Install-channel-neutral download page.
    url: String,
}

/// Tracks the most recent update snapshot the poll loop has observed. Wrapped
/// in Mutex because the polling task and the tray paths both touch it.
struct LatestUpdate(Mutex<Option<UpdateSnapshot>>);

impl LatestUpdate {
    fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn get(&self) -> Option<UpdateSnapshot> {
        self.0.lock().expect("update mutex poisoned").clone()
    }

    /// Stores the snapshot; returns true if it changed (a newly available
    /// version, a changed target, or clearing back to up-to-date). Callers
    /// fire the one-shot notification only when the new value is Some, so a
    /// repeated periodic check that finds the same version doesn't re-nag.
    fn set(&self, next: Option<UpdateSnapshot>) -> bool {
        let mut guard = self.0.lock().expect("update mutex poisoned");
        if *guard == next {
            return false;
        }
        *guard = next;
        true
    }
}

/// Holds the most recent error-looking line the sidecar printed to stderr,
/// so a Starting→Failed transition can tell the user *why* it failed (on the
/// splash and in the OS notification) instead of a generic "couldn't start".
/// Cleared when a retry begins so a stale reason can't haunt a fresh attempt.
struct LastSidecarError(Mutex<Option<String>>);

impl LastSidecarError {
    fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn set(&self, reason: Option<String>) {
        *self.0.lock().expect("sidecar-error mutex poisoned") = reason;
    }

    fn get(&self) -> Option<String> {
        self.0.lock().expect("sidecar-error mutex poisoned").clone()
    }
}

/// Tracks the current SidecarState behind a Mutex so the polling task
/// (Tokio) and the menu-event callback (main thread) can both touch it.
struct AppStatus(Mutex<SidecarState>);

impl AppStatus {
    fn new() -> Self {
        Self(Mutex::new(SidecarState::Starting))
    }

    fn get(&self) -> SidecarState {
        *self.0.lock().expect("status mutex poisoned")
    }

    /// Returns Some(previous) if the state changed, None otherwise.
    fn set(&self, next: SidecarState) -> Option<SidecarState> {
        let mut guard = self.0.lock().expect("status mutex poisoned");
        if *guard == next {
            return None;
        }
        let prev = *guard;
        *guard = next;
        Some(prev)
    }
}

/// One-shot flag for "we've already auto-opened Settings to prompt
/// sign-in this session." Lets us open Settings → Account on the
/// first Starting → RunningUnauthenticated transition without
/// re-opening it every time the user manually quits + signs back in
/// while still unauthenticated.
struct SetupPromptShown(std::sync::atomic::AtomicBool);

impl SetupPromptShown {
    fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }

    /// Returns true the first time it's called; false on subsequent calls.
    fn claim(&self) -> bool {
        !self
            .0
            .swap(true, std::sync::atomic::Ordering::SeqCst)
    }
}

/// One-shot flag for "we've already dismissed the splash + fired the
/// 'we're running' notification this session." The first Starting →
/// Running transition claims it; later Unauthenticated ⇄ Authenticated
/// flips must not re-announce.
struct StartupAnnounced(std::sync::atomic::AtomicBool);

impl StartupAnnounced {
    fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }

    /// Returns true the first time it's called; false on subsequent calls.
    fn claim(&self) -> bool {
        !self.0.swap(true, std::sync::atomic::Ordering::SeqCst)
    }
}

/// One-shot guard so the splash is dismissed at most once and never
/// recreated — once it's gone it stays gone for the life of the process.
struct SplashDismissed(std::sync::atomic::AtomicBool);

impl SplashDismissed {
    fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }

    /// Returns true the first time it's called; false on subsequent calls.
    fn claim(&self) -> bool {
        !self.0.swap(true, std::sync::atomic::Ordering::SeqCst)
    }
}

/// Set while `respawn_sidecar` is intentionally cycling the sidecar (the
/// account-switch / sign-in / sign-out reboot). The old sidecar exits cleanly
/// from our SIGTERM, which the Terminated handler would otherwise read as a
/// user-initiated quit and bring the WHOLE app down — stranding the tray and
/// killing the reboot before the replacement spawns. The handler consumes this
/// flag and keeps the app alive for the respawn instead.
struct SidecarRestarting(std::sync::atomic::AtomicBool);

impl SidecarRestarting {
    fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }

    /// Mark that the next sidecar exit is an intentional restart, not a quit.
    fn begin(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Returns true (and clears the flag) if a restart was in progress.
    fn consume(&self) -> bool {
        self.0.swap(false, std::sync::atomic::Ordering::SeqCst)
    }
}

/// Random per-launch key the shell shares with its sidecar so the
/// webview can authenticate against /settings/api/* even when the user
/// has enabled "Block unknown connections." Injected as an env var when
/// spawning the sidecar; surfaced to the webview through the
/// `get_shell_api_key` Tauri command.
///
/// Lifetime is the shell process — a relaunch picks a fresh value, no
/// disk persistence. The sidecar dies with us, so there's no orphan key
/// to clean up.
struct ShellApiKey(String);

impl ShellApiKey {
    fn new() -> Self {
        Self(generate_shell_api_key())
    }

    fn value(&self) -> &str {
        &self.0
    }
}

/// 16 random bytes from `/dev/urandom`, hex-encoded, with a recognisable
/// prefix so it's greppable in logs / config diffs. Total length 41
/// chars — comfortably inside the sidecar's API_KEY_VALUE_PATTERN range
/// (8–128 chars of [A-Za-z0-9_-]).
fn generate_shell_api_key() -> String {
    use std::io::Read;
    let mut buf = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .expect("could not read /dev/urandom for shell api key");
    let hex: String = buf.iter().map(|b| format!("{:02x}", b)).collect();
    format!("mxlshell_{}", hex)
}

/// Streaming event the dashboard subscriber sends down the
/// `Channel<TokenUsageEvent>`. Tagged so the JS side can `switch` on
/// `msg.event` and unpack `msg.data` without sniffing shape.
///
/// `Update` carries the JSON response from `/token-usage?period=…`
/// verbatim. `Error` carries a stringified failure for the most
/// recent fetch attempt — the loop keeps retrying after emitting one
/// so a single blip doesn't kill the live feed.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
enum TokenUsageEvent {
    Update { payload: serde_json::Value },
    Error { message: String },
}

/// Sanitize the period string from the JS side, defaulting to "day"
/// for anything unrecognized. Returns `&'static str` so the URL
/// builder doesn't re-allocate per poll.
fn canonical_period(requested: &str) -> &'static str {
    DASHBOARD_PERIODS
        .iter()
        .copied()
        .find(|p| *p == requested)
        .unwrap_or("day")
}

/// One-shot GET of `/token-usage?period=…` against the local sidecar.
/// Returns the parsed JSON body on 2xx, an error string otherwise.
async fn fetch_token_usage(
    client: &reqwest::Client,
    period: &str,
) -> Result<serde_json::Value, String> {
    let url = format!(
        "http://127.0.0.1:{port}/token-usage?period={period}",
        port = SIDECAR_PORT,
    );
    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("status {}", response.status()));
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

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
async fn subscribe_token_usage(
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
                if on_event
                    .send(TokenUsageEvent::Update { payload })
                    .is_err()
                {
                    return Ok(());
                }
            }
            Err(message) => {
                if on_event
                    .send(TokenUsageEvent::Error { message })
                    .is_err()
                {
                    return Ok(());
                }
            }
        }
        tokio::time::sleep(DASHBOARD_POLL_INTERVAL).await;
    }
}

#[tauri::command]
fn get_shell_api_key(state: State<'_, ShellApiKey>) -> String {
    state.value().to_string()
}

#[derive(Debug, Deserialize)]
struct SetupCheckResult {
    ok: bool,
}

#[derive(Debug, Deserialize)]
struct SetupChecks {
    #[serde(rename = "githubAuth")]
    github_auth: SetupCheckResult,
}

#[derive(Debug, Deserialize)]
struct SetupStatusResponse {
    checks: SetupChecks,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
                focus_or_open_main_window(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
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
        .invoke_handler(tauri::generate_handler![
            open_settings_at,
            open_dashboard,
            reveal_config_dir,
            reveal_logs_dir,
            restart_sidecar,
            uninstall_maximal,
            get_shell_api_key,
            subscribe_token_usage,
        ])
        .setup(|app| {
            // Menu-bar app: start with no Dock icon. update_activation_policy
            // will flip to Regular when a Settings/Dashboard window becomes
            // visible, and back to Accessory when the last one hides.
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                // Dock icon: in release the .app bundle's Info.plist
                // CFBundleIconFile (driven by `bundle.icon` in
                // tauri.conf.json) handles this. `cargo run` doesn't
                // produce a bundle, so set the icon explicitly in debug
                // builds only — release builds skip the FFI dance.
                #[cfg(debug_assertions)]
                set_dock_icon();
            }

            // Install the tray FIRST so the user has a Quit affordance
            // before the sidecar's spawn even returns. Any failure
            // downstream still leaves a clickable menubar.
            install_tray(app.handle())?;
            apply_state(app.handle(), SidecarState::Starting);

            // Immediate visible feedback. This is a menu-bar-only app, so
            // launching it otherwise just adds a tray icon the user may
            // not notice ("clicking did nothing"). The splash is closed by
            // apply_state on the first Running/Failed transition.
            create_splash(app.handle());

            // Spawn sidecar. If this fails synchronously we go straight
            // to Failed — the user still sees the menubar.
            if let Err(err) = spawn_sidecar(app.handle()) {
                eprintln!("[shell] sidecar spawn failed: {err}");
                apply_state(app.handle(), SidecarState::Failed);
                return Ok(());
            }

            // Kick off the polling task. Tokio task (via Tauri's
            // async_runtime) — cheap, doesn't need its own thread, and
            // reqwest's async client integrates cleanly.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                poll_sidecar_status(handle).await;
            });

            Ok(())
        })
        .build(tauri::generate_context!())
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
            kill_sidecar(app_handle);
        }
        // macOS delivers Reopen when the app is re-activated — clicking its
        // notification banner, its Dock icon, etc. Desktop notifications
        // can't carry a routable button (the plugin's show() is
        // fire-and-forget), so this is how the sign-in nudge's "click here"
        // lands somewhere: if we're up but not signed in and nothing's on
        // screen, bring up Settings → account.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if !has_visible_windows
                && app_handle.state::<AppStatus>().get()
                    == SidecarState::RunningUnauthenticated
            {
                open_settings_window(app_handle, Some("account"));
            }
        }
        _ => {}
    });
}

fn spawn_sidecar(app: &AppHandle) -> tauri::Result<()> {
    // sidecar("maximal") looks up `bundle.externalBin[0]` from
    // tauri.conf.json and resolves the arch-suffixed binary
    // (binaries/maximal-aarch64-apple-darwin etc.) at build time.
    let port = SIDECAR_PORT.to_string();
    let mut cmd = app
        .shell()
        .sidecar("maximal")
        .map_err(|e| tauri::Error::Anyhow(e.into()))?
        // `--replace` makes the sidecar evict any existing maximal on
        // the port (CLI instance, prior dev session) via the proxy's
        // own graceful /_internal/shutdown protocol. Without this the
        // Tauri shell would refuse to start when a CLI is already
        // listening on :4141 — confusing UX for menu-bar users who
        // shouldn't have to know which copy started first.
        .args(["start", "--replace", "--port", port.as_str()]);

    // The settings + dashboard UIs are embedded directly in the sidecar
    // binary and served at /ui/* (see src/routes/ui/route.ts), so there is
    // nothing to stage or point at — the UI travels inside the binary in
    // both `tauri dev` and packaged builds. NODE_ENV=production is still
    // set for parity with `maximal start` defaults elsewhere.
    cmd = cmd.env("NODE_ENV", "production");
    // Hand the shell's PID to the sidecar for its parent-death
    // watchdog. If the tray app is force-killed (Activity Monitor,
    // OOM, panic past Drop), the sidecar polls this PID and exits
    // when it disappears so we don't orphan a proxy on :4141.
    cmd = cmd.env(
        "MAXIMAL_SIDECAR_PARENT_PID",
        std::process::id().to_string(),
    );
    // Shell-internal API key — the webview reads it via the
    // `get_shell_api_key` Tauri command and sends it on every
    // /settings/api/* request. Lets the user's own UI keep working
    // after they flip "Block unknown connections."
    cmd = cmd.env(
        "MAXIMAL_SHELL_KEY",
        app.state::<ShellApiKey>().value().to_string(),
    );

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| tauri::Error::Anyhow(e.into()))?;

    app.state::<Sidecar>().set(child);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    // Structured boot-status lines (emitBootStatus in
                    // src/start.ts) drive the splash's live status. Relay the
                    // message and don't echo the raw marker to our own stdout.
                    for raw in text.lines() {
                        if let Some(msg) = raw.trim().strip_prefix(BOOT_STATUS_MARKER)
                        {
                            let _ = handle.emit_to(
                                "splash",
                                "splash:status",
                                msg.trim().to_string(),
                            );
                        } else if !raw.is_empty() {
                            println!("[maximal] {raw}");
                        }
                    }
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line);
                    eprintln!("[maximal] {text}");
                    // Remember the latest error-looking line as the failure
                    // reason for the splash + notification. Best-effort heuristic
                    // over consola's output; falls back to a generic message.
                    if let Some(reason) = extract_error_reason(&text) {
                        handle.state::<LastSidecarError>().set(Some(reason));
                    }
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[maximal] sidecar exited: {:?}", payload);
                    // Intentional restart (account switch / sign-in / sign-out
                    // reboot)? respawn_sidecar set this flag before SIGTERMing
                    // the old child, and is already spawning the replacement.
                    // Keep the app alive — DON'T treat this exit as a quit.
                    if handle.state::<SidecarRestarting>().consume() {
                        eprintln!(
                            "[maximal] (intentional restart — keeping app alive for the respawn)"
                        );
                        break;
                    }
                    // Clean exit signals an intentional shutdown — either
                    // we just sent SIGTERM via kill_sidecar (Quit flow),
                    // or an external caller hit /_internal/shutdown
                    // (a fresh `bun run app:dev` evicting a previous
                    // session, the `maximal start --replace` CLI flow,
                    // etc.). In both cases the user wants the WHOLE app
                    // to come down, not a tray + windows stranded over a
                    // dead backend. handle.exit(0) is idempotent so
                    // overlapping with our own ExitRequested path is
                    // fine.
                    //
                    // Non-zero / signal-killed exits indicate a real
                    // failure: stay alive in Failed state so the user
                    // can see the tray badge and reach the logs.
                    if payload.code == Some(0) {
                        handle.exit(0);
                    } else {
                        // Crash / SIGKILL: the sidecar never reached its
                        // graceful-shutdown reconciler, so a Claude Code
                        // base URL it wrote may be stranded over a now-dead
                        // proxy. We outlive the sidecar, so revert it on its
                        // behalf via the shared CLI subcommand. Ownership-
                        // guarded and intent-neutral: it only removes the
                        // base URL we wrote, and leaves the persisted routing
                        // intent alone so a future restart re-applies it.
                        reconcile_claude_code_revert(&handle);
                        apply_state(&handle, SidecarState::Failed);
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// Run `maximal configure-claude-code --revert` as a one-shot sidecar
/// command. Called when the proxy sidecar *crashes* (non-zero exit) — it
/// can't revert its own Claude Code base URL in that path, so the shell
/// does it. Best-effort: a missing binary or non-zero exit is logged and
/// swallowed (the worst case is a stranded base URL the next clean boot
/// re-applies or the user toggles off). Fire-and-forget on a Tokio task so
/// the Terminated handler stays synchronous.
fn reconcile_claude_code_revert(app: &AppHandle) {
    let command = match app.shell().sidecar("maximal") {
        Ok(c) => c.args(["configure-claude-code", "--revert"]),
        Err(err) => {
            eprintln!("[shell] could not build claude-code revert command: {err}");
            return;
        }
    };
    tauri::async_runtime::spawn(async move {
        match command.output().await {
            Ok(out) if out.status.success() => {
                eprintln!("[shell] reverted Claude Code base URL after sidecar crash");
            }
            Ok(out) => {
                eprintln!(
                    "[shell] claude-code revert exited {:?}: {}",
                    out.status.code(),
                    String::from_utf8_lossy(&out.stderr),
                );
            }
            Err(err) => {
                eprintln!("[shell] claude-code revert failed to run: {err}");
            }
        }
    });
}

/// Pull a human-readable failure reason out of a sidecar stderr chunk, or
/// None if nothing in it looks like an error. consola's fancy reporter prints
/// errors as ` ERROR  <message>` (and a bracketed `[error] <message>` in
/// basic mode); we take the text after that tag, first line only, trimmed and
/// length-capped so a stack trace can't blow up the splash/notification.
fn extract_error_reason(chunk: &str) -> Option<String> {
    for raw in chunk.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        // Find the error tag in either consola style; take what follows.
        let after = line
            .find("ERROR")
            .map(|i| &line[i + "ERROR".len()..])
            .or_else(|| {
                line.find("[error]").map(|i| &line[i + "[error]".len()..])
            });
        if let Some(rest) = after {
            let msg = rest.trim_start_matches([' ', ':', ']']).trim();
            if !msg.is_empty() {
                let capped: String = msg.chars().take(180).collect();
                return Some(capped);
            }
        }
    }
    None
}

/// Graceful sidecar shutdown.
///
/// `CommandChild::kill()` from tauri-plugin-shell-2.3.5 is SIGKILL
/// under the hood (see process/mod.rs:78 — it calls `libc::kill(pid,
/// SIGKILL)` directly, not SIGTERM). That gives the Bun-compiled
/// sidecar no chance to flush logs, close its listening socket, or
/// shut down its rate-limit/state caches cleanly. We want a real
/// graceful protocol:
///
///   1. Send SIGTERM. The sidecar installs a SIGTERM handler at boot
///      that runs `server.close(true)` and flushes consola before
///      exiting 0 — see src/start.ts.
///   2. Wait up to 3s for the child to exit on its own. We do this on
///      a background thread so this function can stay synchronous
///      (called from `RunEvent::ExitRequested`, which doesn't await).
///   3. If the child is still around (still in our `Sidecar` state)
///      after 3s, escalate to SIGKILL via `CommandChild::kill()`.
///
/// On non-Unix targets, libc::SIGTERM isn't available, so we fall
/// straight through to `child.kill()`. The tray app is macOS-first;
/// this just keeps any future Windows builds compiling.
fn kill_sidecar(app: &AppHandle) {
    let Some(child) = app.state::<Sidecar>().take() else {
        return;
    };

    #[cfg(unix)]
    {
        // Capture the PID before handing the child off to the
        // escalation task. `CommandChild::pid()` returns u32; libc::kill
        // wants i32.
        let pid = child.pid() as i32;

        // SAFETY: `libc::kill` is an FFI call to the POSIX kill(2)
        // syscall. It's safe for any pid value — if the pid is invalid
        // or has already exited, kill returns -1 with errno=ESRCH and
        // does nothing. We deliberately ignore the return: the only
        // failure mode we care about (child already dead) is fine.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }

        // MOVE the old child into the escalation thread — do NOT put it back
        // in the shared Sidecar slot. respawn_sidecar calls spawn_sidecar
        // immediately after us, which set()s the REPLACEMENT child into that
        // slot; if this escalation re-read the slot it would SIGKILL the FRESH
        // sidecar ~3s after a restart (the proxy would vanish from :4141 and
        // the whole UI would "Load failed" — the account-switch/sign-in/
        // sign-out reboot bug). Holding the specific old child here SIGKILLs
        // only it. Dropping a CommandChild does NOT kill its process, so
        // leaving the slot empty until spawn_sidecar fills it is safe.
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            // No-op if the SIGTERM above already made it exit.
            let _ = child.kill();
        });
    }

    #[cfg(not(unix))]
    {
        // No SIGTERM equivalent we can send through this API on
        // Windows; just SIGKILL-equivalent and move on.
        let _ = child.kill();
    }
}

/// Polls the sidecar's /setup-status endpoint, driving SidecarState
/// transitions. First successful response within 30s flips Starting to
/// Running{Un,}Authenticated; after that, slower 5s polling watches
/// for auth changes initiated from Settings.
async fn poll_sidecar_status(app: AppHandle) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(err) => {
            eprintln!("[shell] reqwest client build failed: {err}");
            apply_state(&app, SidecarState::Failed);
            return;
        }
    };

    let url = format!("http://127.0.0.1:{SIDECAR_PORT}/setup-status");

    // Phase 1: fast poll until first success or 30s timeout.
    let startup_deadline =
        std::time::Instant::now() + Duration::from_secs(30);
    let mut first_seen = false;
    while std::time::Instant::now() < startup_deadline {
        if let Some(status) = fetch_setup_status(&client, &url).await {
            apply_setup_status(&app, &status);
            first_seen = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    if !first_seen {
        // Only flip to Failed if we haven't already moved off Starting
        // (e.g. via a stderr-driven Terminated transition).
        if app.state::<AppStatus>().get() == SidecarState::Starting {
            apply_state(&app, SidecarState::Failed);
        }
        return;
    }

    // Phase 2: slow poll. 5s cadence is plenty to catch the user
    // signing in via Settings — the device-code flow takes 30+ seconds
    // end-to-end, so the tray icon updates well before they look at it.
    // The same loop also fetches the auth-status sidecar to drive the
    // upstream-rejection tray badge + OS notification.
    let auth_status_url = format!(
        "http://127.0.0.1:{SIDECAR_PORT}/settings/api/auth/github/status",
    );
    let update_status_url = format!(
        "http://127.0.0.1:{SIDECAR_PORT}/settings/api/update-status",
    );
    // Periodic update check: a menu-bar app can stay open for days, well past a
    // new release, so we re-check on an interval rather than once per launch.
    // `last_update_check` holds the last DEFINITIVE check; a transient failure
    // leaves it unchanged so the next 5s tick retries (e.g. the network came
    // back after a cold start). The first iteration checks immediately.
    let mut last_update_check: Option<std::time::Instant> = None;
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        // Stop polling if we've already concluded the sidecar is gone.
        let current = app.state::<AppStatus>().get();
        if matches!(current, SidecarState::Failed | SidecarState::Stopped) {
            return;
        }
        if let Some(status) = fetch_setup_status(&client, &url).await {
            apply_setup_status(&app, &status);
        }
        if let Some(rejection) =
            fetch_rejection(&app, &client, &auth_status_url).await
        {
            apply_rejection(&app, rejection);
        }
        let update_due = last_update_check
            .is_none_or(|t| t.elapsed() >= UPDATE_CHECK_INTERVAL);
        if update_due
            && check_for_update(&app, &client, &update_status_url).await
        {
            last_update_check = Some(std::time::Instant::now());
        }
        // A single failed poll during phase 2 is ignored — the proxy
        // might be momentarily busy. We only flip to Failed via the
        // sidecar's Terminated event.
    }
}

/// One-shot fetch of `/settings/api/auth/github/status` against the
/// local sidecar, scoped to the rejection sidecar. Returns
/// `Some(Option<...>)` to distinguish "endpoint replied" (the
/// sidecar may or may not have a rejection) from "endpoint unreachable"
/// (silent skip — don't churn the tray icon on a transient).
async fn fetch_rejection(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
) -> Option<Option<RejectionSnapshot>> {
    let key = app.state::<ShellApiKey>().value().to_owned();
    let resp = client
        .get(url)
        .header("x-api-key", key)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let payload: serde_json::Value = resp.json().await.ok()?;
    Some(parse_rejection_from_status(&payload))
}

fn parse_rejection_from_status(
    payload: &serde_json::Value,
) -> Option<RejectionSnapshot> {
    let obj = payload.get("last_upstream_rejection")?.as_object()?;
    let message = obj.get("message")?.as_str()?.to_owned();
    let status = obj.get("status")?.as_u64()? as u16;
    let at = obj.get("at")?.as_str()?.to_owned();
    let remediation_url = obj
        .get("remediation_url")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    Some(RejectionSnapshot {
        message,
        status,
        at,
        remediation_url,
    })
}

/// Applies a fetched rejection snapshot to the LastRejection managed
/// state. On state-entering transitions, fires a single OS notification.
/// On any change (entered, cleared, or content change), refreshes the
/// tray so the icon and tooltip reflect the new condition.
fn apply_rejection(app: &AppHandle, next: Option<RejectionSnapshot>) {
    let entered_message =
        next.as_ref().map(|r| r.message.clone()).unwrap_or_default();
    let transition = app.state::<LastRejection>().set(next);
    match transition {
        RejectionTransition::Unchanged => return,
        RejectionTransition::Entered => {
            fire_rejection_notification(app, &entered_message);
        }
        RejectionTransition::Cleared | RejectionTransition::Changed => {}
    }
    let current_state = app.state::<AppStatus>().get();
    if let Err(err) = refresh_tray(app, current_state) {
        eprintln!("[shell] tray refresh after rejection change failed: {err}");
    }
}

/// One-shot banner notification on rejection-state entry. Cross-platform
/// via tauri-plugin-notification (macOS NSUserNotification, Windows toast,
/// Linux libnotify). Best-effort: a permission denial or backend failure
/// must not block the poll loop. macOS requires a signed/bundled app for
/// the first-call permission prompt to succeed — in dev (`cargo run`)
/// the notification may silently no-op, which is expected.
fn fire_rejection_notification(app: &AppHandle, message: &str) {
    use tauri_plugin_notification::NotificationExt;
    let body = if message.is_empty() {
        "An upstream Copilot request was rejected. Open Settings for details.".to_owned()
    } else {
        format!("{message} — open Settings for details.")
    };
    if let Err(err) = app
        .notification()
        .builder()
        .title("Maximal")
        .body(body)
        .show()
    {
        eprintln!("[shell] rejection notification failed: {err}");
    }
}

/// Update check: GET `/settings/api/update-status` against the sidecar and
/// hand the result to `apply_update`, which updates the "Upgrade to v…" tray
/// item and fires a single OS notification when a newer version first appears.
/// Returns true once a definitive 2xx response is seen (so the periodic caller
/// records the check time); false on a transient failure (unreachable /
/// non-2xx / unparseable) so it retries on the next poll tick. The sidecar
/// caches the upstream lookup for hours and honors `config.checkUpdates`, so
/// this stays cheap and is a no-op when the user opted out.
async fn check_for_update(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
) -> bool {
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
    let title = if latest.is_empty() {
        "Maximal update available".to_owned()
    } else {
        format!("Maximal {latest} is available")
    };
    let body = format!("Update at {url}");
    if let Err(err) =
        app.notification().builder().title(title).body(body).show()
    {
        eprintln!("[shell] update notification failed: {err}");
    }
}

async fn fetch_setup_status(
    client: &reqwest::Client,
    url: &str,
) -> Option<SetupStatusResponse> {
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<SetupStatusResponse>().await.ok()
}

fn apply_setup_status(app: &AppHandle, status: &SetupStatusResponse) {
    let next = if status.checks.github_auth.ok {
        SidecarState::RunningAuthenticated
    } else {
        SidecarState::RunningUnauthenticated
    };
    apply_state(app, next);
}

/// Sets the AppStatus and, if it changed, rebuilds the tray icon +
/// menu. Idempotent — calling with the current state is a no-op.
///
/// First-launch sign-in nudge: when the sidecar first reports it's
/// running but unauthenticated, open Settings → Account so the user
/// sees the device-flow CTA without having to discover the tray
/// menu. Guarded by `SetupPromptShown` so it fires at most once per
/// shell process — if the user explicitly signs out or closes the
/// Settings window before signing in, we don't keep re-opening it.
fn apply_state(app: &AppHandle, next: SidecarState) {
    let Some(prev) = app.state::<AppStatus>().set(next) else {
        return; // unchanged
    };
    if let Err(err) = refresh_tray(app, next) {
        eprintln!("[shell] tray refresh failed: {err}");
    }
    // First time we're up this session, announce it in the menu bar — but
    // tailor the banner: an authenticated start gets "we're running", an
    // unauthenticated start gets the sign-in nudge below instead, so we never
    // stack two banners. Claiming StartupAnnounced here (for either Running
    // state) also means a later Unauthenticated→Authenticated flip won't
    // re-announce "running".
    let first_up = matches!(
        next,
        SidecarState::RunningAuthenticated | SidecarState::RunningUnauthenticated
    ) && app.state::<StartupAnnounced>().claim();

    if next == SidecarState::RunningUnauthenticated {
        // Fires on first launch AND on a later drop to unauthenticated
        // (sign-out / token expiry). apply_state only runs on state CHANGES,
        // so this is once per entry into the unauthenticated state, not
        // repeatedly while we sit in it.
        fire_sign_in_notification(app);
        // Genuine cold start only (Starting→Unauthenticated): bring Settings
        // up so a brand-new user lands right on sign-in without hunting. A
        // mid-session drop (Authenticated→Unauthenticated, e.g. token expiry)
        // gets the notification only — don't yank a window open over whatever
        // they're doing; the notification click / tray brings it up on demand.
        if prev == SidecarState::Starting && app.state::<SetupPromptShown>().claim()
        {
            // Defer the auto-open until the splash has had its brand-minimum
            // display time. open_settings_window calls dismiss_splash
            // immediately, so opening synchronously here would yank Settings
            // up over (and kill) the splash on first run — the splash would
            // effectively never be seen. Sleeping SPLASH_MIN_DISPLAY first
            // mirrors the min-display the create_splash auto-dismiss loop
            // enforces on the Running state, so the sequence is:
            // splash shows → splash fades/closes → Settings appears. The
            // auto-dismiss loop still dismisses the splash on its own (it
            // fires on the Running state independently of this open), and the
            // SetupPromptShown.claim() above already gated this to exactly
            // once, so the deferred open fires once. Keep this deferred — do
            // not "simplify" it back into a synchronous call.
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(SPLASH_MIN_DISPLAY).await;
                open_settings_window(&handle, Some("account"));
            });
        }
    } else if first_up {
        fire_startup_notification(app);
    }

    // Failure used to be silent: the splash auto-dismissed on a blind timer
    // regardless of outcome, so a failed start left the user with a vanished
    // splash and a greyed tray icon — no idea what happened or what to do.
    // Now we surface the captured reason on the splash (held open by its
    // state-aware dismiss loop) AND in an OS notification, both pointing at
    // the tray's recovery actions. The `changed` guard makes this one-shot.
    if next == SidecarState::Failed {
        let reason = app.state::<LastSidecarError>().get();
        let _ = app.emit_to(
            "splash",
            "splash:error",
            reason
                .clone()
                .unwrap_or_else(|| "The proxy could not start.".to_string()),
        );
        fire_failed_notification(app, reason.as_deref());
    }
}

/// One-shot notification when the sidecar fails to start. Includes the
/// captured failure reason when we have one. Mirrors the rejection/startup
/// notifications' best-effort caveats: if the user denied notification
/// permission it silently no-ops, but the tray icon + menu ("Retry startup",
/// "Show logs…") are always there as the durable surface.
fn fire_failed_notification(app: &AppHandle, reason: Option<&str>) {
    use tauri_plugin_notification::NotificationExt;
    let body = match reason {
        Some(r) if !r.is_empty() => format!(
            "{r} — click the menu-bar icon to retry startup or view the logs."
        ),
        _ => "The background proxy failed to start. Click the menu-bar icon \
              to retry startup or view the logs."
            .to_string(),
    };
    if let Err(err) = app
        .notification()
        .builder()
        .title("Maximal couldn't start")
        .body(body)
        .show()
    {
        eprintln!("[shell] failed-start notification error: {err}");
    }
}

/// The app's release version (e.g. `0.4.31`), read from `tauri.conf.json`'s
/// `version`. `.macos-builder/build.sh` stamps that field with the real tag
/// at release time; in dev it's the `0.0.0` placeholder. Callers surface it
/// in the splash and the Settings title and suppress the dev placeholder so a
/// bare `v0.0.0` never ships in UI chrome.
fn app_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Pre-boot splash window. Created the instant the app launches so the
/// user gets immediate, visible feedback. This is a menu-bar-only app
/// (no Dock icon, no window at launch), so without it, double-clicking
/// the .app just adds a tray icon that's easy to miss. Loaded from the
/// bundled, self-contained `splash.html` via the Tauri asset protocol —
/// it can't be sidecar-served like Settings/Dashboard because the
/// sidecar isn't up yet. Retired by `dismiss_splash`.
fn create_splash(app: &AppHandle) {
    if app.get_webview_window("splash").is_some() {
        return;
    }
    let result = WebviewWindowBuilder::new(
        app,
        "splash",
        WebviewUrl::App("splash.html".into()),
    )
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
fn dismiss_splash(app: &AppHandle) {
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

/// One-shot "we're up" notification so users who launched from Finder
/// know it's running and where to find it (menu bar, not Dock). Same
/// best-effort caveats as `fire_rejection_notification`: a permission
/// denial or a dev (`cargo run`) no-op must not matter.
fn fire_startup_notification(app: &AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(err) = app
        .notification()
        .builder()
        .title("Maximal is running")
        .body("Look for the Maximal icon in your menu bar ↑")
        .show()
    {
        eprintln!("[shell] startup notification failed: {err}");
    }
}

/// Nudge the user to sign in when the proxy is up but has no GitHub account.
/// Fires on *entry* into the unauthenticated state — first launch, or a
/// mid-session sign-out / token expiry (which otherwise only nudged the tray
/// icon to ATTENTION, easy to miss). Clicking the notification activates the
/// app; `RunEvent::Reopen` (macOS) then brings up Settings → account. The
/// menu-bar "Sign in to GitHub…" item is the always-available fallback.
fn fire_sign_in_notification(app: &AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(err) = app
        .notification()
        .builder()
        .title("Sign in to GitHub")
        .body(
            "Maximal needs your GitHub Copilot account before it can serve \
             requests. Click here — or the menu-bar icon — to open Settings \
             and sign in.",
        )
        .show()
    {
        eprintln!("[shell] sign-in notification failed: {err}");
    }
}

fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, SidecarState::Starting)?;
    let icon = icon_for(SidecarState::Starting, false)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("maximal — starting…")
        .icon(icon)
        .on_menu_event(handle_menu_event)
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

fn refresh_tray(app: &AppHandle, state: SidecarState) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let rejection = app.state::<LastRejection>().get();
    let menu = build_menu(app, state)?;
    tray.set_menu(Some(menu))?;
    tray.set_icon(Some(icon_for(state, rejection.is_some())?))?;
    tray.set_tooltip(Some(tooltip_for(state, rejection.as_ref())))?;
    Ok(())
}

/// Embedded Dock icon — the same PNG referenced from tauri.conf.json's
/// `bundle.icon` so the dev-mode Dock matches the packaged build.
/// Debug-only: release builds get the icon from the .app bundle's
/// Info.plist (CFBundleIconFile), which Tauri populates from `bundle.icon`.
#[cfg(all(target_os = "macos", debug_assertions))]
const DOCK_ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");

/// Set NSApplication.applicationIconImage from the embedded PNG. Called
/// once at setup; AppKit holds the reference for the lifetime of the
/// process. Debug-only on macOS — release builds rely on the bundle.
#[cfg(all(target_os = "macos", debug_assertions))]
fn set_dock_icon() {
    use objc2::AnyThread;
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::{MainThreadMarker, NSData};

    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("[shell] set_dock_icon: not on main thread, skipping");
        return;
    };

    // NSData::with_bytes copies the slice, so the &'static borrow from
    // include_bytes! is fine. NSImage::initWithData returns None if the
    // data can't be decoded; we silently skip in that case.
    let data = NSData::with_bytes(DOCK_ICON_PNG);
    let alloc = NSImage::alloc();
    let Some(image) = NSImage::initWithData(alloc, &data) else {
        eprintln!("[shell] set_dock_icon: NSImage decode failed");
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    unsafe {
        app.setApplicationIconImage(Some(&image));
    }
}

fn icon_for(
    state: SidecarState,
    has_rejection: bool,
) -> tauri::Result<Image<'static>> {
    // A pending upstream rejection while authenticated promotes the
    // icon to ATTENTION so the user notices without opening Settings.
    // Other states already drive the icon themselves (Starting,
    // RunningUnauthenticated also use ATTENTION, etc.); the rejection
    // override only changes the RunningAuthenticated case.
    let bytes = match state {
        SidecarState::Starting => TRAY_ICON_STARTING,
        SidecarState::RunningUnauthenticated => TRAY_ICON_ATTENTION,
        SidecarState::RunningAuthenticated => {
            if has_rejection {
                TRAY_ICON_ATTENTION
            } else {
                TRAY_ICON_NORMAL
            }
        }
        // Failed/Stopped reuse the "starting" dimmed look; the menu
        // text makes the actual problem clear.
        SidecarState::Failed | SidecarState::Stopped => TRAY_ICON_STARTING,
    };
    Ok(Image::from_bytes(bytes)?.to_owned())
}

fn tooltip_for(
    state: SidecarState,
    rejection: Option<&RejectionSnapshot>,
) -> String {
    // Rejection wins over the bare "maximal" idle tooltip when the
    // user is authenticated — the tray badge is meaningless without
    // a hint as to why. Other states keep their own tooltip; the
    // rejection sidecar isn't actionable while signed out anyway.
    if matches!(state, SidecarState::RunningAuthenticated) {
        if let Some(r) = rejection {
            return format!("maximal — {}", r.message);
        }
    }
    match state {
        SidecarState::Starting => "maximal — starting…".to_owned(),
        SidecarState::RunningUnauthenticated => {
            "maximal — sign in to GitHub".to_owned()
        }
        SidecarState::RunningAuthenticated => "maximal".to_owned(),
        SidecarState::Failed => "maximal — sidecar failed".to_owned(),
        SidecarState::Stopped => "maximal — stopped".to_owned(),
    }
}

fn build_menu(app: &AppHandle, state: SidecarState) -> tauri::Result<Menu<tauri::Wry>> {
    let settings_item = MenuItem::with_id(
        app,
        menu_id::SETTINGS,
        "Settings…",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let dashboard_item = MenuItem::with_id(
        app,
        menu_id::DASHBOARD,
        "Dashboard…",
        true,
        Some("CmdOrCtrl+D"),
    )?;
    let quit_item = MenuItem::with_id(
        app,
        menu_id::QUIT,
        "Quit Maximal",
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;

    // An "Upgrade to v…" item leads the menu in the running states whenever the
    // poll loop has seen a newer release. Built here (before the match) so both
    // running arms can prepend it; the other arms simply don't reference it.
    // Clicking it opens the install-channel-neutral download page.
    let update = app.state::<LatestUpdate>().get();
    let upgrade_item = match &update {
        Some(u) => Some(MenuItem::with_id(
            app,
            menu_id::UPGRADE,
            format!("Upgrade to v{}…", u.latest),
            true,
            None::<&str>,
        )?),
        None => None,
    };
    let sep_upgrade = PredefinedMenuItem::separator(app)?;

    match state {
        SidecarState::Starting => {
            let starting = MenuItem::with_id(
                app,
                menu_id::STARTING,
                "Starting…",
                false,
                None::<&str>,
            )?;
            Menu::with_items(app, &[&starting, &sep1, &settings_item, &quit_item])
        }
        SidecarState::RunningUnauthenticated => {
            let sign_in = MenuItem::with_id(
                app,
                menu_id::SIGN_IN,
                "Sign in to GitHub…",
                true,
                None::<&str>,
            )?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let mut items: Vec<&dyn IsMenuItem<tauri::Wry>> = Vec::new();
            items.push(&sign_in);
            // Update is its own section BELOW the primary action, shown only
            // when an update is available — never above sign-in.
            if let Some(up) = &upgrade_item {
                items.push(&sep_upgrade);
                items.push(up);
            }
            items.push(&sep1);
            items.push(&dashboard_item);
            items.push(&settings_item);
            items.push(&sep2);
            items.push(&quit_item);
            Menu::with_items(app, &items)
        }
        SidecarState::RunningAuthenticated => {
            // We don't fetch the GitHub login (would require a network
            // call to api.github.com from Rust, or expanding the
            // sidecar's response shape). Showing the generic "Signed
            // in to GitHub" is honest and avoids that complexity.
            let info = MenuItem::with_id(
                app,
                menu_id::ACCOUNT_INFO,
                "Signed in to GitHub",
                false,
                None::<&str>,
            )?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let mut items: Vec<&dyn IsMenuItem<tauri::Wry>> = Vec::new();
            items.push(&info);
            // Update is its own section BELOW the account line, shown only when
            // an update is available — never above it.
            if let Some(up) = &upgrade_item {
                items.push(&sep_upgrade);
                items.push(up);
            }
            items.push(&sep1);
            items.push(&dashboard_item);
            items.push(&settings_item);
            items.push(&sep2);
            items.push(&quit_item);
            Menu::with_items(app, &items)
        }
        SidecarState::Failed | SidecarState::Stopped => {
            let failed = MenuItem::with_id(
                app,
                menu_id::FAILED,
                "Sidecar failed to start",
                false,
                None::<&str>,
            )?;
            let retry = MenuItem::with_id(
                app,
                menu_id::RETRY,
                "Retry startup",
                true,
                None::<&str>,
            )?;
            let show_logs = MenuItem::with_id(
                app,
                menu_id::SHOW_LOGS,
                "Show logs…",
                true,
                None::<&str>,
            )?;
            let open_config = MenuItem::with_id(
                app,
                menu_id::OPEN_CONFIG,
                "Open config folder…",
                true,
                None::<&str>,
            )?;
            Menu::with_items(
                app,
                &[
                    &failed,
                    &retry,
                    &show_logs,
                    &open_config,
                    &sep1,
                    &settings_item,
                    &quit_item,
                ],
            )
        }
    }
}

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        menu_id::SETTINGS => open_settings_window(app, None),
        menu_id::DASHBOARD => open_dashboard_window(app),
        menu_id::SIGN_IN => open_settings_window(app, Some("account")),
        menu_id::SHOW_LOGS => do_reveal_logs_dir(app),
        menu_id::OPEN_CONFIG => do_reveal_config_dir(app),
        menu_id::RETRY => retry_startup(app),
        menu_id::UPGRADE => open_update_url(app),
        menu_id::QUIT => request_quit(app),
        _ => {}
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

/// Re-run the startup sequence from the Failed/Stopped state: clear any
/// lingering sidecar, flip back to Starting, respawn, and restart polling.
/// This is the recovery path for a transient startup failure (slow first
/// boot, a port held by something that has since let go, a one-off crash) —
/// without it, the only way out of Failed was to quit and relaunch the whole
/// app, a dead-end for a menu-bar utility the user expects to "just run."
///
/// Only acts from Failed/Stopped so a stray click while healthy can't tear
/// down a working sidecar. Reuses kill_sidecar's SIGTERM→SIGKILL path to
/// reap any half-dead child before respawning so we don't leak a process or
/// collide on :4141.
fn retry_startup(app: &AppHandle) {
    let current = app.state::<AppStatus>().get();
    if !matches!(current, SidecarState::Failed | SidecarState::Stopped) {
        return;
    }
    eprintln!("[shell] retry startup requested");
    respawn_sidecar(app);
}

/// Tear down the running sidecar and boot a fresh one. The reap→respawn→poll
/// core shared by the tray-driven `retry_startup` (recovery from Failed) and
/// the `restart_sidecar` command (a deliberate reboot for account switch /
/// sign-out — we reconstruct from the on-disk config rather than mutating the
/// running instance, so no in-process auth state can leak across the change).
/// Callers gate WHEN this is allowed; this function always reboots.
fn respawn_sidecar(app: &AppHandle) {
    // Clear the previous failure reason so a stale message can't haunt this
    // attempt (it would otherwise reappear on the splash/notification if the
    // respawn also fails before printing its own error). Dismiss any lingering
    // error splash — the tray's Starting state is the affordance now; we don't
    // re-raise an always-on-top splash.
    app.state::<LastSidecarError>().set(None);
    dismiss_splash(app);

    // Mark this as an intentional restart BEFORE we SIGTERM the child, so the
    // old sidecar's clean exit isn't mistaken for a user quit (which would
    // bring the whole app down — see the Terminated handler in spawn_sidecar).
    app.state::<SidecarRestarting>().begin();

    // Reap the current child (healthy, hung, or mid-crash) so the respawn binds
    // cleanly. No-op if already gone. spawn_sidecar also passes --replace as a
    // backstop against a not-yet-released port.
    kill_sidecar(app);

    apply_state(app, SidecarState::Starting);

    if let Err(err) = spawn_sidecar(app) {
        eprintln!("[shell] sidecar respawn failed: {err}");
        apply_state(app, SidecarState::Failed);
        return;
    }

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        poll_sidecar_status(handle).await;
    });
}

/// Opens (or focuses) the dashboard webview pointed at the sidecar's
/// settings page. The optional `section` becomes a URL fragment so the
/// frontend can scroll to / select that section.
fn open_settings_window(app: &AppHandle, section: Option<&str>) {
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
    let version = app_version(app);
    let title = if version == "0.0.0" {
        "Maximal — Settings".to_string()
    } else {
        format!("Maximal — Settings · v{version}")
    };
    let builder = WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW_LABEL,
        WebviewUrl::External(url),
    )
    .title(title)
    .inner_size(900.0, 760.0)
    .min_inner_size(600.0, 560.0);

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

fn do_reveal_config_dir(app: &AppHandle) {
    let Ok(home) = app.path().home_dir() else {
        return;
    };
    let dir = home.join(".local").join("share").join("maximal");
    let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
}

fn do_reveal_logs_dir(app: &AppHandle) {
    let Ok(home) = app.path().home_dir() else {
        return;
    };
    let dir = home
        .join(".local")
        .join("share")
        .join("maximal")
        .join("logs");
    // Sidecar creates this lazily on first request log. Create it
    // here so the menu item always lands somewhere, even on first
    // boot before any request has been served.
    if let Err(err) = std::fs::create_dir_all(&dir) {
        eprintln!("[shell] could not create logs dir {dir:?}: {err}");
    }
    let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
}

/// Opens (or focuses) the usage dashboard webview pointed at the
/// sidecar's `/ui/dashboard/` endpoint. The dashboard (and settings) are
/// embedded in the sidecar binary and served at /ui/* (see
/// src/routes/ui/route.ts), so they ship inside the bundle with no extra
/// resource staging.
fn open_dashboard_window(app: &AppHandle) {
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

    let builder = WebviewWindowBuilder::new(
        app,
        DASHBOARD_WINDOW_LABEL,
        WebviewUrl::External(url),
    )
    .title("Maximal — Dashboard")
    .inner_size(1100.0, 760.0)
    .min_inner_size(720.0, 520.0);

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
static POLICY_IS_REGULAR: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "macos")]
fn update_activation_policy(app: &AppHandle) {
    use std::sync::atomic::Ordering;

    let labels = [SETTINGS_WINDOW_LABEL, DASHBOARD_WINDOW_LABEL];
    let want_regular = labels.iter().any(|label| {
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
        set_dock_icon();
    }
}

#[cfg(not(target_os = "macos"))]
fn update_activation_policy(_app: &AppHandle) {}

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
fn present_window(app: &AppHandle, window: &tauri::WebviewWindow) {
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
fn request_quit(app: &AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let app_clone = app.clone();
    app.dialog()
        .message("Maximal will stop and any open Settings windows will close.")
        .title("Quit Maximal?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit Maximal".into(),
            "Cancel".into(),
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
fn graceful_shutdown(app: &AppHandle) {
    app.exit(0);
}

/// Focus an existing main window, or open Settings if none exists.
///
/// Called from the single-instance plugin callback when the user
/// re-launches Maximal without `--replace` — the natural "they double-
/// clicked the dock icon" case. Settings is the default surface;
/// Dashboard is the fallback if Settings isn't built yet but
/// Dashboard is. If neither exists we open Settings fresh, which
/// also runs `update_activation_policy` to bring the Dock icon back.
fn focus_or_open_main_window(app: &AppHandle) {
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

/// Tauri command exposed to the frontend.
///
/// Lets the dashboard JS request a deep-link to a specific Settings
/// section (`account`, `proxy`, etc.). Same behavior as the tray's
/// "Sign in to GitHub…" item.
#[tauri::command]
fn open_settings_at(app: AppHandle, section: String) {
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
fn open_dashboard(app: AppHandle) {
    open_dashboard_window(&app);
}

/// Tauri command — reveal the maximal config directory in Finder/Explorer.
/// Wired to the "Reveal config" button in the Settings footer.
#[tauri::command]
fn reveal_config_dir(app: AppHandle) {
    do_reveal_config_dir(&app);
}

/// Tauri command — reveal the maximal logs directory in Finder/Explorer.
/// Wired to the "Open logs" buttons in the Settings UI.
#[tauri::command]
fn reveal_logs_dir(app: AppHandle) {
    do_reveal_logs_dir(&app);
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
fn restart_sidecar(app: AppHandle) {
    eprintln!("[shell] sidecar restart requested");
    respawn_sidecar(&app);
}

/// Tauri command — run the in-app uninstall. Spawns the bundled sidecar with
/// `maximal uninstall --unattended --keep-app` (plus `--revert-claude` /
/// `--purge` per the booleans the Settings webview passes) and awaits the
/// result. `--keep-app` is mandatory here: the running `.app` can't delete the
/// bundle it's executing from, so the CLI removes the launchd agent, the
/// `~/.local/bin/maximal` PATH symlink, and the other PATH binaries, then the
/// user drags Maximal to the Trash to finish. Returns `Err(String)` (a
/// human-readable reason) on a missing binary or non-zero exit so the webview
/// can surface a non-blocking inline error instead of silently stranding the
/// user. Mirrors the spawn+`.output()` shape of `reconcile_claude_code_revert`.
#[tauri::command]
async fn uninstall_maximal(
    app: AppHandle,
    revert_claude: bool,
    purge: bool,
) -> Result<(), String> {
    eprintln!("[shell] in-app uninstall requested (revert_claude={revert_claude}, purge={purge})");
    let mut args: Vec<String> = vec![
        "uninstall".to_string(),
        "--unattended".to_string(),
        "--keep-app".to_string(),
    ];
    if revert_claude {
        args.push("--revert-claude".to_string());
    }
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


#[cfg(test)]
mod tests {
    use super::extract_error_reason;

    #[test]
    fn extracts_consola_fancy_error() {
        // consola's fancy reporter (the form the sidecar prints under Tauri).
        let chunk = " ERROR  Could not free :4141 (last known pid 55355). \
                     Stop the holding process manually and retry.";
        let reason = extract_error_reason(chunk).expect("should extract");
        assert!(reason.starts_with("Could not free :4141"));
        assert!(!reason.contains("ERROR"));
    }

    #[test]
    fn extracts_consola_basic_error() {
        let chunk = "[error] Port 4141 is already in use by another process.";
        let reason = extract_error_reason(chunk).expect("should extract");
        assert_eq!(reason, "Port 4141 is already in use by another process.");
    }

    #[test]
    fn picks_the_error_line_out_of_a_multiline_chunk() {
        let chunk = "ℹ Starting maximal…\n\
                     ℹ Source revision: abc1234\n\
                     ERROR: bootstrap failed\n";
        let reason = extract_error_reason(chunk).expect("should extract");
        assert_eq!(reason, "bootstrap failed");
    }

    #[test]
    fn ignores_non_error_output() {
        assert_eq!(extract_error_reason("ℹ Web-tools executor: Ollama"), None);
        assert_eq!(extract_error_reason(""), None);
    }

    #[test]
    fn caps_runaway_length() {
        let long = format!("ERROR {}", "x".repeat(500));
        let reason = extract_error_reason(&long).expect("should extract");
        assert!(reason.chars().count() <= 180);
    }
}
