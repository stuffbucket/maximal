use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::native_i18n;
use crate::state::{
    AppStatus, LastRejection, LastSidecarError, LocaleState, RejectionSnapshot,
    RejectionTransition, SetupPromptShown, SetupStatusResponse, ShellApiKey, Sidecar,
    SidecarRestarting, SidecarState, StartupAnnounced,
};
use crate::tray::refresh_tray;
use crate::updater::check_for_update;
use crate::windows::{dismiss_splash, open_settings_window, SPLASH_MIN_DISPLAY};
use crate::SIDECAR_PORT;

/// Prefix the sidecar prints (stdout) for structured boot-status lines we
/// relay to the splash. MUST match `BOOT_STATUS_MARKER` in src/start.ts.
const BOOT_STATUS_MARKER: &str = "@@MAXIMAL_STATUS@@";

/// How often the phase-2 poll re-checks for a newer release. Generous on
/// purpose — releases are rare and the sidecar caches the upstream lookup for
/// hours — but finite so a long-running menu-bar session still notices a
/// release published after launch. Aligns with the sidecar's cache TTL.
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// One-shot GET of `/token-usage?period=…` against the local sidecar.
/// Returns the parsed JSON body on 2xx, an error string otherwise.
pub(crate) async fn fetch_token_usage(
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

pub(crate) fn spawn_sidecar(app: &AppHandle) -> tauri::Result<()> {
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
                        if let Some(msg) = raw.trim().strip_prefix(BOOT_STATUS_MARKER) {
                            let _ =
                                handle.emit_to("splash", "splash:status", msg.trim().to_string());
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

/// Run `maximal app claude-code --disable` as a one-shot sidecar
/// command. Called when the proxy sidecar *crashes* (non-zero exit) — it
/// can't revert its own Claude Code base URL in that path, so the shell
/// does it. Best-effort: a missing binary or non-zero exit is logged and
/// swallowed (the worst case is a stranded base URL the next clean boot
/// re-applies or the user toggles off). Fire-and-forget on a Tokio task so
/// the Terminated handler stays synchronous.
fn reconcile_claude_code_revert(app: &AppHandle) {
    let command = match app.shell().sidecar("maximal") {
        Ok(c) => c.args(["app", "claude-code", "--disable"]),
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
pub(crate) fn extract_error_reason(chunk: &str) -> Option<String> {
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
pub(crate) fn kill_sidecar(app: &AppHandle) {
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
}

/// Polls the sidecar's /setup-status endpoint, driving SidecarState
/// transitions. First successful response within 30s flips Starting to
/// Running{Un,}Authenticated; after that, slower 5s polling watches
/// for auth changes initiated from Settings.
pub(crate) async fn poll_sidecar_status(app: AppHandle) {
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
    let startup_deadline = std::time::Instant::now() + Duration::from_secs(30);
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
    let auth_status_url =
        format!("http://127.0.0.1:{SIDECAR_PORT}/settings/api/auth/github/status",);
    let update_status_url = format!("http://127.0.0.1:{SIDECAR_PORT}/settings/api/update-status",);
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
        if let Some(rejection) = fetch_rejection(&app, &client, &auth_status_url).await {
            apply_rejection(&app, rejection);
        }
        let update_due = last_update_check.is_none_or(|t| t.elapsed() >= UPDATE_CHECK_INTERVAL);
        if update_due && check_for_update(&app, &client, &update_status_url).await {
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

/// Applies a fetched rejection snapshot to the LastRejection managed
/// state. On state-entering transitions, fires a single OS notification.
/// On any change (entered, cleared, or content change), refreshes the
/// tray so the icon and tooltip reflect the new condition.
fn apply_rejection(app: &AppHandle, next: Option<RejectionSnapshot>) {
    let entered_message = next.as_ref().map(|r| r.message.clone()).unwrap_or_default();
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
    let locale = app.state::<LocaleState>().get();
    let title = native_i18n::tr(&locale, "native-notify-rejection-title");
    let body = if message.is_empty() {
        native_i18n::tr(&locale, "native-notify-rejection-body")
    } else {
        native_i18n::t(
            &locale,
            "native-notify-rejection-body-detail",
            &[("message", message)],
        )
    };
    if let Err(err) = app.notification().builder().title(title).body(body).show() {
        eprintln!("[shell] rejection notification failed: {err}");
    }
}

async fn fetch_setup_status(client: &reqwest::Client, url: &str) -> Option<SetupStatusResponse> {
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
pub(crate) fn apply_state(app: &AppHandle, next: SidecarState) {
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
        if prev == SidecarState::Starting && app.state::<SetupPromptShown>().claim() {
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
    let locale = app.state::<LocaleState>().get();
    let body = match reason {
        Some(r) if !r.is_empty() => native_i18n::t(
            &locale,
            "native-notify-failed-body-reason",
            &[("reason", r)],
        ),
        _ => native_i18n::tr(&locale, "native-notify-failed-body"),
    };
    if let Err(err) = app
        .notification()
        .builder()
        .title(native_i18n::tr(&locale, "native-notify-failed-title"))
        .body(body)
        .show()
    {
        eprintln!("[shell] failed-start notification error: {err}");
    }
}

/// One-shot "we're up" notification so users who launched from Finder
/// know it's running and where to find it (menu bar, not Dock). Same
/// best-effort caveats as `fire_rejection_notification`: a permission
/// denial or a dev (`cargo run`) no-op must not matter.
fn fire_startup_notification(app: &AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    let locale = app.state::<LocaleState>().get();
    // Where the icon lives — and which way to point — is platform-specific:
    // macOS puts it in the top menu bar (↑); Windows/Linux put it in the
    // system tray (↓). Each catalog bakes both the container noun and the
    // arrow into its own per-OS key, so we just pick the key by target_os.
    let body_key = if cfg!(target_os = "macos") {
        "native-notify-startup-body-macos"
    } else {
        "native-notify-startup-body-other"
    };
    if let Err(err) = app
        .notification()
        .builder()
        .title(native_i18n::tr(&locale, "native-notify-startup-title"))
        .body(native_i18n::tr(&locale, body_key))
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
    let locale = app.state::<LocaleState>().get();
    if let Err(err) = app
        .notification()
        .builder()
        .title(native_i18n::tr(&locale, "native-notify-signin-title"))
        .body(native_i18n::tr(&locale, "native-notify-signin-body"))
        .show()
    {
        eprintln!("[shell] sign-in notification failed: {err}");
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
pub(crate) fn retry_startup(app: &AppHandle) {
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
pub(crate) fn respawn_sidecar(app: &AppHandle) {
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
