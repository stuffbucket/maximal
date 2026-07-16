use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri_plugin_shell::process::CommandChild;

/// Allowed values for the dashboard's `period` query parameter.
/// Anything else from the webview is clamped to "day".
const DASHBOARD_PERIODS: &[&str] = &["day", "week", "month"];

/// High-level tray state. Each transition rebuilds the menu and swaps
/// the tray icon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SidecarState {
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
pub(crate) struct Sidecar(Mutex<Option<CommandChild>>);

impl Sidecar {
    pub(crate) fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub(crate) fn set(&self, child: CommandChild) {
        *self.0.lock().expect("sidecar mutex poisoned") = Some(child);
    }

    pub(crate) fn take(&self) -> Option<CommandChild> {
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
pub(crate) struct RejectionSnapshot {
    pub(crate) message: String,
    pub(crate) status: u16,
    pub(crate) at: String,
    pub(crate) remediation_url: Option<String>,
}

/// Tracks the most recent rejection snapshot the rejection poller has
/// observed. None = no recent non-fatal rejection (healthy). Wrapped
/// in Mutex because both the polling task and tray-refresh path read it.
pub(crate) struct LastRejection(Mutex<Option<RejectionSnapshot>>);

impl LastRejection {
    pub(crate) fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub(crate) fn get(&self) -> Option<RejectionSnapshot> {
        self.0.lock().expect("rejection mutex poisoned").clone()
    }

    /// Returns true if the state transitioned from None → Some. Callers
    /// use that signal to fire the one-shot OS notification.
    pub(crate) fn set(&self, next: Option<RejectionSnapshot>) -> RejectionTransition {
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
pub(crate) enum RejectionTransition {
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
pub(crate) struct UpdateSnapshot {
    /// Latest version, no leading "v".
    pub(crate) latest: String,
    /// Install-channel-neutral download page.
    pub(crate) url: String,
}

/// Tracks the most recent update snapshot the poll loop has observed. Wrapped
/// in Mutex because the polling task and the tray paths both touch it.
pub(crate) struct LatestUpdate(Mutex<Option<UpdateSnapshot>>);

impl LatestUpdate {
    pub(crate) fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub(crate) fn get(&self) -> Option<UpdateSnapshot> {
        self.0.lock().expect("update mutex poisoned").clone()
    }

    /// Stores the snapshot; returns true if it changed (a newly available
    /// version, a changed target, or clearing back to up-to-date). Callers
    /// fire the one-shot notification only when the new value is Some, so a
    /// repeated periodic check that finds the same version doesn't re-nag.
    pub(crate) fn set(&self, next: Option<UpdateSnapshot>) -> bool {
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
pub(crate) struct LastSidecarError(Mutex<Option<String>>);

impl LastSidecarError {
    pub(crate) fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub(crate) fn set(&self, reason: Option<String>) {
        *self.0.lock().expect("sidecar-error mutex poisoned") = reason;
    }

    pub(crate) fn get(&self) -> Option<String> {
        self.0.lock().expect("sidecar-error mutex poisoned").clone()
    }
}

/// Tracks the current SidecarState behind a Mutex so the polling task
/// (Tokio) and the menu-event callback (main thread) can both touch it.
pub(crate) struct AppStatus(Mutex<SidecarState>);

impl AppStatus {
    pub(crate) fn new() -> Self {
        Self(Mutex::new(SidecarState::Starting))
    }

    pub(crate) fn get(&self) -> SidecarState {
        *self.0.lock().expect("status mutex poisoned")
    }

    /// Returns Some(previous) if the state changed, None otherwise.
    pub(crate) fn set(&self, next: SidecarState) -> Option<SidecarState> {
        let mut guard = self.0.lock().expect("status mutex poisoned");
        if *guard == next {
            return None;
        }
        let prev = *guard;
        *guard = next;
        Some(prev)
    }
}

/// The active native-UI locale (BCP-47 tag), behind a Mutex because the
/// `set_locale` command (main thread) and the tray / notification paths
/// (Tokio tasks) both read it. Seeded at setup from the persisted picker
/// choice or the OS locale (see `native_i18n::resolve_locale`); updated live
/// by `set_locale` when the user changes the in-app picker so the tray menu,
/// window titles, and later notifications follow the chosen language.
pub(crate) struct LocaleState(Mutex<String>);

impl LocaleState {
    pub(crate) fn new() -> Self {
        Self(Mutex::new("en".to_string()))
    }

    pub(crate) fn get(&self) -> String {
        self.0.lock().expect("locale mutex poisoned").clone()
    }

    pub(crate) fn set(&self, tag: String) {
        *self.0.lock().expect("locale mutex poisoned") = tag;
    }
}

/// One-shot flag for "we've already auto-opened Settings to prompt
/// sign-in this session." Lets us open Settings → Account on the
/// first Starting → RunningUnauthenticated transition without
/// re-opening it every time the user manually quits + signs back in
/// while still unauthenticated.
pub(crate) struct SetupPromptShown(std::sync::atomic::AtomicBool);

impl SetupPromptShown {
    pub(crate) fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }

    /// Returns true the first time it's called; false on subsequent calls.
    pub(crate) fn claim(&self) -> bool {
        !self.0.swap(true, std::sync::atomic::Ordering::SeqCst)
    }
}

/// One-shot flag for "we've already dismissed the splash + fired the
/// 'we're running' notification this session." The first Starting →
/// Running transition claims it; later Unauthenticated ⇄ Authenticated
/// flips must not re-announce.
pub(crate) struct StartupAnnounced(std::sync::atomic::AtomicBool);

impl StartupAnnounced {
    pub(crate) fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }

    /// Returns true the first time it's called; false on subsequent calls.
    pub(crate) fn claim(&self) -> bool {
        !self.0.swap(true, std::sync::atomic::Ordering::SeqCst)
    }
}

/// One-shot guard so the splash is dismissed at most once and never
/// recreated — once it's gone it stays gone for the life of the process.
pub(crate) struct SplashDismissed(std::sync::atomic::AtomicBool);

impl SplashDismissed {
    pub(crate) fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }

    /// Returns true the first time it's called; false on subsequent calls.
    pub(crate) fn claim(&self) -> bool {
        !self.0.swap(true, std::sync::atomic::Ordering::SeqCst)
    }
}

/// Set while `respawn_sidecar` is intentionally cycling the sidecar (the
/// account-switch / sign-in / sign-out reboot). The old sidecar exits cleanly
/// from our SIGTERM, which the Terminated handler would otherwise read as a
/// user-initiated quit and bring the WHOLE app down — stranding the tray and
/// killing the reboot before the replacement spawns. The handler consumes this
/// flag and keeps the app alive for the respawn instead.
pub(crate) struct SidecarRestarting(std::sync::atomic::AtomicBool);

impl SidecarRestarting {
    pub(crate) fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }

    /// Mark that the next sidecar exit is an intentional restart, not a quit.
    pub(crate) fn begin(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Returns true (and clears the flag) if a restart was in progress.
    pub(crate) fn consume(&self) -> bool {
        self.0.swap(false, std::sync::atomic::Ordering::SeqCst)
    }
}

/// Runtime mirror of the persisted `config.ui.menuBarOnly` preference.
/// `true` = live only in the macOS menu bar / Windows tray (the classic
/// no-Dock/no-taskbar feel). `false` (the DEFAULT) = ALSO appear in the
/// Dock (macOS) / taskbar (Windows). Seeded from `read_menu_bar_only` in
/// `setup()`, flipped live by the `set_menu_bar_only` command, and read by
/// `update_activation_policy` (macOS) + the window builders (Windows).
pub(crate) struct MenuBarOnly(std::sync::atomic::AtomicBool);

impl MenuBarOnly {
    /// Starts at the default (`false` — show in Dock/taskbar); `setup()`
    /// overwrites it with the on-disk value once an AppHandle exists.
    pub(crate) fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }

    pub(crate) fn get(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub(crate) fn set(&self, value: bool) {
        self.0.store(value, std::sync::atomic::Ordering::SeqCst);
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
pub(crate) struct ShellApiKey(String);

impl ShellApiKey {
    pub(crate) fn new() -> Self {
        Self(generate_shell_api_key())
    }

    pub(crate) fn value(&self) -> &str {
        &self.0
    }
}

/// 16 cryptographically-random bytes, hex-encoded, with a recognisable
/// prefix so it's greppable in logs / config diffs. Total length 41
/// chars — comfortably inside the sidecar's API_KEY_VALUE_PATTERN range
/// (8–128 chars of [A-Za-z0-9_-]).
///
/// Sourced via `getrandom`, which pulls bytes from the OS CSPRNG on every
/// target (`/dev/urandom` / `getrandom(2)` on Unix, `BCryptGenRandom` on
/// Windows). The previous implementation opened `/dev/urandom` directly,
/// which does not exist on Windows and would panic the shell at startup —
/// the single hardest Windows-parity blocker in this file.
fn generate_shell_api_key() -> String {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).expect("could not read OS CSPRNG for shell api key");
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
pub(crate) enum TokenUsageEvent {
    Update { payload: serde_json::Value },
    Error { message: String },
}

/// Sanitize the period string from the JS side, defaulting to "day"
/// for anything unrecognized. Returns `&'static str` so the URL
/// builder doesn't re-allocate per poll.
pub(crate) fn canonical_period(requested: &str) -> &'static str {
    DASHBOARD_PERIODS
        .iter()
        .copied()
        .find(|p| *p == requested)
        .unwrap_or("day")
}

#[derive(Debug, Deserialize)]
pub(crate) struct SetupCheckResult {
    pub(crate) ok: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SetupChecks {
    #[serde(rename = "githubAuth")]
    pub(crate) github_auth: SetupCheckResult,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SetupStatusResponse {
    pub(crate) checks: SetupChecks,
}
