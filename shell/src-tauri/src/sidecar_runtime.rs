//! Sidecar-facing runtime for the Tauri shell.
//!
//! This module owns profile and endpoint policy, sidecar process generations,
//! readiness/protocol handling, sidecar-managed state, and presentation-neutral
//! HTTP transport. Native tray, window, splash, notification, and updater
//! presentation remains composed by `lib.rs`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{CapabilityBuilder, Channel},
    AppHandle, Manager, State,
};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const PRODUCTION_IDENTIFIER: &str = "co.stuffbucket.maximal";
const PRODUCTION_PORT: u16 = 4141;
pub(super) const LOOPBACK_HOST: &str = "127.0.0.1";
const READY_MARKER: &str = "@@MAXIMAL_READY@@";
/// Prefix relayed to the splash by the parent presentation coordinator.
/// MUST match `BOOT_STATUS_MARKER` in `src/start.ts`.
const BOOT_STATUS_MARKER: &str = "@@MAXIMAL_STATUS@@";
const SIDECAR_READY_TIMEOUT: Duration = Duration::from_secs(30);
const SIDECAR_STOP_TIMEOUT: Duration = Duration::from_secs(10);
const DASHBOARD_RETRY_INTERVAL: Duration = Duration::from_secs(5);
const DASHBOARD_PERIODS: &[&str] = &["day", "week", "month"];
const MAX_STDOUT_LINE_BYTES: usize = 64 * 1024;
const PREFERRED_PORT_FILE: &str = "sidecar-port";
pub(super) const UPDATE_PAGE_URL: &str = "https://mxml.sh/";
pub(super) const SETTINGS_WINDOW_LABEL: &str = "settings";
pub(super) const DASHBOARD_WINDOW_LABEL: &str = "dashboard";

#[derive(Debug)]
pub(super) enum RuntimeEvent {
    State(SidecarState),
    Ready(SidecarEndpoint),
    BootStatus(String),
    Exit(i32),
}

pub(super) struct RuntimeEvents(tokio::sync::mpsc::UnboundedSender<RuntimeEvent>);

pub(super) fn runtime_event_channel() -> (
    RuntimeEvents,
    tokio::sync::mpsc::UnboundedReceiver<RuntimeEvent>,
) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    (RuntimeEvents(tx), rx)
}

fn send_event(app: &AppHandle, event: RuntimeEvent) {
    if app.state::<RuntimeEvents>().0.send(event).is_err() {
        eprintln!("[shell] runtime event coordinator stopped");
    }
}

/// Runtime behavior is derived from the final Tauri identifier, including any
/// `tauri dev --config` override. Only the exact release identifier is allowed
/// to use production data or register updater surfaces; unknown identifiers
/// fail closed into a development profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AppProfile {
    Production,
    Development,
    Test,
}

impl AppProfile {
    pub(super) fn from_identifier(identifier: &str) -> Self {
        if identifier == PRODUCTION_IDENTIFIER {
            Self::Production
        } else if identifier == format!("{PRODUCTION_IDENTIFIER}.test")
            || identifier.starts_with(&format!("{PRODUCTION_IDENTIFIER}.test."))
        {
            Self::Test
        } else {
            Self::Development
        }
    }

    fn as_env(self) -> &'static str {
        match self {
            Self::Production => "production",
            Self::Development => "development",
            Self::Test => "test",
        }
    }

    fn initial_port(self) -> u16 {
        match self {
            Self::Production => PRODUCTION_PORT,
            Self::Development | Self::Test => 0,
        }
    }

    pub(super) fn updates_enabled(self) -> bool {
        self == Self::Production
    }
}

pub(super) struct AppDataDir(pub(super) PathBuf);

pub(super) struct RuntimeExiting(std::sync::atomic::AtomicBool);

impl RuntimeExiting {
    pub(super) fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }

    fn begin(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn get(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

pub(super) fn begin_exit(app: &AppHandle) {
    app.state::<RuntimeExiting>().begin();
}

fn preferred_port_file(data_dir: &Path) -> PathBuf {
    data_dir.join(PREFERRED_PORT_FILE)
}

pub(super) fn read_preferred_port(data_dir: &Path) -> Option<u16> {
    let raw = std::fs::read_to_string(preferred_port_file(data_dir)).ok()?;
    raw.trim().parse::<u16>().ok().filter(|port| *port > 0)
}

fn write_preferred_port(data_dir: &Path, port: u16) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    std::fs::write(preferred_port_file(data_dir), format!("{port}\n"))
}

fn absolute_env_path(value: std::ffi::OsString) -> tauri::Result<PathBuf> {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn production_data_dir() -> tauri::Result<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if let Some(app_data) = std::env::var_os("APPDATA") {
            return Ok(PathBuf::from(app_data).join("maximal"));
        }
        let home = std::env::var_os("USERPROFILE").ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "USERPROFILE is unavailable")
        })?;
        Ok(PathBuf::from(home)
            .join("AppData")
            .join("Roaming")
            .join("maximal"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var_os("HOME").ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "HOME is unavailable")
        })?;
        Ok(PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("maximal"))
    }
}

