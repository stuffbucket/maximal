// Maximal tray + sidecar shell.
//
// Tauri 2 menu-bar app. On launch we:
//   1. Mark state Starting and install the tray immediately — the
//      menubar must be reachable before the sidecar is ready, so the
//      user always has a Quit affordance.
//   2. Spawn the bundled `maximal` binary as a sidecar — it serves
//      the proxy on http://localhost:4142 (see SIDECAR_PORT below).
//   3. Poll http://127.0.0.1:4142/setup-status every 300ms until the
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
// /usage-viewer endpoint is reachable directly via the browser, and
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
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    ipc::Channel,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// The shelled sidecar binds 4142, not the CLI's default 4141. Lets
// the spike coexist with a hand-installed `maximal start` already
// listening on 4141 (the friendly EADDRINUSE detection in
// src/start.ts otherwise kills the sidecar before it can serve).
// Production Phase E will probably restore 4141 as the canonical
// port and assume the tray app is the only supervisor.
const SIDECAR_PORT: u16 = 4142;

/// How often `subscribe_token_usage` GETs `/token-usage` from the
/// sidecar. Each iteration also probes the `Channel<TokenUsageEvent>`
/// — when the JS side drops the channel, the next `send` returns Err
/// and the loop exits cleanly.
const DASHBOARD_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Allowed values for the dashboard's `period` query parameter.
/// Anything else from the webview is clamped to "day".
const DASHBOARD_PERIODS: &[&str] = &["day", "week", "month"];

const TRAY_ID: &str = "main";
// Two webview windows, both pointed at the sidecar:
//   settings  — http://localhost:4142/settings (config UI bundled in Tauri)
//   dashboard — http://localhost:4142/usage-viewer (usage charts; html
//               embedded directly into the sidecar binary via Bun import
//               attributes — see src/server.ts).
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
        //     confirm dialog) so the second process can claim :4142.
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
        .manage(Sidecar::new())
        .manage(AppStatus::new())
        .manage(ShellApiKey::new())
        .invoke_handler(tauri::generate_handler![
            open_settings_at,
            open_dashboard,
            reveal_config_dir,
            reveal_logs_dir,
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

    app.run(|app_handle, event| {
        // Sole sidecar-kill site. The tray "Quit" item just calls
        // `app.exit(0)`, which routes through ExitRequested.
        if let RunEvent::ExitRequested { .. } = event {
            kill_sidecar(app_handle);
        }
    });
}

/// Walk up from the current executable (and the CWD as a backstop)
/// looking for `shell/dist/index.html`. Used in `tauri dev` where
/// Tauri does not materialise the `resources` mapping. Returns the
/// absolute path of the dist directory or None.
fn locate_dev_settings_dist() -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    for mut dir in roots {
        for _ in 0..8 {
            let candidate = dir.join("shell").join("dist");
            if candidate.join("index.html").exists() {
                return Some(candidate);
            }
            if !dir.pop() {
                break;
            }
        }
    }
    None
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
        .args(["start", "--port", port.as_str()]);

    // Packaged builds: tell the proxy to skip its dev-mode Vite
    // reverse-proxy and serve the bundled settings UI from
    // <resource_dir>/settings-dist (mapped in tauri.conf.json from
    // ../dist to avoid the `_up_` escape Tauri applies to `..`).
    // The route also checks for a real dist directory as a backstop,
    // but setting NODE_ENV=production removes any ambiguity inside
    // a Tauri-launched sidecar.
    cmd = cmd.env("NODE_ENV", "production");
    // Hand the shell's PID to the sidecar for its parent-death
    // watchdog. If the tray app is force-killed (Activity Monitor,
    // OOM, panic past Drop), the sidecar polls this PID and exits
    // when it disappears so we don't orphan a proxy on :4142.
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
    let mut dist_set = false;
    if let Ok(resource_dir) = app.path().resource_dir() {
        let settings_dist = resource_dir.join("settings-dist");
        if settings_dist.exists() {
            cmd = cmd.env(
                "MAXIMAL_SETTINGS_DIST",
                settings_dist.to_string_lossy().to_string(),
            );
            dist_set = true;
        }
    }
    // `tauri dev` doesn't materialise the `resources` mapping from
    // tauri.conf.json — that's a bundler step. So the resource_dir
    // lookup above misses, and the Bun-compiled sidecar can't walk
    // for `shell/dist/` either (its `import.meta.dir` resolves into
    // the embedded `$bunfs` virtual FS, not the host disk). Without
    // an explicit pointer, every request to /settings would 503 from
    // the dev-mode Vite fallback. Walk a few likely dev locations
    // relative to the current exe and the cwd as a safety net.
    if !dist_set {
        if let Some(dir) = locate_dev_settings_dist() {
            eprintln!("[shell] using dev settings-dist: {}", dir.display());
            cmd = cmd.env("MAXIMAL_SETTINGS_DIST", dir.to_string_lossy().to_string());
        } else {
            eprintln!(
                "[shell] WARNING: no settings-dist found; sidecar will 503 on /settings"
            );
        }
    }

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| tauri::Error::Anyhow(e.into()))?;

    app.state::<Sidecar>().set(child);

    let handle = app.clone();
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
                    // If the sidecar died, flip to Failed so the user
                    // sees something actionable in the tray. (We don't
                    // distinguish clean-exit-during-quit here because
                    // ExitRequested has already fired the kill path.)
                    apply_state(&handle, SidecarState::Failed);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
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

        // Stash the child back so the escalation task can decide
        // whether it still needs SIGKILL. If the sidecar exits
        // cleanly within 3s, the child handle goes out of scope here
        // and that's fine — killing an already-exited child is a
        // harmless no-op.
        app.state::<Sidecar>().set(child);

        // Plain OS thread for the 3s grace timer rather than pulling
        // a tokio runtime in for this single sleep. AppHandle::clone()
        // is Arc-cheap.
        let app_handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            if let Some(child) = app_handle.state::<Sidecar>().take() {
                // Still alive (or at least, still in our slot) after
                // the grace period — escalate to SIGKILL.
                let _ = child.kill();
            }
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
        // A single failed poll during phase 2 is ignored — the proxy
        // might be momentarily busy. We only flip to Failed via the
        // sidecar's Terminated event.
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
fn apply_state(app: &AppHandle, next: SidecarState) {
    let changed = app.state::<AppStatus>().set(next).is_some();
    if !changed {
        return;
    }
    if let Err(err) = refresh_tray(app, next) {
        eprintln!("[shell] tray refresh failed: {err}");
    }
}

fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, SidecarState::Starting)?;
    let icon = icon_for(SidecarState::Starting)?;

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
    let menu = build_menu(app, state)?;
    tray.set_menu(Some(menu))?;
    tray.set_icon(Some(icon_for(state)?))?;
    tray.set_tooltip(Some(tooltip_for(state)))?;
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

fn icon_for(state: SidecarState) -> tauri::Result<Image<'static>> {
    let bytes = match state {
        SidecarState::Starting => TRAY_ICON_STARTING,
        SidecarState::RunningUnauthenticated => TRAY_ICON_ATTENTION,
        SidecarState::RunningAuthenticated => TRAY_ICON_NORMAL,
        // Failed/Stopped reuse the "starting" dimmed look; the menu
        // text makes the actual problem clear.
        SidecarState::Failed | SidecarState::Stopped => TRAY_ICON_STARTING,
    };
    Ok(Image::from_bytes(bytes)?.to_owned())
}

fn tooltip_for(state: SidecarState) -> &'static str {
    match state {
        SidecarState::Starting => "maximal — starting…",
        SidecarState::RunningUnauthenticated => "maximal — sign in to GitHub",
        SidecarState::RunningAuthenticated => "maximal",
        SidecarState::Failed => "maximal — sidecar failed",
        SidecarState::Stopped => "maximal — stopped",
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
            Menu::with_items(
                app,
                &[
                    &sign_in,
                    &sep1,
                    &dashboard_item,
                    &settings_item,
                    &sep2,
                    &quit_item,
                ],
            )
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
            Menu::with_items(
                app,
                &[
                    &info,
                    &sep1,
                    &dashboard_item,
                    &settings_item,
                    &sep2,
                    &quit_item,
                ],
            )
        }
        SidecarState::Failed | SidecarState::Stopped => {
            let failed = MenuItem::with_id(
                app,
                menu_id::FAILED,
                "Sidecar failed to start",
                false,
                None::<&str>,
            )?;
            let show_logs = MenuItem::with_id(
                app,
                menu_id::SHOW_LOGS,
                "Show logs…",
                true,
                None::<&str>,
            )?;
            Menu::with_items(
                app,
                &[&failed, &show_logs, &sep1, &settings_item, &quit_item],
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
        menu_id::QUIT => request_quit(app),
        _ => {}
    }
}