pub(super) fn profile_data_override(profile: AppProfile) -> tauri::Result<Option<PathBuf>> {
    if let Some(home) = std::env::var_os("COPILOT_API_HOME").filter(|value| !value.is_empty()) {
        return absolute_env_path(home).map(Some);
    }
    match profile {
        AppProfile::Production => production_data_dir().map(Some),
        AppProfile::Development | AppProfile::Test => Ok(None),
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SidecarState {
    Starting,
    RunningUnauthenticated,
    RunningAuthenticated,
    #[allow(dead_code)]
    Stopped,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct SidecarEndpoint {
    generation: u64,
    port: u16,
}

impl SidecarEndpoint {
    pub(super) fn http_url(self, path: &str) -> String {
        format!("http://{LOOPBACK_HOST}:{}{path}", self.port)
    }

    pub(super) fn browser_origin(self) -> String {
        // Preserve the production origin used by every prior release. Besides
        // retaining localStorage, macOS's bundle exception is for localhost.
        format!("http://localhost:{}", self.port)
    }
}

#[derive(Debug)]
struct EndpointState {
    generation: u64,
    selected_port: Option<u16>,
    current: Option<SidecarEndpoint>,
    capability_ports: HashSet<u16>,
}

/// Generation-aware endpoint selected by the sidecar's authenticated ready
/// line. `selected_port` survives a sidecar restart because Tauri capabilities
/// can be added but not removed; every generation after the first therefore
/// asks for the same port.
pub(super) struct ManagedEndpoint(Mutex<EndpointState>);

impl ManagedEndpoint {
    pub(super) fn new() -> Self {
        Self(Mutex::new(EndpointState {
            generation: 0,
            selected_port: None,
            current: None,
            capability_ports: HashSet::new(),
        }))
    }

    pub(super) fn set_preferred_port(&self, port: Option<u16>) {
        let mut state = self.0.lock().expect("endpoint mutex poisoned");
        if state.generation == 0 {
            state.selected_port = port;
        }
    }

    fn begin_generation(&self, profile: AppProfile) -> SpawnGeneration {
        let mut state = self.0.lock().expect("endpoint mutex poisoned");
        state.generation = state.generation.wrapping_add(1);
        state.current = None;
        SpawnGeneration {
            generation: state.generation,
            requested_port: state
                .selected_port
                .unwrap_or_else(|| profile.initial_port()),
            nonce: generate_nonce(),
        }
    }

    pub(super) fn current(&self) -> Option<SidecarEndpoint> {
        self.0.lock().expect("endpoint mutex poisoned").current
    }

    fn is_pending(&self, generation: u64) -> bool {
        let state = self.0.lock().expect("endpoint mutex poisoned");
        state.generation == generation && state.current.is_none()
    }

    fn expire_pending(&self, generation: u64) -> bool {
        let mut state = self.0.lock().expect("endpoint mutex poisoned");
        if state.generation != generation || state.current.is_some() {
            return false;
        }
        state.generation = state.generation.wrapping_add(1);
        true
    }

    fn clear_generation(&self, generation: u64) {
        let mut state = self.0.lock().expect("endpoint mutex poisoned");
        if state.generation == generation {
            state.current = None;
        }
    }

    /// Forget a persisted preferred port after its first launch failed. This is
    /// allowed only before any remote capability exists; after that, changing
    /// ports would leave a capability behind that Tauri cannot revoke.
    fn prepare_dynamic_retry(&self, generation: u64, requested_port: u16) -> bool {
        let mut state = self.0.lock().expect("endpoint mutex poisoned");
        if state.generation != generation
            || state.current.is_some()
            || requested_port == 0
            || !state.capability_ports.is_empty()
            || state.selected_port != Some(requested_port)
        {
            return false;
        }
        state.selected_port = None;
        true
    }

    fn has_capability(&self, port: u16) -> bool {
        self.0
            .lock()
            .expect("endpoint mutex poisoned")
            .capability_ports
            .contains(&port)
    }

    fn mark_capability(&self, port: u16) {
        self.0
            .lock()
            .expect("endpoint mutex poisoned")
            .capability_ports
            .insert(port);
    }

    fn activate(&self, generation: u64, port: u16) -> bool {
        let mut state = self.0.lock().expect("endpoint mutex poisoned");
        if state.generation != generation || state.current.is_some() {
            return false;
        }
        state.selected_port = Some(port);
        state.current = Some(SidecarEndpoint { generation, port });
        true
    }
}

#[derive(Clone, Debug)]
struct SpawnGeneration {
    generation: u64,
    requested_port: u16,
    nonce: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct SidecarReady {
    protocol: u8,
    host: String,
    port: u16,
    #[serde(rename = "instanceId")]
    instance_id: String,
    nonce: String,
}

fn validate_ready(
    ready: &SidecarReady,
    spawn: &SpawnGeneration,
    identifier: &str,
) -> Result<(), String> {
    if ready.protocol != 1 {
        return Err(format!("unsupported ready protocol {}", ready.protocol));
    }
    if ready.nonce != spawn.nonce {
        return Err("ready nonce did not match this sidecar generation".to_string());
    }
    if ready.instance_id != identifier {
        return Err("ready identifier did not match this Tauri instance".to_string());
    }
    if ready.host != LOOPBACK_HOST {
        return Err(format!("ready host must be {LOOPBACK_HOST}"));
    }
    if ready.port == 0 {
        return Err("ready port must be non-zero".to_string());
    }
    if spawn.requested_port != 0 && ready.port != spawn.requested_port {
        return Err(format!(
            "ready port {} did not match requested port {}",
            ready.port, spawn.requested_port
        ));
    }
    Ok(())
}

#[derive(Default)]
struct StdoutLines {
    pending: Vec<u8>,
}

impl StdoutLines {
    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(newline) = self.pending.iter().position(|byte| *byte == b'\n') {
            let mut raw = self.pending.drain(..=newline).collect::<Vec<_>>();
            raw.pop();
            if raw.last() == Some(&b'\r') {
                raw.pop();
            }
            lines.push(String::from_utf8_lossy(&raw).into_owned());
        }
        if self.pending.len() > MAX_STDOUT_LINE_BYTES {
            let raw = std::mem::take(&mut self.pending);
            lines.push(String::from_utf8_lossy(&raw).into_owned());
        }
        lines
    }
}

/// Owns the sidecar's CommandChild for the lifetime of the app.
///
/// Wrapped in `Mutex<Option<...>>` because Tauri's managed-state
/// API requires `Send + Sync`, and the child handle is consumed
/// (option becomes None) once `kill()` is issued so subsequent
/// kill calls become harmless no-ops.
struct RunningSidecar {
    generation: u64,
    child: CommandChild,
}

pub(super) struct Sidecar(Mutex<Option<RunningSidecar>>);

impl Sidecar {
    pub(super) fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn set(&self, generation: u64, child: CommandChild) {
        *self.0.lock().expect("sidecar mutex poisoned") =
            Some(RunningSidecar { generation, child });
    }

    fn generation(&self) -> Option<u64> {
        self.0
            .lock()
            .expect("sidecar mutex poisoned")
            .as_ref()
            .map(|sidecar| sidecar.generation)
    }

    fn clear_generation(&self, generation: u64) {
        let mut current = self.0.lock().expect("sidecar mutex poisoned");
        if current
            .as_ref()
            .is_some_and(|sidecar| sidecar.generation == generation)
        {
            current.take();
        }
    }

    fn take(&self) -> Option<CommandChild> {
        self.0
            .lock()
            .expect("sidecar mutex poisoned")
            .take()
            .map(|sidecar| sidecar.child)
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
            if let Some(sidecar) = guard.take() {
                let _ = sidecar.child.kill();
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
pub(super) struct RejectionSnapshot {
    pub(super) message: String,
    status: u16,
    at: String,
    remediation_url: Option<String>,
}

/// Tracks the most recent rejection snapshot the rejection poller has
/// observed. None = no recent non-fatal rejection (healthy). Wrapped
/// in Mutex because both the polling task and tray-refresh path read it.
pub(super) struct LastRejection(Mutex<Option<RejectionSnapshot>>);

impl LastRejection {
    pub(super) fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub(super) fn get(&self) -> Option<RejectionSnapshot> {
        self.0.lock().expect("rejection mutex poisoned").clone()
    }

    /// Returns true if the state transitioned from None → Some. Callers
    /// use that signal to fire the one-shot OS notification.
    pub(super) fn set(&self, next: Option<RejectionSnapshot>) -> RejectionTransition {
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
pub(super) enum RejectionTransition {
    Unchanged,
    /// None → Some: notification fires here.
    Entered,
    /// Some → None: tray icon restores to NORMAL.
    Cleared,
    /// Some → Some(different): tray stays in ATTENTION, no re-notify.
    Changed,
}

/// MCP servers' requests for user input waiting in Settings → Requests, as
/// last reported by `/settings/api/requests/summary`: a count and the newest
/// id, never contents (those stay in Settings). Drives the ATTENTION icon,
/// a tray item, and one notification per new request.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct RequestsSnapshot {
    pub(super) pending: u64,
    newest_id: Option<String>,
}

/// How many recent newest ids to remember, so one that becomes newest
/// again (a later one was answered first) isn't taken for a new arrival.
const SEEN_REQUEST_IDS: usize = 64;

#[derive(Default)]
struct RequestsState {
    snapshot: RequestsSnapshot,
    seen: std::collections::VecDeque<String>,
}

pub(super) struct PendingRequests(Mutex<RequestsState>);

impl PendingRequests {
    pub(super) fn new() -> Self {
        Self(Mutex::new(RequestsState::default()))
    }

    pub(super) fn get(&self) -> RequestsSnapshot {
        self.0
            .lock()
            .expect("requests mutex poisoned")
            .snapshot
            .clone()
    }

    pub(super) fn set(&self, next: RequestsSnapshot) -> RequestsTransition {
        let mut guard = self.0.lock().expect("requests mutex poisoned");
        let transition = requests_transition(&guard.snapshot, &next, &guard.seen);
        if let Some(id) = &next.newest_id {
            if !guard.seen.contains(id) {
                guard.seen.push_back(id.clone());
                if guard.seen.len() > SEEN_REQUEST_IDS {
                    guard.seen.pop_front();
                }
            }
        }
        guard.snapshot = next;
        transition
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RequestsTransition {
    Unchanged,
    /// A request arrived that wasn't there before: notify once.
    Arrived,
    /// Fewer or none waiting: refresh the tray, don't notify.
    Changed,
}

/// A newest id not seen before means a request arrived; anything else that
/// differs is requests being answered, withdrawn or expiring.
fn requests_transition(
    prev: &RequestsSnapshot,
    next: &RequestsSnapshot,
    seen: &std::collections::VecDeque<String>,
) -> RequestsTransition {
    if prev == next {
        return RequestsTransition::Unchanged;
    }
    match &next.newest_id {
        Some(id) if next.pending > 0 && !seen.contains(id) => RequestsTransition::Arrived,
        _ => RequestsTransition::Changed,
    }
}

fn parse_requests_summary(payload: &serde_json::Value) -> Option<RequestsSnapshot> {
    let pending = payload.get("pending")?.as_u64()?;
    let newest_id = match payload.get("newestId")? {
        serde_json::Value::Null => None,
        value => Some(value.as_str()?.to_owned()),
    };
    Some(RequestsSnapshot { pending, newest_id })
}
/// The latest available release, as last reported by the sidecar's
/// `/settings/api/update-status`. None = up to date (or unknown). Drives the
/// "Update to X.Y.Z…" tray item and a one-shot OS notification when a newer
/// version first appears. Mutex because the poll task writes it while the
/// tray-refresh and menu-event paths read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct UpdateSnapshot {
    /// Latest version, no leading "v".
    pub(super) latest: String,
    /// Install-channel-neutral download page, or the Linux guide's update
    /// section for an apt install.
    pub(super) url: String,
    /// For an apt install (the Debian/Ubuntu packages), the command that
    /// upgrades it. Maximal never runs it: the tray item opens Settings, which
    /// shows it to copy.
    pub(super) apt_command: Option<String>,
}

/// Tracks the most recent update snapshot the poll loop has observed. Wrapped
/// in Mutex because the polling task and the tray paths both touch it.
pub(super) struct LatestUpdate(Mutex<Option<UpdateSnapshot>>);

impl LatestUpdate {
    pub(super) fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub(super) fn get(&self) -> Option<UpdateSnapshot> {
        self.0.lock().expect("update mutex poisoned").clone()
    }

    /// Stores the snapshot; returns true if it changed (a newly available
    /// version, a changed target, or clearing back to up-to-date). Callers
    /// fire the one-shot notification only when the new value is Some, so a
    /// repeated periodic check that finds the same version doesn't re-nag.
    pub(super) fn set(&self, next: Option<UpdateSnapshot>) -> bool {
        let mut guard = self.0.lock().expect("update mutex poisoned");
        if *guard == next {
            return false;
        }
        *guard = next;
        true
    }
}

/// Armed by an in-place update just before it stops the sidecar. The
/// Terminated handler hands the exit to the waiting update instead of
/// quitting the app (a clean exit) or marking it Failed (a hard kill): the
/// installer is about to replace the sidecar's executable and relaunch.
pub(super) struct SidecarHandoff(Mutex<Option<tokio::sync::oneshot::Sender<()>>>);

impl SidecarHandoff {
    pub(super) fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn arm(&self, tx: tokio::sync::oneshot::Sender<()>) {
        *self.0.lock().expect("handoff mutex poisoned") = Some(tx);
    }

    /// The waiting update's sender, if one is armed. Clears it.
    fn take(&self) -> Option<tokio::sync::oneshot::Sender<()>> {
        self.0.lock().expect("handoff mutex poisoned").take()
    }
}

/// Holds the most recent error-looking line the sidecar printed to stderr,
/// so a Starting→Failed transition can tell the user *why* it failed (on the
/// splash and in the OS notification) instead of a generic "couldn't start".
/// Cleared when a retry begins so a stale reason can't haunt a fresh attempt.
pub(super) struct LastSidecarError(Mutex<Option<String>>);

impl LastSidecarError {
    pub(super) fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn set(&self, reason: Option<String>) {
        *self.0.lock().expect("sidecar-error mutex poisoned") = reason;
    }

    pub(super) fn get(&self) -> Option<String> {
        self.0.lock().expect("sidecar-error mutex poisoned").clone()
    }
}

/// Tracks the current SidecarState behind a Mutex so the polling task
/// (Tokio) and the menu-event callback (main thread) can both touch it.
pub(super) struct AppStatus(Mutex<SidecarState>);

impl AppStatus {
    pub(super) fn new() -> Self {
        Self(Mutex::new(SidecarState::Starting))
    }

    pub(super) fn get(&self) -> SidecarState {
        *self.0.lock().expect("status mutex poisoned")
    }

    /// Returns Some(previous) if the state changed, None otherwise.
    pub(super) fn set(&self, next: SidecarState) -> Option<SidecarState> {
        let mut guard = self.0.lock().expect("status mutex poisoned");
        if *guard == next {
            return None;
        }
        let prev = *guard;
        *guard = next;
        Some(prev)
    }
}
/// Set while `respawn_sidecar` is intentionally cycling the sidecar (the
/// account-switch / sign-in / sign-out reboot). The old sidecar exits cleanly
/// from our SIGTERM, which the Terminated handler would otherwise read as a
/// user-initiated quit and bring the WHOLE app down — stranding the tray and
/// killing the reboot before the replacement spawns. The handler consumes this
/// flag and keeps the app alive for the respawn instead.
pub(super) struct SidecarRestarting(Mutex<HashSet<u64>>);

impl SidecarRestarting {
    pub(super) fn new() -> Self {
        Self(Mutex::new(HashSet::new()))
    }

    /// Mark one exact generation's exit as an intentional restart. A newer
    /// generation can exit first without consuming the old one's handoff.
    fn begin(&self, generation: u64) {
        self.0
            .lock()
            .expect("restart mutex poisoned")
            .insert(generation);
    }

    fn consume(&self, generation: u64) -> bool {
        self.0
            .lock()
            .expect("restart mutex poisoned")
            .remove(&generation)
    }
}

/// Marks a child that the shell is stopping because startup already failed.
/// Its clean SIGTERM exit must leave the tray in Failed rather than exit the app.
pub(super) struct SidecarFailureStop(Mutex<HashSet<u64>>);

impl SidecarFailureStop {
    pub(super) fn new() -> Self {
        Self(Mutex::new(HashSet::new()))
    }

    fn begin(&self, generation: u64) {
        self.0
            .lock()
            .expect("failure-stop mutex poisoned")
            .insert(generation);
    }

    fn consume(&self, generation: u64) -> bool {
        self.0
            .lock()
            .expect("failure-stop mutex poisoned")
            .remove(&generation)
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
pub(super) struct ShellApiKey(String);

impl ShellApiKey {
    pub(super) fn new() -> Self {
        Self(generate_shell_api_key())
    }

    pub(super) fn value(&self) -> &str {
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
fn random_hex() -> String {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).expect("could not read OS CSPRNG");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn generate_shell_api_key() -> String {
    format!("mxlshell_{}", random_hex())
}

fn generate_nonce() -> String {
    random_hex()
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
pub(super) enum TokenUsageEvent {
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

/// Data-update interval after a successful fetch: 500 ms per digit of the
/// total tokens used (0–9 → 500 ms, 10–99 → 1 s, … 100K–999,999 → 3 s), and
/// a flat 10 s from a million on. The point is only to show tokens are
/// coming in, not to hammer the sidecar. Same rule as `pollIntervalMs` in
/// shell/src/dashboard/main.ts.
fn dashboard_poll_interval(payload: &serde_json::Value) -> Duration {
    let total = payload
        .pointer("/totals/total_tokens")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if total >= 1_000_000 {
        return Duration::from_secs(10);
    }
    let digits = total.checked_ilog10().map_or(1, |d| d + 1);
    Duration::from_millis(500 * u64::from(digits))
}

/// One-shot GET of `/token-usage?period=…` against the local sidecar.
/// Returns the parsed JSON body on 2xx, an error string otherwise.
async fn fetch_token_usage(
    client: &reqwest::Client,
    endpoint: SidecarEndpoint,
    period: &str,
) -> Result<serde_json::Value, String> {
    let url = endpoint.http_url(&format!("/token-usage?period={period}"));
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
pub(super) async fn subscribe_token_usage(
    endpoint: State<'_, ManagedEndpoint>,
    period: String,
    on_event: Channel<TokenUsageEvent>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let period = canonical_period(&period);

    loop {
        let Some(current) = endpoint.current() else {
            if on_event
                .send(TokenUsageEvent::Error {
                    message: "sidecar is not ready".to_string(),
                })
                .is_err()
            {
                return Ok(());
            }
            tokio::time::sleep(DASHBOARD_RETRY_INTERVAL).await;
            continue;
        };
        let wait = match fetch_token_usage(&client, current, period).await {
            Ok(payload) => {
                let wait = dashboard_poll_interval(&payload);
                if on_event.send(TokenUsageEvent::Update { payload }).is_err() {
                    return Ok(());
                }
                wait
            }
            Err(message) => {
                if on_event.send(TokenUsageEvent::Error { message }).is_err() {
                    return Ok(());
                }
                DASHBOARD_RETRY_INTERVAL
            }
        };
        tokio::time::sleep(wait).await;
    }
}

pub(super) fn get_shell_api_key(state: State<'_, ShellApiKey>) -> String {
    state.value().to_string()
}
#[derive(Debug, Deserialize)]
pub(super) struct SetupCheckResult {
    pub(super) ok: bool,
}

#[derive(Debug, Deserialize)]
pub(super) struct SetupChecks {
    #[serde(rename = "githubAuth")]
    pub(super) github_auth: SetupCheckResult,
}

#[derive(Debug, Deserialize)]
pub(super) struct SetupStatusResponse {
    pub(super) checks: SetupChecks,
}
pub(super) fn spawn_sidecar(app: &AppHandle) -> tauri::Result<()> {
    // sidecar("maximal") resolves `maximal` next to this executable: the
    // arch-suffixed `bundle.externalBin` copy Tauri places there on macOS and
    // Windows, and the `maximal` package's /usr/bin/maximal for the Linux
    // maximal-desktop package (which bundles no sidecar).
    let profile = *app.state::<AppProfile>();
    let spawn = app.state::<ManagedEndpoint>().begin_generation(profile);
    let port = spawn.requested_port.to_string();
    let identifier = app.config().identifier.clone();
    let args = if profile == AppProfile::Production {
        vec!["start", "--replace", "--port", port.as_str()]
    } else {
        // Profile identity and preferred-port fallback own dev/test handoff;
        // never evict a process merely because it answered on that port.
        vec!["start", "--port", port.as_str()]
    };
    let mut cmd = app
        .shell()
        .sidecar("maximal")
        .map_err(|e| tauri::Error::Anyhow(e.into()))?
        .args(args)
        // Shell plugin 2.6+ contains ordinary descendants in a POSIX process
        // group / Windows Job Object. Maximal's local plugin patch configures
        // the Windows job as kill-on-close before this suspended child starts.
        // The deliberately detached MCP broker also has its own containment,
        // IPC, and parent-watchdog shutdown contract.
        .set_process_group(true)
        .env("HOST", LOOPBACK_HOST)
        .env("MAXIMAL_APP_PROFILE", profile.as_env())
        .env("MAXIMAL_INSTANCE_ID", &identifier)
        .env("MAXIMAL_INSTANCE_NONCE", &spawn.nonce)
        .env("COPILOT_API_HOME", app.state::<AppDataDir>().0.as_os_str());
    if profile != AppProfile::Production {
        cmd = cmd.env("MAXIMAL_UPDATE_POLICY", "disabled");
    }

    // The settings + dashboard UIs are embedded directly in the sidecar
    // binary and served at /ui/* (see src/routes/ui/route.ts), so there is
    // nothing to stage or point at — the UI travels inside the binary in
    // both `tauri dev` and packaged builds. NODE_ENV=production is still
    // set for parity with `maximal start` defaults elsewhere.
    cmd = cmd.env("NODE_ENV", "production");
    // Hand the shell's PID to the sidecar for its parent-death watchdog. This
    // remains a cross-platform fallback; on Windows the kill-on-close Job Object
    // ends the process tree in the kernel when the shell handle closes.
    cmd = cmd.env("MAXIMAL_SIDECAR_PARENT_PID", std::process::id().to_string());
    // Shell-internal API key — the webview reads it via the
    // `get_shell_api_key` Tauri command and sends it on every
    // /settings/api/* request. Lets the user's own UI keep working
    // after they flip "Block unknown connections."
    cmd = cmd.env(
        "MAXIMAL_SHELL_KEY",
        app.state::<ShellApiKey>().value().to_string(),
    );

    let (mut rx, child) = cmd.spawn().map_err(|e| tauri::Error::Anyhow(e.into()))?;

    app.state::<Sidecar>().set(spawn.generation, child);

    let handle = app.clone();
    let event_spawn = spawn.clone();
    tauri::async_runtime::spawn(async move {
        let mut stdout = StdoutLines::default();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(chunk) => {
                    for line in stdout.push(&chunk) {
                        handle_sidecar_stdout(&handle, &event_spawn, &identifier, &line);
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
                    handle
                        .state::<Sidecar>()
                        .clear_generation(event_spawn.generation);
                    handle
                        .state::<ManagedEndpoint>()
                        .clear_generation(event_spawn.generation);
                    eprintln!("[maximal] sidecar exited: {:?}", payload);
                    // An owning lifecycle (in-place update or Windows Quit)
                    // stopped it and is waiting for proof that it is gone. Hand
                    // off the event and leave the app-level decision to that caller.
                    if let Some(tx) = handle.state::<SidecarHandoff>().take() {
                        let _ = tx.send(());
                        break;
                    }
                    // A startup timeout or capability failure deliberately
                    // stopped this generation. Its clean SIGTERM exit must keep
                    // the shell's Failed state instead of quitting the app.
                    if handle
                        .state::<SidecarFailureStop>()
                        .consume(event_spawn.generation)
                    {
                        eprintln!("[maximal] (startup failure — keeping the app in Failed)");
                        break;
                    }
                    // Intentional restart (account switch / sign-in / sign-out
                    // reboot)? Start the replacement only after this termination
                    // event proves the old listener released the persisted port.
                    if handle
                        .state::<SidecarRestarting>()
                        .consume(event_spawn.generation)
                    {
                        eprintln!("[maximal] intentional restart — starting replacement");
                        if let Err(err) = spawn_sidecar(&handle) {
                            eprintln!("[shell] sidecar respawn failed: {err}");
                            send_event(&handle, RuntimeEvent::State(SidecarState::Failed));
                        }
                        break;
                    }
                    let profile = *handle.state::<AppProfile>();
                    if payload.code != Some(0)
                        && !handle.state::<RuntimeExiting>().get()
                        && profile != AppProfile::Production
                        && handle.state::<ManagedEndpoint>().prepare_dynamic_retry(
                            event_spawn.generation,
                            event_spawn.requested_port,
                        )
                    {
                        eprintln!(
                            "[shell] preferred port {} failed before readiness; retrying with a kernel-selected port",
                            event_spawn.requested_port
                        );
                        let preferred_file = preferred_port_file(&handle.state::<AppDataDir>().0);
                        if let Err(err) = std::fs::remove_file(preferred_file) {
                            if err.kind() != std::io::ErrorKind::NotFound {
                                eprintln!("[shell] could not clear failed preferred port: {err}");
                            }
                        }
                        send_event(&handle, RuntimeEvent::State(SidecarState::Starting));
                        if let Err(err) = spawn_sidecar(&handle) {
                            eprintln!("[shell] dynamic-port retry failed: {err}");
                            send_event(&handle, RuntimeEvent::State(SidecarState::Failed));
                        }
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
                    // A clean sidecar exit is an intentional whole-app shutdown.
                    // Development shells also exit after a crash so the external
                    // app:dev launcher can replace them without signaling a stale
                    // recorded PID. Production/test builds keep the tray alive in
                    // Failed state so the user can inspect logs and retry.
                    if payload.code == Some(0) {
                        send_event(&handle, RuntimeEvent::Exit(0));
                    } else {
                        // Crash / SIGKILL: the sidecar never reached its
                        // graceful-shutdown reconciler, so a Claude Code
                        // base URL it wrote may be stranded over a now-dead
                        // proxy. We outlive the sidecar, so revert it on its
                        // behalf via the shared CLI subcommand. Ownership-
                        // guarded and intent-neutral: it only removes the
                        // base URL we wrote, and leaves the persisted routing
                        // intent alone so a future restart re-applies it.
                        let exit_after_revert = profile == AppProfile::Development;
                        reconcile_claude_code_revert(&handle, exit_after_revert);
                        if !exit_after_revert {
                            send_event(&handle, RuntimeEvent::State(SidecarState::Failed));
                        }
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    let timeout_handle = app.clone();
    let generation = spawn.generation;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SIDECAR_READY_TIMEOUT).await;
        if timeout_handle
            .state::<ManagedEndpoint>()
            .expire_pending(generation)
        {
            let reason = format!(
                "sidecar did not emit a valid {READY_MARKER} line within {} seconds",
                SIDECAR_READY_TIMEOUT.as_secs()
            );
            eprintln!("[shell] {reason}");
            timeout_handle.state::<LastSidecarError>().set(Some(reason));
            timeout_handle
                .state::<SidecarFailureStop>()
                .begin(generation);
            kill_sidecar(&timeout_handle);
            send_event(&timeout_handle, RuntimeEvent::State(SidecarState::Failed));
        }
    });

    Ok(())
}

fn handle_sidecar_stdout(app: &AppHandle, spawn: &SpawnGeneration, identifier: &str, raw: &str) {
    let line = raw.trim();
    if let Some(payload) = line.strip_prefix(READY_MARKER) {
        let ready = match serde_json::from_str::<SidecarReady>(payload.trim()) {
            Ok(ready) => ready,
            Err(err) => {
                eprintln!("[shell] ignored malformed sidecar ready line: {err}");
                return;
            }
        };
        if let Err(reason) = validate_ready(&ready, spawn, identifier) {
            eprintln!("[shell] ignored invalid sidecar ready line: {reason}");
            return;
        }

        let endpoints = app.state::<ManagedEndpoint>();
        if !endpoints.is_pending(spawn.generation) {
            return;
        }
        if *app.state::<AppProfile>() != AppProfile::Production {
            if let Err(err) = write_preferred_port(&app.state::<AppDataDir>().0, ready.port) {
                let reason = format!("could not persist preferred sidecar port: {err}");
                eprintln!("[shell] {reason}");
                app.state::<LastSidecarError>().set(Some(reason));
                endpoints.expire_pending(spawn.generation);
                app.state::<SidecarFailureStop>().begin(spawn.generation);
                kill_sidecar(app);
                send_event(app, RuntimeEvent::State(SidecarState::Failed));
                return;
            }
        }
        if !endpoints.has_capability(ready.port) {
            if let Err(err) = register_remote_capability(app, ready.port) {
                let reason = format!("could not register sidecar capability: {err}");
                eprintln!("[shell] {reason}");
                app.state::<LastSidecarError>().set(Some(reason));
                endpoints.expire_pending(spawn.generation);
                app.state::<SidecarFailureStop>().begin(spawn.generation);
                kill_sidecar(app);
                send_event(app, RuntimeEvent::State(SidecarState::Failed));
                return;
            }
            endpoints.mark_capability(ready.port);
        }
        if endpoints.activate(spawn.generation, ready.port) {
            send_event(
                app,
                RuntimeEvent::Ready(SidecarEndpoint {
                    generation: spawn.generation,
                    port: ready.port,
                }),
            );
        }
        return;
    }

    if let Some(message) = line.strip_prefix(BOOT_STATUS_MARKER) {
        send_event(app, RuntimeEvent::BootStatus(message.trim().to_string()));
    } else if !raw.is_empty() {
        println!("[maximal] {raw}");
    }
}

fn register_remote_capability(app: &AppHandle, port: u16) -> tauri::Result<()> {
    let capability = CapabilityBuilder::new(format!("sidecar-loopback-{port}"))
        .local(false)
        .remote(format!("http://localhost:{port}/*"))
        .windows([SETTINGS_WINDOW_LABEL, DASHBOARD_WINDOW_LABEL])
        .permission("core:default")
        .permission("core:window:default")
        .permission("core:window:allow-start-dragging")
        .permission("core:window:allow-internal-toggle-maximize")
        .permission("core:webview:allow-create-webview-window")
        .permission("opener:default")
        .permission("default");
    app.add_capability(capability)
}

/// Run `maximal app claude-code --disable` as a one-shot sidecar
/// command. Called when the proxy sidecar *crashes* (non-zero exit) — it
/// can't revert its own Claude Code base URL in that path, so the shell
/// does it. Best-effort: a missing binary or non-zero exit is logged and
/// swallowed (the worst case is a stranded base URL the next clean boot
/// re-applies or the user toggles off). Fire-and-forget on a Tokio task so
/// the Terminated handler stays synchronous. Development waits for this
/// one-shot before exiting, allowing app:dev to replace the failed shell.
fn reconcile_claude_code_revert(app: &AppHandle, exit_after: bool) {
    let command = match app.shell().sidecar("maximal") {
        Ok(c) => c
            .args(["app", "claude-code", "--disable"])
            .set_process_group(true)
            .env("HOST", LOOPBACK_HOST)
            .env("COPILOT_API_HOME", app.state::<AppDataDir>().0.as_os_str()),
        Err(err) => {
            eprintln!("[shell] could not build claude-code revert command: {err}");
            if exit_after {
                send_event(app, RuntimeEvent::Exit(1));
            }
            return;
        }
    };
    let (mut events, child) = match command.spawn() {
        Ok(spawned) => spawned,
        Err(err) => {
            eprintln!("[shell] claude-code revert failed to start: {err}");
            if exit_after {
                send_event(app, RuntimeEvent::Exit(1));
            }
            return;
        }
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let completed = tokio::time::timeout(Duration::from_secs(5), async {
            let mut stderr = String::new();
            while let Some(event) = events.recv().await {
                match event {
                    CommandEvent::Stderr(chunk) if stderr.len() < 4096 => {
                        stderr.push_str(&String::from_utf8_lossy(&chunk));
                    }
                    CommandEvent::Terminated(payload) => {
                        return (payload.code, stderr);
                    }
                    _ => {}
                }
            }
            (None, stderr)
        })
        .await;

        match completed {
            Ok((Some(0), _)) => {
                eprintln!("[shell] reverted Claude Code base URL after sidecar crash");
            }
            Ok((code, stderr)) => {
                eprintln!("[shell] claude-code revert exited {code:?}: {stderr}",);
            }
            Err(_) => {
                eprintln!("[shell] claude-code revert exceeded 5s; terminating it");
                let _ = child.kill();
            }
        }
        if exit_after {
            send_event(&app, RuntimeEvent::Exit(1));
        }
    });
}

/// Pull a human-readable failure reason out of a sidecar stderr chunk, or
/// None if nothing in it looks like an error. consola's fancy reporter prints
/// errors as ` ERROR  <message>` (and a bracketed `[error] <message>` in
/// basic mode); we take the text after that tag, first line only, trimmed and
/// length-capped so a stack trace can't blow up the splash/notification.
pub(super) fn extract_error_reason(chunk: &str) -> Option<String> {
    for raw in chunk.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        // Find the error tag in either consola style; take what follows.
        let after = line
            .find("ERROR")
            .map(|i| &line[i + "ERROR".len()..])
            .or_else(|| line.find("[error]").map(|i| &line[i + "[error]".len()..]));
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
/// `CommandChild::kill()` is intentionally the hard-stop path (and, with
/// process groups enabled, ends the sidecar's non-detached process tree). That
/// gives the Bun-compiled sidecar no chance to flush logs, close its listening socket, or
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
/// On Windows there is no SIGTERM to send through this API. We instead
/// run `taskkill /PID <pid>` *without* `/F`: that posts WM_CLOSE /
/// CTRL_CLOSE_EVENT to the target, which the Bun runtime surfaces to
/// the sidecar's emulated `SIGTERM`/`SIGINT` handler (src/lib/start/
/// shutdown.ts wires both) — so the same graceful drain runs. We then
/// escalate to `CommandChild::kill()` (SIGKILL-equivalent) after the
/// grace period, exactly like the Unix path. If taskkill can't be
/// spawned we fall straight through to the hard kill so a Quit never
/// hangs. (A future, even-cleaner option is to POST the proxy's own
/// `/_internal/shutdown` endpoint — the same protocol `--replace` uses —
/// but that's async work this synchronous Exit path doesn't need today;
/// the parent-death watchdog already backstops an abrupt kill.)
///
/// Returns false when there was no sidecar to stop, so no Terminated event
/// will follow.
pub(super) fn kill_sidecar(app: &AppHandle) -> bool {
    let Some(child) = app.state::<Sidecar>().take() else {
        return false;
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
        // sidecar ~3s after a restart (the proxy would vanish from its port and
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
        // Windows graceful shutdown: `taskkill` WITHOUT `/F` requests a
        // polite close (WM_CLOSE / CTRL_CLOSE_EVENT) that Bun delivers to
        // the sidecar's emulated SIGTERM/SIGINT handler, so the drain in
        // src/lib/start/shutdown.ts runs (flush logs, close socket, revert
        // Claude Code base URL). `/T` also reaps any child the sidecar
        // spawned. Best-effort: if taskkill won't launch we skip straight
        // to the hard kill below.
        let pid = child.pid();
        #[cfg(target_os = "windows")]
        {
            #[cfg(windows)]
            use std::os::windows::process::CommandExt;
            use std::process::Command;
            // CREATE_NO_WINDOW: don't flash a console for the helper.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let mut cmd = Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string(), "/T"]);
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);
            if let Err(err) = cmd.spawn() {
                eprintln!("[shell] taskkill spawn failed ({err}); hard-killing");
            }
        }

        // Escalate to SIGKILL-equivalent after the grace period, mirroring
        // the Unix path. MOVE the child into the thread (do NOT return it to
        // the shared Sidecar slot) so a respawn that fills the slot with a
        // fresh child isn't killed by this escalation ~3s later.
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            // No-op if the graceful close above already made it exit.
            let _ = child.kill();
        });
    }
    true
}

/// One-shot fetch of `/settings/api/auth/github/status` against the
/// local sidecar, scoped to the rejection sidecar. Returns
/// `Some(Option<...>)` to distinguish "endpoint replied" (the
/// sidecar may or may not have a rejection) from "endpoint unreachable"
/// (silent skip — don't churn the tray icon on a transient).
pub(super) async fn fetch_rejection(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
) -> Option<Option<RejectionSnapshot>> {
    let key = app.state::<ShellApiKey>().value().to_owned();
    let resp = client.get(url).header("x-api-key", key).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let payload: serde_json::Value = resp.json().await.ok()?;
    Some(parse_rejection_from_status(&payload))
}

fn parse_rejection_from_status(payload: &serde_json::Value) -> Option<RejectionSnapshot> {
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
/// `/settings/api/requests/summary`; None when unreachable or malformed, so
/// a transient blip doesn't clear the tray.
pub(super) async fn fetch_requests_summary(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
) -> Option<RequestsSnapshot> {
    let key = app.state::<ShellApiKey>().value().to_owned();
    let resp = client.get(url).header("x-api-key", key).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let payload: serde_json::Value = resp.json().await.ok()?;
    parse_requests_summary(&payload)
}
/// What a sidecar `/settings/api/update-status` payload says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum UpdateCheck {
    /// A definitive answer: Some = a newer release to offer, None = up to
    /// date (or checks are disabled).
    Resolved(Option<UpdateSnapshot>),
    /// Checks are on but the sidecar couldn't resolve a version yet (offline
    /// at launch, a CDN blip). Nothing to apply; retry sooner.
    Unresolved,
}

/// Classify an update-status payload. Pure, so the tray's decision is
/// testable without a running sidecar.
pub(super) fn parse_update_status(payload: &serde_json::Value) -> UpdateCheck {
    let available = payload
        .get("update_available")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let latest = payload
        .get("latest")
        .and_then(serde_json::Value::as_str)
        .filter(|v| !v.is_empty());
    if let (true, Some(latest)) = (available, latest) {
        let url = payload
            .get("url")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(UPDATE_PAGE_URL);
        let apt_command = payload
            .get("update_command")
            .and_then(serde_json::Value::as_str)
            .filter(|c| !c.is_empty())
            .map(str::to_owned);
        return UpdateCheck::Resolved(Some(UpdateSnapshot {
            latest: latest.to_owned(),
            url: url.to_owned(),
            apt_command,
        }));
    }
    let enabled = payload
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let failed = payload.get("last_error").is_some_and(|e| !e.is_null());
    if enabled && latest.is_none() && failed {
        UpdateCheck::Unresolved
    } else {
        UpdateCheck::Resolved(None)
    }
}

/// GET an update-status URL against the sidecar. None on any transient
/// failure (unreachable / non-2xx / unparseable).
pub(super) async fn fetch_update_payload(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
) -> Option<serde_json::Value> {
    let key = app.state::<ShellApiKey>().value().to_owned();
    let resp = match client.get(url).header("x-api-key", key).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return None,
    };
    resp.json().await.ok()
}

/// How a user-asked update check ended: what the tray tells them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ManualCheck {
    /// A newer release exists (the tray item and the notification say so).
    Available(UpdateSnapshot),
    /// Current. Carries the running version for the notice.
    UpToDate(String),
    /// `config.checkUpdates` is off: the sidecar didn't look.
    Disabled,
    /// The sidecar couldn't say (unreachable, or the manifest couldn't be
    /// read). Never reported as "up to date".
    Failed,
}

/// Classify the answer to a forced check. Pure, so it is testable without a
/// running sidecar. Builds on `parse_update_status`; the one difference from
/// the poll is that an answer carrying `last_error` is a failed check even
/// when an older result is still known, because the user asked for a fresh one.
pub(super) fn manual_check_outcome(payload: Option<&serde_json::Value>) -> ManualCheck {
    let Some(payload) = payload else {
        return ManualCheck::Failed;
    };
    let enabled = payload
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    if !enabled {
        return ManualCheck::Disabled;
    }
    if payload.get("last_error").is_some_and(|e| !e.is_null()) {
        return ManualCheck::Failed;
    }
    match parse_update_status(payload) {
        UpdateCheck::Resolved(Some(snapshot)) => ManualCheck::Available(snapshot),
        UpdateCheck::Resolved(None) => payload
            .get("current")
            .and_then(serde_json::Value::as_str)
            .filter(|v| !v.is_empty())
            .map_or(ManualCheck::Failed, |v| ManualCheck::UpToDate(v.to_owned())),
        UpdateCheck::Unresolved => ManualCheck::Failed,
    }
}

/// The sidecar's update-status URL; `force` asks for a fresh check instead of
/// the cached one.
pub(super) fn update_status_endpoint(endpoint: SidecarEndpoint, force: bool) -> String {
    let base = endpoint.http_url("/settings/api/update-status");
    if force {
        format!("{base}?force=1")
    } else {
        base
    }
}
pub(super) async fn fetch_setup_status(
    client: &reqwest::Client,
    url: &str,
) -> Option<SetupStatusResponse> {
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<SetupStatusResponse>().await.ok()
}
/// Stop the sidecar and wait for its termination event. `SidecarHandoff`
/// prevents that event from independently exiting or changing the shell while
/// an update or the Windows Quit path owns the surrounding lifecycle.
pub(super) async fn stop_sidecar_and_wait(app: &AppHandle) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.state::<SidecarHandoff>().arm(tx);
    if kill_sidecar(app)
        && tokio::time::timeout(SIDECAR_STOP_TIMEOUT, rx)
            .await
            .is_err()
    {
        eprintln!("[shell] sidecar still running after {SIDECAR_STOP_TIMEOUT:?}");
    }
    // Disarm, so a later exit (after a failed install) is handled normally.
    app.state::<SidecarHandoff>().take();
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
/// collide on the selected port.
pub(super) fn retry_startup(app: &AppHandle) {
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
pub(super) fn respawn_sidecar(app: &AppHandle) {
    // Clear the previous failure reason so a stale message can't haunt this
    // attempt (it would otherwise reappear on the splash/notification if the
    // respawn also fails before printing its own error).
    app.state::<LastSidecarError>().set(None);

    // Mark this exact generation as an intentional restart BEFORE SIGTERM, so
    // a replacement that exits first cannot consume the old process's handoff.
    let stopping_generation = app.state::<Sidecar>().generation();
    if let Some(generation) = stopping_generation {
        app.state::<SidecarRestarting>().begin(generation);
    }

    // Reap the current child (healthy, hung, or mid-crash). Every replacement
    // requests the already-selected port; it does not depend on `--replace` for
    // profile handoff.
    let waiting_for_exit = kill_sidecar(app);
    send_event(app, RuntimeEvent::State(SidecarState::Starting));
    if waiting_for_exit {
        // The matching Terminated event starts the replacement after the old
        // listener has actually released the persisted port.
        return;
    }
    if let Some(generation) = stopping_generation {
        app.state::<SidecarRestarting>().consume(generation);
    }
    if let Err(err) = spawn_sidecar(app) {
        eprintln!("[shell] sidecar respawn failed: {err}");
        send_event(app, RuntimeEvent::State(SidecarState::Failed));
    }

    // The replacement generation starts polling after its validated ready line.
}

#[cfg(test)]
mod tests {
    use super::extract_error_reason;

    #[test]
    fn reads_the_requests_summary() {
        use super::{parse_requests_summary, RequestsSnapshot};
        assert_eq!(
            parse_requests_summary(&serde_json::json!({ "pending": 2, "newestId": "elicit-9" })),
            Some(RequestsSnapshot {
                pending: 2,
                newest_id: Some("elicit-9".into())
            })
        );
        assert_eq!(
            parse_requests_summary(&serde_json::json!({ "pending": 0, "newestId": null })),
            Some(RequestsSnapshot {
                pending: 0,
                newest_id: None
            })
        );
        assert_eq!(
            parse_requests_summary(&serde_json::json!({ "pending": "x" })),
            None
        );
    }

    #[test]
    fn notifies_only_when_a_new_request_arrives() {
        use super::{PendingRequests, RequestsSnapshot, RequestsTransition};
        let snap = |pending: u64, newest: Option<&str>| RequestsSnapshot {
            pending,
            newest_id: newest.map(str::to_owned),
        };
        let state = PendingRequests::new();
        assert_eq!(state.set(snap(0, None)), RequestsTransition::Unchanged);
        assert_eq!(state.set(snap(1, Some("a"))), RequestsTransition::Arrived);
        assert_eq!(state.set(snap(1, Some("a"))), RequestsTransition::Unchanged);
        assert_eq!(state.set(snap(2, Some("b"))), RequestsTransition::Arrived);
        // Answering the newest makes the older one newest again: not new.
        assert_eq!(state.set(snap(1, Some("a"))), RequestsTransition::Changed);
        assert_eq!(state.set(snap(0, None)), RequestsTransition::Changed);
        // One answered and another arrived: still news.
        assert_eq!(state.set(snap(1, Some("c"))), RequestsTransition::Arrived);
    }

    #[test]
    fn classifies_profiles_from_the_final_identifier() {
        use super::{AppProfile, PRODUCTION_IDENTIFIER};
        assert_eq!(
            AppProfile::from_identifier(PRODUCTION_IDENTIFIER),
            AppProfile::Production
        );
        assert_eq!(
            AppProfile::from_identifier("co.stuffbucket.maximal.dev.maximal-0123abcd"),
            AppProfile::Development
        );
        assert_eq!(
            AppProfile::from_identifier("co.stuffbucket.maximal.test.unit"),
            AppProfile::Test
        );
        assert_eq!(
            AppProfile::from_identifier("com.example.unknown"),
            AppProfile::Development
        );
        assert_eq!(AppProfile::Production.initial_port(), 4141);
        assert_eq!(AppProfile::Development.initial_port(), 0);
        assert_eq!(AppProfile::Test.initial_port(), 0);
    }

    #[test]
    fn preserves_the_existing_localhost_webview_origin() {
        use super::SidecarEndpoint;
        let endpoint = SidecarEndpoint {
            generation: 1,
            port: 4141,
        };
        assert_eq!(endpoint.browser_origin(), "http://localhost:4141");
    }

    #[test]
    fn failure_stop_is_scoped_to_one_generation() {
        use super::SidecarFailureStop;
        let failures = SidecarFailureStop::new();
        failures.begin(7);
        assert!(!failures.consume(6));
        assert!(failures.consume(7));
        assert!(!failures.consume(7));
    }

    #[test]
    fn parses_chunked_ready_lines_and_validates_every_field() {
        use super::{validate_ready, SidecarReady, SpawnGeneration, StdoutLines, READY_MARKER};
        let spawn = SpawnGeneration {
            generation: 1,
            requested_port: 0,
            nonce: "secret".into(),
        };
        let mut lines = StdoutLines::default();
        assert!(lines
            .push(b"noise\n@@MAX")
            .iter()
            .any(|line| line == "noise"));
        let parsed = lines.push(
            b"IMAL_READY@@{\"protocol\":1,\"host\":\"127.0.0.1\",\"port\":43210,\"instanceId\":\"co.stuffbucket.maximal.dev.maximal-1\",\"nonce\":\"secret\"}\n",
        );
        let payload = parsed[0].strip_prefix(READY_MARKER).unwrap();
        let ready: SidecarReady = serde_json::from_str(payload).unwrap();
        assert!(validate_ready(&ready, &spawn, "co.stuffbucket.maximal.dev.maximal-1").is_ok());

        let mut invalid = ready;
        invalid.protocol = 2;
        assert!(validate_ready(&invalid, &spawn, "co.stuffbucket.maximal.dev.maximal-1").is_err());
        invalid.protocol = 1;
        invalid.nonce = "wrong".into();
        assert!(validate_ready(&invalid, &spawn, "co.stuffbucket.maximal.dev.maximal-1").is_err());
        invalid.nonce = "secret".into();
        invalid.host = "0.0.0.0".into();
        assert!(validate_ready(&invalid, &spawn, "co.stuffbucket.maximal.dev.maximal-1").is_err());
        invalid.host = "127.0.0.1".into();
        invalid.instance_id = "other".into();
        assert!(validate_ready(&invalid, &spawn, "co.stuffbucket.maximal.dev.maximal-1").is_err());

        invalid.instance_id = "co.stuffbucket.maximal.dev.maximal-1".into();
        let fixed = SpawnGeneration {
            generation: 2,
            requested_port: 4141,
            nonce: "secret".into(),
        };
        assert!(validate_ready(&invalid, &fixed, "co.stuffbucket.maximal.dev.maximal-1").is_err());
    }

    #[test]
    fn persists_the_profile_preferred_port() {
        use super::{read_preferred_port, write_preferred_port};
        let dir = std::env::temp_dir().join(format!("maximal-port-test-{}", super::random_hex()));
        write_preferred_port(&dir, 43210).unwrap();
        assert_eq!(read_preferred_port(&dir), Some(43210));
        std::fs::write(dir.join("sidecar-port"), "0\n").unwrap();
        assert_eq!(read_preferred_port(&dir), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reuses_the_selected_port_for_later_generations() {
        use super::{AppProfile, ManagedEndpoint};
        let endpoints = ManagedEndpoint::new();
        let first = endpoints.begin_generation(AppProfile::Development);
        assert_eq!(first.requested_port, 0);
        assert!(endpoints.activate(first.generation, 43210));
        let second = endpoints.begin_generation(AppProfile::Development);
        assert_eq!(second.requested_port, 43210);
        assert!(!endpoints.activate(first.generation, 43211));
    }

    #[test]
    fn retries_a_persisted_port_only_before_registering_a_capability() {
        use super::{AppProfile, ManagedEndpoint};
        let endpoints = ManagedEndpoint::new();
        endpoints.set_preferred_port(Some(43210));
        let first = endpoints.begin_generation(AppProfile::Development);
        assert_eq!(first.requested_port, 43210);
        assert!(endpoints.prepare_dynamic_retry(first.generation, 43210));
        assert_eq!(
            endpoints
                .begin_generation(AppProfile::Development)
                .requested_port,
            0
        );

        let endpoints = ManagedEndpoint::new();
        endpoints.set_preferred_port(Some(43210));
        let first = endpoints.begin_generation(AppProfile::Development);
        endpoints.mark_capability(43210);
        assert!(!endpoints.prepare_dynamic_retry(first.generation, 43210));
    }

    #[test]
    fn classifies_update_status_payloads() {
        use super::{parse_update_status, UpdateCheck, UpdateSnapshot};
        let available = serde_json::json!({
            "current": "0.4.36", "latest": "0.4.40", "update_available": true,
            "url": "https://mxml.sh/", "enabled": true,
            "checked_at": "2026-10-27T00:00:00.000Z", "last_error": null
        });
        assert_eq!(
            parse_update_status(&available),
            UpdateCheck::Resolved(Some(UpdateSnapshot {
                latest: "0.4.40".into(),
                url: "https://mxml.sh/".into(),
                apt_command: None,
            }))
        );
        // An apt install: the sidecar names the apt command and the Linux guide.
        let apt = serde_json::json!({
            "latest": "0.4.40", "update_available": true,
            "url": "https://example.invalid/linux#update",
            "update_command": "sudo apt update && sudo apt install --only-upgrade maximal maximal-desktop"
        });
        assert_eq!(
            parse_update_status(&apt),
            UpdateCheck::Resolved(Some(UpdateSnapshot {
                latest: "0.4.40".into(),
                url: "https://example.invalid/linux#update".into(),
                apt_command: Some(
                    "sudo apt update && sudo apt install --only-upgrade maximal maximal-desktop"
                        .into()
                ),
            }))
        );
        // No URL in the payload: fall back to the download page root.
        let no_url = serde_json::json!({ "latest": "0.4.40", "update_available": true });
        assert_eq!(
            parse_update_status(&no_url),
            UpdateCheck::Resolved(Some(UpdateSnapshot {
                latest: "0.4.40".into(),
                url: "https://mxml.sh/".into(),
                apt_command: None,
            }))
        );
        let current = serde_json::json!({
            "latest": "0.4.36", "update_available": false, "enabled": true,
            "last_error": null
        });
        assert_eq!(parse_update_status(&current), UpdateCheck::Resolved(None));
        let disabled = serde_json::json!({
            "latest": null, "update_available": false, "enabled": false,
            "last_error": null
        });
        assert_eq!(parse_update_status(&disabled), UpdateCheck::Resolved(None));
        // The sidecar answered but couldn't reach the manifest yet: retry sooner.
        let unresolved = serde_json::json!({
            "latest": null, "update_available": false, "enabled": true,
            "last_error": "network error: offline"
        });
        assert_eq!(parse_update_status(&unresolved), UpdateCheck::Unresolved);
        // A later failure that still knows the latest version is a real answer.
        let stale_ok = serde_json::json!({
            "latest": "0.4.36", "update_available": false, "enabled": true,
            "last_error": "manifest fetch returned HTTP 503"
        });
        assert_eq!(parse_update_status(&stale_ok), UpdateCheck::Resolved(None));
        // "available" without a version is not offerable.
        let no_version = serde_json::json!({ "latest": "", "update_available": true });
        assert_eq!(
            parse_update_status(&no_version),
            UpdateCheck::Resolved(None)
        );
    }

    #[test]
    fn says_what_a_manual_update_check_found() {
        use super::{manual_check_outcome, ManualCheck, UpdateSnapshot};
        let available = serde_json::json!({
            "current": "0.4.36", "latest": "0.4.40", "update_available": true,
            "url": "https://mxml.sh/", "enabled": true, "last_error": null
        });
        assert_eq!(
            manual_check_outcome(Some(&available)),
            ManualCheck::Available(UpdateSnapshot {
                latest: "0.4.40".into(),
                url: "https://mxml.sh/".into(),
                apt_command: None,
            })
        );
        let current = serde_json::json!({
            "current": "0.4.36", "latest": "0.4.36", "update_available": false,
            "enabled": true, "last_error": null
        });
        assert_eq!(
            manual_check_outcome(Some(&current)),
            ManualCheck::UpToDate("0.4.36".into())
        );
        // Checks are off: the sidecar didn't look, so it can't say "up to date".
        let disabled = serde_json::json!({
            "current": "0.4.36", "latest": null, "update_available": false,
            "enabled": false, "last_error": null
        });
        assert_eq!(manual_check_outcome(Some(&disabled)), ManualCheck::Disabled);
        // The manifest couldn't be read.
        let unresolved = serde_json::json!({
            "current": "0.4.36", "latest": null, "update_available": false,
            "enabled": true, "last_error": "network error: offline"
        });
        assert_eq!(manual_check_outcome(Some(&unresolved)), ManualCheck::Failed);
        // A failed fresh check still carries the last known result; the user
        // asked for a fresh one, so it is a failure, not "up to date".
        let stale = serde_json::json!({
            "current": "0.4.36", "latest": "0.4.36", "update_available": false,
            "enabled": true, "last_error": "manifest fetch returned HTTP 503"
        });
        assert_eq!(manual_check_outcome(Some(&stale)), ManualCheck::Failed);
        // The sidecar couldn't be asked at all.
        assert_eq!(manual_check_outcome(None), ManualCheck::Failed);
        // Nothing to name in the notice: don't claim a version.
        let no_current = serde_json::json!({
            "latest": "0.4.36", "update_available": false, "enabled": true
        });
        assert_eq!(manual_check_outcome(Some(&no_current)), ManualCheck::Failed);
    }

    #[test]
    fn asks_for_a_fresh_check_only_when_forced() {
        use super::{update_status_endpoint, SidecarEndpoint};
        let endpoint = SidecarEndpoint {
            generation: 1,
            port: 43210,
        };
        assert_eq!(
            update_status_endpoint(endpoint, false),
            "http://127.0.0.1:43210/settings/api/update-status"
        );
        assert_eq!(
            update_status_endpoint(endpoint, true),
            "http://127.0.0.1:43210/settings/api/update-status?force=1"
        );
    }

    #[test]
    fn dashboard_poll_interval_is_500ms_per_digit_capped_at_a_million() {
        use super::dashboard_poll_interval;
        use std::time::Duration;
        let at = |total: u64| {
            dashboard_poll_interval(&serde_json::json!({ "totals": { "total_tokens": total } }))
        };
        assert_eq!(at(0), Duration::from_millis(500));
        assert_eq!(at(9), Duration::from_millis(500));
        assert_eq!(at(10), Duration::from_millis(1_000));
        assert_eq!(at(999), Duration::from_millis(1_500));
        assert_eq!(at(1_000), Duration::from_millis(2_000));
        assert_eq!(at(999_999), Duration::from_millis(3_000));
        // From a million on: a flat 10 s.
        assert_eq!(at(1_000_000), Duration::from_secs(10));
        assert_eq!(at(1_072_727), Duration::from_secs(10));
        // No totals in the payload (no usage yet): treated as 0.
        assert_eq!(
            dashboard_poll_interval(&serde_json::json!({})),
            Duration::from_millis(500)
        );
    }

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