/// Opens (or focuses) the dashboard webview pointed at the sidecar's
/// settings page. The optional `section` becomes a URL fragment so the
/// frontend can scroll to / select that section.
fn open_settings_window(app: &AppHandle, section: Option<&str>) {
    // In debug builds the `beforeDevCommand` in tauri.conf.json starts
    // Vite on :1420, so we point the webview directly at it. That
    // gives us native HMR (no proxy WebSocket gymnastics) and exposes
    // vite-plugin-inspect at /settings/__inspect/. Release builds use
    // the sidecar's bundled `/settings` route on :4142, which serves
    // the pre-built dist statically.
    let settings_origin = if cfg!(debug_assertions) {
        "http://localhost:1420".to_string()
    } else {
        format!("http://localhost:{SIDECAR_PORT}")
    };
    let url_string = match section {
        Some(s) => format!("{settings_origin}/settings/#{s}"),
        None => format!("{settings_origin}/settings/"),
    };
    let url = match url::Url::parse(&url_string) {
        Ok(u) => u,
        Err(err) => {
            eprintln!("[shell] bad settings URL: {err}");
            return;
        }
    };

    if let Some(existing) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        let _ = existing.show();
        let _ = existing.set_focus();
        // Navigation via re-creation is the simplest cross-platform
        // path; eval'ing window.location is fiddly with CSP-null.
        // Cheap on macOS — the webview process is reused.
        if let Err(err) = existing.navigate(url) {
            eprintln!("[shell] settings navigate failed: {err}");
        }
        update_activation_policy(app);
        return;
    }

    let builder = WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW_LABEL,
        WebviewUrl::External(url),
    )
    .title("Maximal — Settings")
    .inner_size(900.0, 640.0)
    .min_inner_size(600.0, 480.0);

    match builder.build() {
        Ok(window) => {
            attach_hide_on_close(app, &window);
            update_activation_policy(app);
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
/// sidecar's `/usage-viewer` endpoint. The HTML + vendored JS for the
/// dashboard are embedded directly into the sidecar binary via Bun's
/// import-attribute file loader (see src/server.ts), so the dashboard
/// ships inside the Tauri bundle with no extra resource staging.
fn open_dashboard_window(app: &AppHandle) {
    let url_string = format!(
        "http://localhost:{SIDECAR_PORT}/usage-viewer\
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
        let _ = existing.show();
        let _ = existing.set_focus();
        update_activation_policy(app);
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
            update_activation_policy(app);
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
#[cfg(target_os = "macos")]
fn update_activation_policy(app: &AppHandle) {
    let labels = [SETTINGS_WINDOW_LABEL, DASHBOARD_WINDOW_LABEL];
    let any_visible = labels.iter().any(|label| {
        app.get_webview_window(label)
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false)
    });
    let next = if any_visible {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    };
    if let Err(err) = app.set_activation_policy(next) {
        eprintln!("[shell] set_activation_policy failed: {err}");
    }
    // Re-apply the Dock icon in debug builds only. AppKit re-resolves
    // NSApplication.applicationIconImage on Accessory → Regular
    // transitions; without this re-apply, a `cargo run` dev binary
    // falls back to the generic "exec" icon (no Info.plist
    // CFBundleIconFile exists). In release the bundle handles this.
    #[cfg(debug_assertions)]
    if any_visible {
        set_dock_icon();
    }
}

#[cfg(not(target_os = "macos"))]
fn update_activation_policy(_app: &AppHandle) {}

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
/// to release :4142, so prompting them would just be in the way.
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
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            update_activation_policy(app);
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

