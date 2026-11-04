// Maximal tray + sidecar shell.
//
// Tauri 2 menu-bar app. On launch we:
//   1. Mark state Starting and install the tray immediately — the
//      menubar must be reachable before the sidecar is ready, so the
//      user always has a Quit affordance.
//   2. Spawn the bundled `maximal` binary as a sidecar — production requests
//      :4141; development/test ask the kernel for a profile-stable free port.
//   3. Validate its nonce-bound ready line, register that exact remote origin,
//      then poll its /setup-status every 300ms. The first response
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
// macOS remains a menu-bar app whose Dock icon follows window visibility:
//   * Launch                        → ActivationPolicy::Accessory  (no Dock)
//   * Any Settings/Dashboard shown → ActivationPolicy::Regular    (Dock on)
//   * Last one hidden              → ActivationPolicy::Accessory
// Closing a managed window hides it on macOS/Linux. Windows follows the normal
// desktop contract instead: X starts bounded sidecar/configurator shutdown and
// then quits the shell. `update_activation_policy` owns Dock/taskbar presence
// for the surviving close-to-background platforms and window show paths.
//
// Quit flow:
//   1. Tray "Quit Maximal" and Windows X ask for confirmation.
//   2. `exit_gracefully` claims the one-shot exit guard. Windows waits for
//      graceful sidecar cleanup before `app.exit(0)`; other platforms exit.
//   3. RunEvent::ExitRequested performs final sidecar process containment.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{
    image::Image,
    ipc::Channel,
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    utils::config::{AppDirectoriesOverride, AppDirectoryOverrides},
    webview::PageLoadEvent,
    AppHandle, Emitter, LogicalSize, LogicalUnit, Manager, PhysicalPosition, PhysicalRect,
    PhysicalSize, PixelUnit, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent, WindowSizeConstraints,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_window_state::{StateFlags, WindowExt};

/// Native-string i18n (tray, notifications, window titles, quit dialog),
/// backed by the same shell/src/i18n/*.json catalogs the webview renders with.
mod native_i18n;
mod sidecar_runtime;
#[cfg(target_os = "windows")]
mod windows_jump_list;

use sidecar_runtime::{
    begin_exit, extract_error_reason, fetch_rejection, fetch_setup_status,
    fetch_update_payload, kill_sidecar, manual_check_outcome, parse_update_status,
    profile_data_override, read_preferred_port, runtime_event_channel, spawn_sidecar,
    update_status_endpoint, AppDataDir, AppProfile, AppStatus, LastRejection, LastSidecarError,
    LatestUpdate, ManagedEndpoint, ManualCheck, RejectionSnapshot, RejectionTransition,
    RuntimeEvent, RuntimeExiting,
    SetupStatusResponse, ShellApiKey, Sidecar, SidecarEndpoint, SidecarFailureStop, SidecarHandoff,
    SidecarRestarting, SidecarState, TokenUsageEvent, UpdateCheck, UpdateSnapshot,
    DASHBOARD_WINDOW_LABEL, LOOPBACK_HOST, SETTINGS_WINDOW_LABEL, UPDATE_PAGE_URL,
};

/// Brand-minimum time the splash stays on screen once the sidecar reaches a
/// Running state, before it fades. The state-aware dismiss loop in
/// `create_splash` enforces this, and the first-run Settings auto-open
/// (`apply_state`) defers to it so Settings doesn't race up over the splash.
const SPLASH_MIN_DISPLAY: Duration = Duration::from_millis(1600);

/// How often the phase-2 poll re-checks for a newer release. Generous on
/// purpose — releases are rare and the sidecar caches the upstream lookup for
/// hours — but finite so a long-running menu-bar session still notices a
/// release published after launch. Aligns with the sidecar's cache TTL.
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// How soon to re-check when the sidecar answered but couldn't resolve a
/// version yet (offline at launch, a CDN blip). Without this, a failed first
/// check would hide an available update for the full interval. Matches the
/// CDN's `max-age` for the manifest.
const UPDATE_RETRY_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// How long a user-asked update check waits for the sidecar, which fetches the
/// manifest itself (up to its own 15 s timeout). The poll's 2 s is too short.
const UPDATE_FORCE_TIMEOUT: Duration = Duration::from_secs(20);

/// Event the shell sends the Settings window after it ran an update check, so
/// the topbar button and Diagnostics rows re-read the status right away.
const UPDATE_STATUS_EVENT: &str = "update:status";
#[cfg(target_os = "windows")]
const QUIT_REQUESTED_EVENT: &str = "app://quit-requested";
#[cfg(target_os = "windows")]
const QUIT_REQUESTED_DOM_EVENT_SCRIPT: &str =
    "window.dispatchEvent(new CustomEvent('maximal:quit-requested'));";

/// Whether "Update to X.Y.Z" installs the update in place (download the
/// signed update, install, relaunch) on this platform: Windows (the NSIS
/// installer) and macOS (the `.app` bundle, signed by stuffbucket/macos-builder
/// with the same key). The updater plugin is registered only when this is
/// true. Even then a macOS app that can't replace itself (see
/// `bundle_location_problem`) opens the download page instead.
const IN_PLACE_UPDATE: bool = cfg!(any(target_os = "windows", target_os = "macos"));

/// The Settings section that shows an apt install's update command (the
/// Debian/Ubuntu packages update with apt, never in place).
const APT_UPDATE_SECTION: &str = "diagnostics";

/// Where the desktop updater manifests live: `<base><channel>.json`, in
/// Tauri's static JSON format, published by the release `manifest` job next to
/// /updates/manifest.json. The check never contacts github.com; only the
/// installer download it names may.
const DESKTOP_UPDATE_MANIFEST_BASE: &str = "https://mxml.sh/updates/desktop/";

/// How long the in-place updater waits for the desktop manifest.
const UPDATE_MANIFEST_TIMEOUT: Duration = Duration::from_secs(30);

const TRAY_ID: &str = "main";
// One unified webview window points at the Settings shell. Dashboard and Sessions
// are sidecar-served pages mounted in its persistent HTML iframe. The main window
// label is referenced from capabilities/default.json `windows`.
mod main_surface {
    pub const SETTINGS: &str = "settings";
    pub const DASHBOARD: &str = "dashboard";
    pub const SESSIONS: &str = "sessions";
}

const MAIN_WINDOW_FALLBACK_WIDTH: f64 = 1100.0;
const MAIN_WINDOW_FALLBACK_HEIGHT: f64 = 720.0;
const MAIN_WINDOW_MIN_WIDTH: f64 = 640.0;
const MAIN_WINDOW_MIN_HEIGHT: f64 = 480.0;
/// Keeps all five Settings tabs ahead of the pinned utilities with the topbar's
/// reserved end gap. Observability surfaces use the smaller shared minimum.
const SETTINGS_SURFACE_MIN_WIDTH: f64 = 736.0;
/// Settings has a bounded readable layout. Observability surfaces explicitly
/// remove this width constraint because their tables and graphs use extra room.
const SETTINGS_SURFACE_MAX_WIDTH: f64 = 1100.0;
/// Total breathing room kept around the window on a small display.
const MAIN_WINDOW_WORK_AREA_MARGIN: f64 = 64.0;

fn main_window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

fn main_window_min_width(surface: &str) -> f64 {
    if surface == main_surface::SETTINGS {
        SETTINGS_SURFACE_MIN_WIDTH
    } else {
        MAIN_WINDOW_MIN_WIDTH
    }
}

fn main_window_constraints(surface: &str) -> WindowSizeConstraints {
    WindowSizeConstraints {
        min_width: Some(PixelUnit::Logical(LogicalUnit::new(main_window_min_width(
            surface,
        )))),
        min_height: Some(PixelUnit::Logical(LogicalUnit::new(MAIN_WINDOW_MIN_HEIGHT))),
        max_width: (surface == main_surface::SETTINGS)
            .then(|| PixelUnit::Logical(LogicalUnit::new(SETTINGS_SURFACE_MAX_WIDTH))),
        max_height: None,
    }
}

fn fitted_main_window_inner_size(
    work_area_size: PhysicalSize<u32>,
    scale_factor: f64,
    frame_size: PhysicalSize<u32>,
) -> PhysicalSize<u32> {
    let fallback = LogicalSize::new(MAIN_WINDOW_FALLBACK_WIDTH, MAIN_WINDOW_FALLBACK_HEIGHT)
        .to_physical::<u32>(scale_factor);
    let margin = LogicalSize::new(MAIN_WINDOW_WORK_AREA_MARGIN, MAIN_WINDOW_WORK_AREA_MARGIN)
        .to_physical::<u32>(scale_factor);
    let available_outer = PhysicalSize::new(
        work_area_size.width.saturating_sub(margin.width),
        work_area_size.height.saturating_sub(margin.height),
    );
    let available_inner = PhysicalSize::new(
        available_outer.width.saturating_sub(frame_size.width),
        available_outer.height.saturating_sub(frame_size.height),
    );

    PhysicalSize::new(
        fallback.width.min(available_inner.width),
        fallback.height.min(available_inner.height),
    )
}

fn outer_size_for_inner(
    inner_size: PhysicalSize<u32>,
    frame_size: PhysicalSize<u32>,
) -> PhysicalSize<u32> {
    PhysicalSize::new(
        inner_size.width.saturating_add(frame_size.width),
        inner_size.height.saturating_add(frame_size.height),
    )
}

fn centered_main_window_position(
    outer_size: PhysicalSize<u32>,
    work_area: &PhysicalRect<i32, u32>,
) -> PhysicalPosition<i32> {
    PhysicalPosition::new(
        work_area.position.x + (work_area.size.width.saturating_sub(outer_size.width) / 2) as i32,
        work_area.position.y + (work_area.size.height.saturating_sub(outer_size.height) / 2) as i32,
    )
}

fn clamp_main_window_position(
    position: PhysicalPosition<i32>,
    outer_size: PhysicalSize<u32>,
    work_area: &PhysicalRect<i32, u32>,
) -> PhysicalPosition<i32> {
    fn clamp_axis(position: i32, origin: i32, available: u32, occupied: u32) -> i32 {
        let lower = i64::from(origin);
        let upper = lower + i64::from(available.saturating_sub(occupied));
        i64::from(position).clamp(lower, upper) as i32
    }

    PhysicalPosition::new(
        clamp_axis(
            position.x,
            work_area.position.x,
            work_area.size.width,
            outer_size.width,
        ),
        clamp_axis(
            position.y,
            work_area.position.y,
            work_area.size.height,
            outer_size.height,
        ),
    )
}

/// The window-state plugin stores physical inner dimensions without monitor or
/// scale metadata. After an explicit restore, repair a normal window whose saved
/// inner size no longer fits the current physical work area. Position math uses
/// the outer frame; size setters continue to receive inner dimensions.
fn normalize_restored_main_window_geometry(window: &WebviewWindow) -> tauri::Result<()> {
    if window.is_maximized()? {
        return Ok(());
    }

    let monitor = window.current_monitor()?.or(window.primary_monitor()?);
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let work_area = monitor.work_area();
    let inner_size = window.inner_size()?;
    let outer_size = window.outer_size()?;
    let frame_size = PhysicalSize::new(
        outer_size.width.saturating_sub(inner_size.width),
        outer_size.height.saturating_sub(inner_size.height),
    );
    let margin = LogicalSize::new(MAIN_WINDOW_WORK_AREA_MARGIN, MAIN_WINDOW_WORK_AREA_MARGIN)
        .to_physical::<u32>(monitor.scale_factor());
    let available_outer = PhysicalSize::new(
        work_area.size.width.saturating_sub(margin.width),
        work_area.size.height.saturating_sub(margin.height),
    );
    let available_inner = PhysicalSize::new(
        available_outer.width.saturating_sub(frame_size.width),
        available_outer.height.saturating_sub(frame_size.height),
    );

    if inner_size.width > available_inner.width || inner_size.height > available_inner.height {
        let fitted =
            fitted_main_window_inner_size(work_area.size, monitor.scale_factor(), frame_size);
        let fitted_outer = outer_size_for_inner(fitted, frame_size);
        window.set_size(fitted)?;
        window.set_position(centered_main_window_position(fitted_outer, work_area))?;
        return Ok(());
    }

    let position = window.outer_position()?;
    let clamped = clamp_main_window_position(position, outer_size, work_area);
    if clamped != position {
        window.set_position(clamped)?;
    }
    Ok(())
}

fn apply_main_surface_constraints(window: &WebviewWindow, surface: &str) -> tauri::Result<()> {
    // Mutating native constraints while maximized unmaximizes the window on
    // Windows and can resize its zoomed frame on macOS. MainSurfaceState keeps
    // the requested policy pending until the next normal-size event.
    if window.is_maximized()? {
        return Ok(());
    }
    window.set_size_constraints(main_window_constraints(surface))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MainWindowPresentation {
    Foreground,
    #[cfg(target_os = "windows")]
    WindowsStartupMinimized,
}

/// The plugin's window-ready hook is queued before this barrier. Once that hook
/// has installed its state tracking, restore from a blocking worker so Tauri's
/// synchronous window getters can be serviced by the main event loop. Holding
/// the plugin cache on the window-creation thread while its hook runs would
/// otherwise deadlock the cache and event loop against each other.
fn restore_main_window(
    app: &AppHandle,
    window: &WebviewWindow,
    presentation: MainWindowPresentation,
) {
    let app_after_barrier = app.clone();
    let window_after_barrier = window.clone();
    let queue_result = window.run_on_main_thread(move || {
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = window_after_barrier.restore_state(main_window_state_flags()) {
                eprintln!("[shell] could not restore main window geometry: {error}");
            }
            if let Err(error) = normalize_restored_main_window_geometry(&window_after_barrier) {
                eprintln!("[shell] could not normalize main window geometry: {error}");
            }

            let app_for_present = app_after_barrier.clone();
            let window_for_present = window_after_barrier.clone();
            if let Err(error) = window_after_barrier.run_on_main_thread(move || {
                attach_main_window_behavior(&app_for_present, &window_for_present);
                let surface = app_for_present.state::<MainSurfaceState>().get();
                if let Err(error) = apply_main_surface_constraints(&window_for_present, &surface) {
                    eprintln!("[shell] could not apply main window constraints: {error}");
                }
                match presentation {
                    MainWindowPresentation::Foreground => {
                        present_window(&app_for_present, &window_for_present);
                    }
                    #[cfg(target_os = "windows")]
                    MainWindowPresentation::WindowsStartupMinimized => {
                        // An explicit action may have presented the window while
                        // geometry restoration ran. Never minimize it again.
                        if !window_for_present.is_visible().unwrap_or(false) {
                            show_windows_startup_window(&app_for_present, &window_for_present);
                        }
                    }
                }
            }) {
                eprintln!("[shell] could not queue main window presentation: {error}");
            }
        });
    });
    if let Err(error) = queue_result {
        eprintln!("[shell] could not queue main window restoration: {error}");
    }
}

// Tray icon assets are embedded so native chrome never depends on a runtime
// resource path. macOS gets black-and-alpha template artwork and AppKit supplies
// the menu-bar color for the current appearance/highlight state. Windows keeps
// full-color artwork with a substantial crimson silhouette; its notification
// area does not recolor icons, so the former white signed-out mark disappeared
// on a light taskbar. The @2x source also scales cleanly on high-DPI displays.
#[cfg(target_os = "macos")]
const TRAY_ICON_NORMAL: &[u8] = include_bytes!("../icons/tray/macos/icon@2x.png");
#[cfg(not(target_os = "macos"))]
const TRAY_ICON_NORMAL: &[u8] = include_bytes!("../icons/tray/icon@2x.png");
#[cfg(target_os = "macos")]
const TRAY_ICON_STARTING: &[u8] = include_bytes!("../icons/tray/macos/icon-starting@2x.png");
#[cfg(not(target_os = "macos"))]
const TRAY_ICON_STARTING: &[u8] = include_bytes!("../icons/tray/icon-starting@2x.png");
#[cfg(target_os = "macos")]
const TRAY_ICON_ATTENTION: &[u8] = include_bytes!("../icons/tray/macos/icon-attention@2x.png");
#[cfg(target_os = "windows")]
const TRAY_ICON_ATTENTION: &[u8] = include_bytes!("../icons/tray/windows/icon-attention@2x.png");
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const TRAY_ICON_ATTENTION: &[u8] = include_bytes!("../icons/tray/icon-attention@2x.png");

mod menu_id {
    #[cfg(target_os = "macos")]
    pub const ABOUT: &str = "about_maximal";
    pub const SETTINGS: &str = "settings";
    pub const DASHBOARD: &str = "dashboard";
    pub const SESSIONS: &str = "sessions";
    pub const QUIT: &str = "quit";
    pub const SIGN_IN: &str = "sign_in";
    pub const ACCOUNT_INFO: &str = "account_info";
    pub const STARTING: &str = "starting";
    pub const FAILED: &str = "failed";
    pub const SHOW_LOGS: &str = "show_logs";
    pub const RETRY: &str = "retry";
    pub const OPEN_CONFIG: &str = "open_config";
    pub const UPGRADE: &str = "upgrade";
    pub const CHECK_UPDATES: &str = "check_updates";
}

const SHELL_ACTION_PREFIX: &str = "--maximal-action=";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShellAction {
    OpenDefault,
    About,
    Settings,
    Dashboard,
    Sessions,
    CheckUpdates,
    ShowLogs,
    OpenConfig,
}

impl ShellAction {
    fn from_value(value: &str) -> Option<Self> {
        match value {
            "about" => Some(Self::About),
            "settings" => Some(Self::Settings),
            "dashboard" => Some(Self::Dashboard),
            "sessions" => Some(Self::Sessions),
            "check-updates" => Some(Self::CheckUpdates),
            "show-logs" => Some(Self::ShowLogs),
            "open-config" => Some(Self::OpenConfig),
            _ => None,
        }
    }

    #[cfg(any(target_os = "windows", test))]
    fn argument(self) -> Option<&'static str> {
        match self {
            Self::OpenDefault => None,
            Self::About => Some("--maximal-action=about"),
            Self::Settings => Some("--maximal-action=settings"),
            Self::Dashboard => Some("--maximal-action=dashboard"),
            Self::Sessions => Some("--maximal-action=sessions"),
            Self::CheckUpdates => Some("--maximal-action=check-updates"),
            Self::ShowLogs => Some("--maximal-action=show-logs"),
            Self::OpenConfig => Some("--maximal-action=open-config"),
        }
    }
}

fn shell_action_from_args<I, S>(args: I) -> Option<ShellAction>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut found = None;
    for arg in args {
        let Some(value) = arg.as_ref().strip_prefix(SHELL_ACTION_PREFIX) else {
            continue;
        };
        let action = ShellAction::from_value(value)?;
        if found.replace(action).is_some() {
            return None;
        }
    }
    found
}

/// Where Settings should open when the user reaches for the app without
/// saying where: sign-in, when it's needed.
fn default_settings_section(app: &AppHandle) -> Option<&'static str> {
    if app.state::<AppStatus>().get() == SidecarState::RunningUnauthenticated {
        Some("account")
    } else {
        None
    }
}

/// Set while an in-place update is running (from the confirm until the
/// installer takes over, or the attempt ends), so a second click on the
/// button or the tray item can't start another one.
struct UpdateInstall(std::sync::atomic::AtomicBool);

impl UpdateInstall {
    fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }

    /// Returns true if this caller may run an update (none was running).
    fn claim(&self) -> bool {
        !self.0.swap(true, std::sync::atomic::Ordering::SeqCst)
    }

    fn release(&self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The active native-UI locale (BCP-47 tag), behind a Mutex because the
/// `set_locale` command (main thread) and the tray / notification paths
/// (Tokio tasks) both read it. Seeded at setup from the persisted picker
/// choice or the OS locale (see `native_i18n::resolve_locale`); updated live
/// by `set_locale` when the user changes the in-app picker so the tray menu,
/// window titles, and later notifications follow the chosen language.
struct LocaleState(Mutex<String>);

impl LocaleState {
    fn new() -> Self {
        Self(Mutex::new("en".to_string()))
    }

    fn get(&self) -> String {
        self.0.lock().expect("locale mutex poisoned").clone()
    }

    fn set(&self, tag: String) {
        *self.0.lock().expect("locale mutex poisoned") = tag;
    }
}

/// The active peer surface in the unified main window. The frontend updates it
/// even when restoring a hashless localStorage choice, so locale retitling never
/// has to infer the visible surface from a stale URL.
struct MainSurfaceState(Mutex<String>);

impl MainSurfaceState {
    fn new() -> Self {
        Self(Mutex::new(main_surface::SETTINGS.to_string()))
    }

    fn get(&self) -> String {
        self.0.lock().expect("main surface mutex poisoned").clone()
    }

    fn set(&self, surface: &str) {
        *self.0.lock().expect("main surface mutex poisoned") = surface.to_string();
    }
}

/// Dock / taskbar visibility mode ("always" by default, or "when-window-open").
/// Persisted to `<maximal_data_dir>/dock-visibility` and changeable live from
/// Settings → Appearance via `set_dock_visibility`.
struct DockVisibilityState(Mutex<String>);

impl DockVisibilityState {
    fn new() -> Self {
        Self(Mutex::new("always".to_string()))
    }

    fn get(&self) -> String {
        self.0
            .lock()
            .expect("dock visibility mutex poisoned")
            .clone()
    }

    fn always_visible(&self) -> bool {
        self.get() != "when-window-open"
    }

    fn set(&self, mode: String) {
        *self.0.lock().expect("dock visibility mutex poisoned") = mode;
    }
}

/// One-shot flag for "we've already auto-opened Settings to prompt
/// sign-in this session." Lets us open Settings → Account on the
/// first Starting → RunningUnauthenticated transition without
/// re-opening it every time the user manually quits + signs back in
/// while still unauthenticated.

/// Remembers a relaunch or Windows Jump List task that arrives before the
/// sidecar has published and authorized its remote origin. The latest request
/// wins; every action remains available again from the tray after startup.
struct PendingShellAction(Mutex<Option<ShellAction>>);

impl PendingShellAction {
    fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn request(&self, action: ShellAction) {
        *self.0.lock().expect("pending shell action mutex poisoned") = Some(action);
    }

    fn take(&self) -> Option<ShellAction> {
        self.0
            .lock()
            .expect("pending shell action mutex poisoned")
            .take()
    }
}

/// One-shot Windows quit-confirm request. The flag is set before the main
/// window is shown and consumed only after React renders the dialog, so neither
/// a newly loading webview nor an already-hidden one can miss the prompt.
struct PendingQuitPrompt(std::sync::atomic::AtomicBool);

impl PendingQuitPrompt {
    fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }

    #[cfg(any(target_os = "windows", test))]
    fn request(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn pending(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn take(&self) -> bool {
        self.0.swap(false, std::sync::atomic::Ordering::SeqCst)
    }
}

struct SetupPromptShown(std::sync::atomic::AtomicBool);

impl SetupPromptShown {
    fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }

    /// Returns true the first time it's called; false on subsequent calls.
    fn claim(&self) -> bool {
        !self.0.swap(true, std::sync::atomic::Ordering::SeqCst)
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

fn start_runtime_event_loop(
    app: &AppHandle,
    mut events: tokio::sync::mpsc::UnboundedReceiver<RuntimeEvent>,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                RuntimeEvent::State(state) => apply_state(&app, state),
                RuntimeEvent::Ready(endpoint) => {
                    let ready_app = app.clone();
                    if let Err(error) = app.run_on_main_thread(move || {
                        if let Some(action) = ready_app.state::<PendingShellAction>().take() {
                            dispatch_shell_action(&ready_app, action);
                        }
                        #[cfg(target_os = "windows")]
                        ensure_windows_taskbar_window(&ready_app);
                    }) {
                        eprintln!("[shell] could not queue ready presentation: {error}");
                    }
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        poll_sidecar_status(handle, endpoint).await;
                    });
                }
                RuntimeEvent::BootStatus(message) => {
                    let _ = app.emit_to("splash", "splash:status", message);
                }
                RuntimeEvent::Exit(code) => app.exit(code),
            }
        }
    });
}

#[tauri::command]
fn get_shell_api_key(state: State<'_, ShellApiKey>) -> String {
    sidecar_runtime::get_shell_api_key(state)
}

#[tauri::command]
async fn subscribe_token_usage(
    endpoint: State<'_, ManagedEndpoint>,
    period: String,
    on_event: Channel<TokenUsageEvent>,
) -> Result<(), String> {
    sidecar_runtime::subscribe_token_usage(endpoint, period, on_event).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The merged context contains dev/test `--config` overrides. It must exist
    // before the builder so plugin and command registration can be profile-safe.
    let mut context = tauri::generate_context!();
    let profile = AppProfile::from_identifier(&context.config().identifier);
    let initial_shell_action = shell_action_from_args(std::env::args());
    let (runtime_events, runtime_event_rx) = runtime_event_channel();
    if let Some(data_dir) =
        profile_data_override(profile).expect("could not resolve Maximal's app-data directory")
    {
        // Redirect only app_data_dir. In particular, keep local_data unset so
        // existing Windows/Linux webview storage remains identifier-scoped.
        context.config_mut().app.app_directories_override =
            Some(AppDirectoriesOverride::Directories(AppDirectoryOverrides {
                data: Some(data_dir),
                ..Default::default()
            }));
    }
    let builder = tauri::Builder::default()
        // MUST be the FIRST plugin registered. The single-instance
        // plugin's callback fires as part of plugin init; registering
        // it after another plugin lets the second-launch handler race
        // shell startup. The second process always exits after notifying this
        // callback, so it cannot be used as a replacement handoff. Focus the
        // existing profile; the development launcher stops its prior profile
        // before starting Tauri when replacement is required.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let action = shell_action_from_args(&argv).unwrap_or(ShellAction::OpenDefault);
            let app = app.clone();
            // Windows invokes this callback from a synchronous WM_COPYDATA window
            // procedure on the main thread. Move to the async runtime before
            // queueing work back to the main thread so the window procedure can
            // return and release the sending process first.
            tauri::async_runtime::spawn(async move {
                let dispatch_app = app.clone();
                if let Err(error) = app.run_on_main_thread(move || {
                    dispatch_or_queue_shell_action(&dispatch_app, action);
                }) {
                    eprintln!("[shell] could not queue single-instance action: {error}");
                }
            });
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(main_window_state_flags())
                .with_filter(|label| label == SETTINGS_WINDOW_LABEL)
                // Restore synchronously after the hidden window is built so
                // geometry repair cannot race the plugin's queued callback.
                .skip_initial_state(SETTINGS_WINDOW_LABEL)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init());
    // In-place updates are a production capability, not merely an OS one.
    // Keep the updater's default comparator: enabling `semver` would change the
    // signed-version comparison contract used by the existing manifests.
    let builder = if profile.updates_enabled() && IN_PLACE_UPDATE {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    #[cfg(target_os = "macos")]
    let builder = builder.menu(build_app_menu);
    let builder = builder
        .manage(profile)
        .manage(ManagedEndpoint::new())
        .manage(Sidecar::new())
        .manage(AppStatus::new())
        .manage(ShellApiKey::new())
        .manage(RuntimeExiting::new())
        .manage(runtime_events)
        .manage(PendingShellAction::new())
        .manage(PendingQuitPrompt::new())
        .manage(SetupPromptShown::new())
        .manage(StartupAnnounced::new())
        .manage(SplashDismissed::new())
        .manage(SidecarRestarting::new())
        .manage(SidecarFailureStop::new())
        .manage(LastRejection::new())
        .manage(LatestUpdate::new())
        .manage(UpdateInstall::new())
        .manage(SidecarHandoff::new())
        .manage(LastSidecarError::new())
        .manage(LocaleState::new())
        .manage(MainSurfaceState::new())
        .manage(DockVisibilityState::new())
        .on_menu_event(handle_menu_event);
    let builder = if profile.updates_enabled() {
        builder.invoke_handler(tauri::generate_handler![
            open_settings_at,
            open_dashboard,
            set_main_surface,
            reveal_config_dir,
            reveal_logs_dir,
            restart_sidecar,
            has_quit_request,
            take_quit_request,
            confirm_quit,
            uninstall_maximal,
            get_shell_api_key,
            subscribe_token_usage,
            set_locale,
            get_dock_visibility,
            set_dock_visibility,
            update_installs_in_place,
            install_update,
            refresh_update_status,
        ])
    } else {
        builder.invoke_handler(tauri::generate_handler![
            open_settings_at,
            open_dashboard,
            set_main_surface,
            reveal_config_dir,
            reveal_logs_dir,
            restart_sidecar,
            has_quit_request,
            take_quit_request,
            confirm_quit,
            uninstall_maximal,
            get_shell_api_key,
            subscribe_token_usage,
            set_locale,
            get_dock_visibility,
            set_dock_visibility,
        ])
    };
    let app = builder
        .setup(move |app| {
            if let Some(action) = initial_shell_action {
                app.state::<PendingShellAction>().request(action);
            }
            start_runtime_event_loop(app.handle(), runtime_event_rx);
            let data_dir = app.path().app_data_dir()?;
            let preferred_port = (!profile.updates_enabled())
                .then(|| read_preferred_port(&data_dir))
                .flatten();
            app.manage(AppDataDir(data_dir));
            app.state::<ManagedEndpoint>()
                .set_preferred_port(preferred_port);
            // Seed persisted Dock/taskbar visibility mode ("always" by default,
            // or "when-window-open"). Applied immediately via
            // update_activation_policy below.
            if let Some(mode) = persisted_dock_visibility(app.handle()) {
                app.state::<DockVisibilityState>().set(mode);
            }
            #[cfg(target_os = "macos")]
            {
                let want_regular = app.state::<DockVisibilityState>().always_visible();
                POLICY_IS_REGULAR.store(want_regular, std::sync::atomic::Ordering::SeqCst);
                let initial_policy = if want_regular {
                    tauri::ActivationPolicy::Regular
                } else {
                    tauri::ActivationPolicy::Accessory
                };
                let _ = app.set_activation_policy(initial_policy);
                // Dock icon: in release the .app bundle's Info.plist
                // CFBundleIconFile (driven by `bundle.icon` in
                // tauri.conf.json) handles this. `cargo run` doesn't
                // produce a bundle, so set the icon explicitly in debug
                // builds only — release builds skip the FFI dance.
                #[cfg(debug_assertions)]
                if want_regular {
                    set_dock_icon();
                }
            }
            update_activation_policy(app.handle());

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
            install_tray(app.handle())?;
            #[cfg(target_os = "macos")]
            install_dock_menu(app.handle());
            #[cfg(target_os = "windows")]
            install_windows_jump_list(app.handle());
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

            // The authenticated @@MAXIMAL_READY@@ line starts status polling;
            // until then no endpoint or remote IPC capability is exposed.
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
            // Intentional quits all route through `app.exit(0)` (tray Quit or
            // clean sidecar exit), which yields `code == Some(_)`. Those
            // proceed and reach `kill_sidecar`.
            if code.is_none() {
                api.prevent_exit();
                return;
            }
            // Sole sidecar-kill site for a real shutdown.
            begin_exit(app_handle);
            kill_sidecar(app_handle);
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
                open_settings_window(app_handle, default_settings_section(app_handle));
            }
        }
        _ => {}
    });
}

/// Polls the sidecar's /setup-status endpoint, driving SidecarState
/// transitions. First successful response within 30s flips Starting to
/// Running{Un,}Authenticated; after that, slower 5s polling watches
/// for auth changes initiated from Settings.
async fn poll_sidecar_status(app: AppHandle, endpoint: SidecarEndpoint) {
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

    let url = endpoint.http_url("/setup-status");

    // Phase 1: fast poll until first success or 30s timeout.
    let startup_deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut first_seen = false;
    while std::time::Instant::now() < startup_deadline {
        if app.state::<ManagedEndpoint>().current() != Some(endpoint) {
            return;
        }
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
    let auth_status_url = endpoint.http_url("/settings/api/auth/github/status");
    let update_status_url = app
        .state::<AppProfile>()
        .updates_enabled()
        .then(|| update_status_endpoint(endpoint, false));
    let working_notice_url = endpoint.http_url("/settings/api/notices/working");
    // Periodic update check: a menu-bar app can stay open for days, well past a
    // new release, so we re-check on an interval rather than once per launch.
    // `next_update_check` is when the next check is due (None = now, so the
    // first iteration checks immediately). An unreachable sidecar leaves it
    // unchanged so the next 5s tick retries; an unresolved manifest retries
    // after UPDATE_RETRY_INTERVAL; a resolved one waits UPDATE_CHECK_INTERVAL.
    let mut next_update_check: Option<std::time::Instant> = None;
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        // Stop when this generation was replaced, even if the app has already
        // returned to Starting for its successor.
        if app.state::<ManagedEndpoint>().current() != Some(endpoint) {
            return;
        }
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
        check_working_notice(&app, &client, &working_notice_url).await;
        let update_due = next_update_check.is_none_or(|t| std::time::Instant::now() >= t);
        if update_due {
            if let Some(update_url) = update_status_url.as_deref() {
                if let Some(wait) = check_for_update(&app, &client, update_url).await {
                    next_update_check = Some(std::time::Instant::now() + wait);
                }
            }
        }
        // A single failed poll during phase 2 is ignored — the proxy
        // might be momentarily busy. We only flip to Failed via the
        // sidecar's Terminated event.
    }
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

/// One-time "Maximal is working" notice. POST takes (and clears) the notice
/// the sidecar queued on the first tokens after a fresh install, or after an
/// app's integration was turned on (src/lib/working-notice.ts), so each one
/// shows once. Unreachable, failed, or nothing queued → nothing to do.
async fn check_working_notice(app: &AppHandle, client: &reqwest::Client, url: &str) {
    let key = app.state::<ShellApiKey>().value().to_owned();
    let Ok(resp) = client.post(url).header("x-api-key", key).send().await else {
        return;
    };
    if !resp.status().is_success() {
        return;
    }
    let Ok(payload) = resp.json::<serde_json::Value>().await else {
        return;
    };
    // `notice` is null when there's nothing to show.
    let Some(apps) = payload
        .pointer("/notice/apps")
        .and_then(serde_json::Value::as_array)
    else {
        return;
    };
    let names: Vec<&str> = apps.iter().filter_map(serde_json::Value::as_str).collect();
    fire_working_notification(app, &names);
}

/// "Maximal is working", naming the apps that were just set up if any.
/// Best-effort like the other notifications.
fn fire_working_notification(app: &AppHandle, apps: &[&str]) {
    use tauri_plugin_notification::NotificationExt;
    let locale = app.state::<LocaleState>().get();
    let title = native_i18n::tr(&locale, "native-notify-working-title");
    let body = if apps.is_empty() {
        native_i18n::tr(&locale, "native-notify-working-body")
    } else {
        let joined = apps.join(", ");
        native_i18n::t(
            &locale,
            "native-notify-working-body-apps",
            &[("apps", joined.as_str())],
        )
    };
    if let Err(err) = app.notification().builder().title(title).body(body).show() {
        eprintln!("[shell] working notification failed: {err}");
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

/// Update check: GET `/settings/api/update-status` against the sidecar and
/// hand the result to `apply_update`, which updates the "Update to X.Y.Z…"
/// tray item and fires a single OS notification when a newer version first
/// appears. Returns how long to wait before the next check, or None on a
/// transient failure (unreachable / non-2xx / unparseable) so it retries on
/// the next poll tick. The sidecar caches the upstream lookup for hours and
/// honors `config.checkUpdates`, so this stays cheap and is a no-op when the
/// user opted out.
async fn check_for_update(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
) -> Option<Duration> {
    let payload = fetch_update_payload(app, client, url).await?;
    match parse_update_status(&payload) {
        UpdateCheck::Resolved(next) => {
            apply_update(app, next);
            Some(UPDATE_CHECK_INTERVAL)
        }
        UpdateCheck::Unresolved => Some(UPDATE_RETRY_INTERVAL),
    }
}

/// Ask the sidecar for a fresh update check and put the answer on the tray.
/// None when the sidecar couldn't be asked.
async fn force_update_check(app: &AppHandle) -> Option<serde_json::Value> {
    if !app.state::<AppProfile>().updates_enabled() {
        return None;
    }
    let endpoint = app.state::<ManagedEndpoint>().current()?;
    let client = reqwest::Client::builder()
        .timeout(UPDATE_FORCE_TIMEOUT)
        .build()
        .ok()?;
    let payload =
        fetch_update_payload(app, &client, &update_status_endpoint(endpoint, true)).await?;
    if let UpdateCheck::Resolved(next) = parse_update_status(&payload) {
        apply_update(app, next);
    }
    Some(payload)
}

/// The tray's "Check for updates": a fresh check, then a short native notice
/// saying what it found. The tray item is already updated by
/// `force_update_check`; the Settings window re-reads the status on the event.
fn check_updates_from_tray(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let payload = force_update_check(&handle).await;
        let _ = handle.emit_to(SETTINGS_WINDOW_LABEL, UPDATE_STATUS_EVENT, ());
        match manual_check_outcome(payload.as_ref()) {
            // The same banner the poll fires; shown here too when the tray
            // item already existed, so the click always gets an answer.
            ManualCheck::Available(update) => {
                fire_update_notification(&handle, &update.latest, &update.url);
            }
            ManualCheck::UpToDate(version) => {
                show_update_check_notice(
                    &handle,
                    "native-update-check-current",
                    &[("version", &version)],
                );
            }
            ManualCheck::Disabled => {
                show_update_check_notice(&handle, "native-update-check-disabled", &[]);
            }
            ManualCheck::Failed => {
                show_update_check_notice(&handle, "native-update-check-failed", &[]);
            }
        }
    });
}

/// A one-button native notice for a finished update check. A dialog, not a
/// banner: the user just asked, and a banner can be switched off.
fn show_update_check_notice(app: &AppHandle, key: &str, args: &[(&str, &str)]) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    let locale = app.state::<LocaleState>().get();
    app.dialog()
        .message(native_i18n::t(&locale, key, args))
        .title(native_i18n::tr(&locale, "native-update-check-title"))
        .kind(MessageDialogKind::Info)
        .show(|_| {});
}

/// Applies a fetched update snapshot to managed state. Fires the OS
/// notification once per version, across restarts: the last version announced
/// is persisted (`update_notified_file`), so launching again while still behind
/// doesn't re-nag. Refreshes the tray on any change so the "Update to X.Y.Z…"
/// item appears (or clears once the user is current). Mirrors
/// `apply_rejection`: an unchanged snapshot is a no-op, so a repeated periodic
/// check that finds the same version doesn't churn the menu. The tray's manual
/// "Check for updates" does not go through this gate; it always answers.
fn apply_update(app: &AppHandle, next: Option<UpdateSnapshot>) {
    if !app.state::<LatestUpdate>().set(next.clone()) {
        return; // unchanged — no re-notify, no tray churn
    }
    if let Some(update) = &next {
        if should_notify_update(&update.latest, persisted_update_notified(app).as_deref()) {
            write_update_notified(app, &update.latest);
            fire_update_notification(app, &update.latest, &update.url);
        }
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
        // Windows only: an undecorated window with a shadow gets a 1px white
        // frame from DWM (and, on Windows 11, square-ish rounding of its own
        // that doesn't match the page's 14px radius), which shows as white
        // corners outside the rounded `.splash`. The page already paints its
        // own rounded shape on a transparent webview, so drop the OS frame
        // there. macOS and Linux keep the default.
        .shadow(!cfg!(windows))
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

fn startup_notification_body_key(is_macos: bool, is_windows: bool) -> &'static str {
    if is_macos {
        "native-notify-startup-body-macos"
    } else if is_windows {
        "native-notify-startup-body-windows"
    } else {
        "native-notify-startup-body-other"
    }
}

/// One-shot "we're up" notification so users know it's running and where to
/// find it. Same best-effort caveats as `fire_rejection_notification`: a
/// permission denial or a dev (`cargo run`) no-op must not matter.
fn fire_startup_notification(app: &AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    let locale = app.state::<LocaleState>().get();
    // macOS points to the menu bar, Windows to its default taskbar button, and
    // Linux to the system tray. Each catalog bakes in its platform noun.
    let body_key =
        startup_notification_body_key(cfg!(target_os = "macos"), cfg!(target_os = "windows"));
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

fn sign_in_notification_body_key(is_windows: bool) -> &'static str {
    if is_windows {
        "native-notify-signin-body-windows"
    } else {
        "native-notify-signin-body"
    }
}

/// Nudge the user to sign in when the proxy is up but has no GitHub account.
/// Fires on *entry* into the unauthenticated state — first launch, or a
/// mid-session sign-out / token expiry (which otherwise only nudged the tray
/// icon to ATTENTION, easy to miss). Clicking the notification activates the
/// app; `RunEvent::Reopen` (macOS) then brings up Settings → account. The
/// menu-bar "Sign in to GitHub…" item is the always-available macOS fallback.
/// Windows uses separate copy because the app remains visible in the taskbar.
fn fire_sign_in_notification(app: &AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    let locale = app.state::<LocaleState>().get();
    if let Err(err) = app
        .notification()
        .builder()
        .title(native_i18n::tr(&locale, "native-notify-signin-title"))
        .body(native_i18n::tr(
            &locale,
            sign_in_notification_body_key(cfg!(target_os = "windows")),
        ))
        .show()
    {
        eprintln!("[shell] sign-in notification failed: {err}");
    }
}

fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let locale = app.state::<LocaleState>().get();
    let menu = build_menu(app, &locale, SidecarState::Starting)?;
    let icon = icon_for(SidecarState::Starting, false)?;

    // Platform tray-click convention:
    //   * macOS  — left-click opens the menu (HIG menu-bar behavior).
    //   * Windows — left-click opens Settings (the expected "open the app"
    //     gesture), right-click opens the menu. Windows has no
    //     `RunEvent::Reopen`, so this left-click handler is also the path a
    //     user takes after the sign-in notification ("click the icon").
    #[cfg(target_os = "macos")]
    let show_menu_on_left_click = true;
    #[cfg(not(target_os = "macos"))]
    let show_menu_on_left_click = false;

    TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(show_menu_on_left_click)
        .tooltip(native_i18n::tr(&locale, "native-tooltip-starting"))
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // macOS: left-click is handled by show_menu_on_left_click
                // above — nothing to do here. Windows/Linux: open Settings,
                // deep-linking to account when the user still needs to sign
                // in (mirrors the macOS RunEvent::Reopen nudge).
                #[cfg(not(target_os = "macos"))]
                {
                    let app = tray.app_handle();
                    open_settings_window(app, default_settings_section(app));
                }
                #[cfg(target_os = "macos")]
                let _ = tray;
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_windows_jump_list(app: &AppHandle) {
    use windows_jump_list::JumpListTask;

    let locale = app.state::<LocaleState>().get();
    let task = |action: ShellAction, title: String| JumpListTask {
        title,
        argument: action
            .argument()
            .expect("Windows Jump List actions must have launch arguments"),
    };
    let mut tasks = vec![
        task(
            ShellAction::Dashboard,
            native_i18n::tr(&locale, "native-tray-dashboard"),
        ),
        task(
            ShellAction::Sessions,
            native_i18n::tr(&locale, "native-tray-sessions"),
        ),
        task(
            ShellAction::Settings,
            native_i18n::tr(&locale, "native-tray-settings"),
        ),
        task(
            ShellAction::About,
            format!("About {}", app_display_name(app)),
        ),
    ];
    if app.state::<AppProfile>().updates_enabled() {
        tasks.push(task(
            ShellAction::CheckUpdates,
            native_i18n::tr(&locale, "native-tray-check-updates"),
        ));
    }
    tasks.extend([
        task(
            ShellAction::ShowLogs,
            native_i18n::tr(&locale, "native-tray-show-logs"),
        ),
        task(
            ShellAction::OpenConfig,
            native_i18n::tr(&locale, "native-tray-open-config"),
        ),
    ]);
    windows_jump_list::install(tasks);
}

fn refresh_tray(app: &AppHandle, state: SidecarState) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let locale = app.state::<LocaleState>().get();
    let rejection = app.state::<LastRejection>().get();
    let menu = build_menu(app, &locale, state)?;
    tray.set_menu(Some(menu))?;
    tray.set_icon_with_as_template(
        Some(icon_for(state, rejection.is_some())?),
        cfg!(target_os = "macos"),
    )?;
    tray.set_tooltip(Some(tooltip_for(&locale, state, rejection.as_ref())))?;
    #[cfg(target_os = "macos")]
    refresh_dock_menu(app, &locale, state);
    Ok(())
}

/// Holds the live `muda::Menu` returned by `applicationDockMenu:` on macOS when
/// the user right-clicks Maximal's Dock icon. Kept in a process-global mutex
/// (updated on the main thread from `install_dock_menu` / `refresh_dock_menu`)
/// because Objective-C's `applicationDockMenu:` callback receives only `(self, _cmd, sender)`.
#[cfg(target_os = "macos")]
static DOCK_MENU_PTR: std::sync::atomic::AtomicPtr<std::ffi::c_void> =
    std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());

#[cfg(target_os = "macos")]
struct RetainedDockMenu(#[allow(dead_code)] Mutex<Option<muda::Menu>>);

#[cfg(target_os = "macos")]
unsafe impl Send for RetainedDockMenu {}
#[cfg(target_os = "macos")]
unsafe impl Sync for RetainedDockMenu {}

#[cfg(target_os = "macos")]
static DOCK_MENU_HOLDER: std::sync::OnceLock<RetainedDockMenu> = std::sync::OnceLock::new();

#[cfg(target_os = "macos")]
extern "C-unwind" fn application_dock_menu(
    _this: *mut objc2::runtime::AnyObject,
    _cmd: objc2::runtime::Sel,
    _sender: *mut objc2::runtime::AnyObject,
) -> *mut objc2::runtime::AnyObject {
    DOCK_MENU_PTR
        .load(std::sync::atomic::Ordering::SeqCst)
        .cast::<objc2::runtime::AnyObject>()
}

#[cfg(target_os = "macos")]
fn build_muda_dock_menu(
    app: &AppHandle,
    locale: &str,
    state: SidecarState,
) -> muda::Result<muda::Menu> {
    use muda::{Menu, MenuItem, PredefinedMenuItem};

    let menu = Menu::new();
    let settings_item = MenuItem::with_id(
        menu_id::SETTINGS,
        native_i18n::tr(locale, "native-tray-settings"),
        true,
        None,
    );
    let dashboard_item = MenuItem::with_id(
        menu_id::DASHBOARD,
        native_i18n::tr(locale, "native-tray-dashboard"),
        true,
        None,
    );
    let sessions_item = MenuItem::with_id(
        menu_id::SESSIONS,
        native_i18n::tr(locale, "native-tray-sessions"),
        true,
        None,
    );
    let sep1 = PredefinedMenuItem::separator();

    let update = app.state::<LatestUpdate>().get();
    let upgrade_item = update.as_ref().map(|u| {
        MenuItem::with_id(
            menu_id::UPGRADE,
            native_i18n::t(locale, "native-tray-upgrade", &[("latest", &u.latest)]),
            true,
            None,
        )
    });
    let sep_upgrade = PredefinedMenuItem::separator();

    match state {
        SidecarState::Starting => {
            let starting = MenuItem::with_id(
                menu_id::STARTING,
                native_i18n::tr(locale, "native-tray-starting"),
                false,
                None,
            );
            menu.append_items(&[&starting, &sep1, &settings_item])?;
        }
        SidecarState::RunningUnauthenticated => {
            let sign_in = MenuItem::with_id(
                menu_id::SIGN_IN,
                native_i18n::tr(locale, "native-tray-sign-in"),
                true,
                None,
            );
            menu.append(&sign_in)?;
            if let Some(up) = &upgrade_item {
                menu.append(&sep_upgrade)?;
                menu.append(up)?;
            }
            menu.append_items(&[&sep1, &dashboard_item, &sessions_item, &settings_item])?;
        }
        SidecarState::RunningAuthenticated => {
            let info = MenuItem::with_id(
                menu_id::ACCOUNT_INFO,
                native_i18n::tr(locale, "native-tray-signed-in"),
                false,
                None,
            );
            menu.append(&info)?;
            if let Some(up) = &upgrade_item {
                menu.append(&sep_upgrade)?;
                menu.append(up)?;
            }
            menu.append_items(&[&sep1, &dashboard_item, &sessions_item, &settings_item])?;
        }
        SidecarState::Failed | SidecarState::Stopped => {
            let failed = MenuItem::with_id(
                menu_id::FAILED,
                native_i18n::tr(locale, "native-tray-failed"),
                false,
                None,
            );
            let retry = MenuItem::with_id(
                menu_id::RETRY,
                native_i18n::tr(locale, "native-tray-retry"),
                true,
                None,
            );
            let show_logs = MenuItem::with_id(
                menu_id::SHOW_LOGS,
                native_i18n::tr(locale, "native-tray-show-logs"),
                true,
                None,
            );
            let open_config = MenuItem::with_id(
                menu_id::OPEN_CONFIG,
                native_i18n::tr(locale, "native-tray-open-config"),
                true,
                None,
            );
            menu.append_items(&[
                &failed,
                &retry,
                &show_logs,
                &open_config,
                &sep1,
                &settings_item,
            ])?;
        }
    }
    Ok(menu)
}

#[cfg(target_os = "macos")]
fn refresh_dock_menu(app: &AppHandle, locale: &str, state: SidecarState) {
    let app_clone = app.clone();
    let locale_owned = locale.to_string();
    let _ = app.run_on_main_thread(move || {
        use muda::ContextMenu;
        if let Ok(menu) = build_muda_dock_menu(&app_clone, &locale_owned, state) {
            let ptr = menu.ns_menu();
            DOCK_MENU_PTR.store(ptr, std::sync::atomic::Ordering::SeqCst);
            let holder = DOCK_MENU_HOLDER.get_or_init(|| RetainedDockMenu(Mutex::new(None)));
            if let Ok(mut slot) = holder.0.lock() {
                *slot = Some(menu);
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn install_dock_menu(app: &AppHandle) {
    use objc2::sel;
    use objc2_app_kit::NSApplication;
    use objc2_foundation::MainThreadMarker;

    extern "C" {
        fn class_addMethod(
            cls: *const std::ffi::c_void,
            name: objc2::runtime::Sel,
            imp: extern "C-unwind" fn(
                *mut objc2::runtime::AnyObject,
                objc2::runtime::Sel,
                *mut objc2::runtime::AnyObject,
            ) -> *mut objc2::runtime::AnyObject,
            types: *const std::ffi::c_char,
        ) -> bool;
    }

    let locale = app.state::<LocaleState>().get();
    refresh_dock_menu(app, &locale, SidecarState::Starting);

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let ns_app = NSApplication::sharedApplication(mtm);
    if let Some(delegate) = ns_app.delegate() {
        unsafe {
            let cls: *const objc2::runtime::AnyClass = objc2::msg_send![&*delegate, class];
            let _ = class_addMethod(
                cls.cast(),
                sel!(applicationDockMenu:),
                application_dock_menu,
                c"@@:@".as_ptr(),
            );
        }
    }
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

fn icon_for(state: SidecarState, needs_attention: bool) -> tauri::Result<Image<'static>> {
    // A pending upstream rejection while authenticated promotes the icon to ATTENTION so the user
    // notices without opening Settings.
    // Other states already drive the icon themselves (Starting,
    // RunningUnauthenticated also use ATTENTION, etc.); the rejection
    // override only changes the RunningAuthenticated case.
    let bytes = match state {
        SidecarState::Starting => TRAY_ICON_STARTING,
        SidecarState::RunningUnauthenticated => TRAY_ICON_ATTENTION,
        SidecarState::RunningAuthenticated => {
            if needs_attention {
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
    locale: &str,
    state: SidecarState,
    rejection: Option<&RejectionSnapshot>,
) -> String {
    // Rejection wins over the bare "maximal" idle tooltip when the
    // user is authenticated — the tray badge is meaningless without
    // a hint as to why. Other states keep their own tooltip; the
    // rejection sidecar isn't actionable while signed out anyway.
    if matches!(state, SidecarState::RunningAuthenticated) {
        if let Some(r) = rejection {
            return native_i18n::t(
                locale,
                "native-tooltip-rejection",
                &[("message", &r.message)],
            );
        }
    }
    let key = match state {
        SidecarState::Starting => "native-tooltip-starting",
        SidecarState::RunningUnauthenticated => "native-tooltip-sign-in",
        SidecarState::RunningAuthenticated => "native-tooltip-idle",
        SidecarState::Failed => "native-tooltip-failed",
        SidecarState::Stopped => "native-tooltip-stopped",
    };
    native_i18n::tr(locale, key)
}

fn app_display_name(app: &AppHandle) -> String {
    app.config()
        .product_name
        .clone()
        .unwrap_or_else(|| app.package_info().name.clone())
}

#[cfg(target_os = "macos")]
fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let application_menu = menu
        .items()?
        .into_iter()
        .next()
        .and_then(|item| item.as_submenu().cloned());

    if let Some(application_menu) = application_menu {
        // Tauri's default macOS application menu always starts with its
        // predefined About item. Replace only that item so the rest of the
        // native Edit, Window, Help, hide, and quit behavior stays intact.
        application_menu.remove_at(0)?;
        let about = MenuItem::with_id(
            app,
            menu_id::ABOUT,
            format!("About {}", app_display_name(app)),
            true,
            None::<&str>,
        )?;
        application_menu.insert(&about, 0)?;
    }

    Ok(menu)
}

fn open_about_window(app: &AppHandle) {
    const ABOUT_WINDOW_LABEL: &str = "about";

    dismiss_splash(app);
    if let Some(existing) = app.get_webview_window(ABOUT_WINDOW_LABEL) {
        present_window(app, &existing);
        return;
    }

    let name = app_display_name(app);
    let local_url = app
        .state::<ManagedEndpoint>()
        .current()
        .map(SidecarEndpoint::browser_origin);
    let config = serde_json::json!({
        "name": &name,
        "version": app_version(app),
        "website": UPDATE_PAGE_URL,
        "localUrl": local_url,
    });
    let initialization_script = format!("window.__MAXIMAL_ABOUT__ = {config};");
    let result = WebviewWindowBuilder::new(
        app,
        ABOUT_WINDOW_LABEL,
        WebviewUrl::App("splash.html".into()),
    )
    .title(format!("About {name}"))
    .initialization_script(&initialization_script)
    .inner_size(680.0, 360.0)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(true)
    .skip_taskbar(true)
    .visible(false)
    .on_page_load(|window, payload| {
        if payload.event() == PageLoadEvent::Finished {
            present_window(window.app_handle(), &window);
        }
    })
    .center()
    .build();

    if let Err(err) = result {
        eprintln!("[shell] About window failed: {err}");
    }
}

fn build_menu(
    app: &AppHandle,
    locale: &str,
    state: SidecarState,
) -> tauri::Result<Menu<tauri::Wry>> {
    let settings_item = MenuItem::with_id(
        app,
        menu_id::SETTINGS,
        native_i18n::tr(locale, "native-tray-settings"),
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let dashboard_item = MenuItem::with_id(
        app,
        menu_id::DASHBOARD,
        native_i18n::tr(locale, "native-tray-dashboard"),
        true,
        Some("CmdOrCtrl+D"),
    )?;
    let sessions_item = MenuItem::with_id(
        app,
        menu_id::SESSIONS,
        native_i18n::tr(locale, "native-tray-sessions"),
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(
        app,
        menu_id::QUIT,
        native_i18n::tr(locale, "native-tray-quit"),
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;

    // An "Update to X.Y.Z…" item joins the menu in the running states whenever
    // the poll loop has seen a newer release, with "Check for updates" always
    // under it. Built here (before the match) so both running arms can use
    // them; the other arms simply don't reference them.
    // Clicking it installs in place on Windows and macOS, shows the apt command
    // for an apt install, and opens the download page elsewhere (see
    // start_update).
    let updates_enabled = app.state::<AppProfile>().updates_enabled();
    let update = updates_enabled
        .then(|| app.state::<LatestUpdate>().get())
        .flatten();
    let upgrade_item = match &update {
        Some(u) => Some(MenuItem::with_id(
            app,
            menu_id::UPGRADE,
            if u.apt_command.is_some() {
                native_i18n::tr(locale, "native-tray-upgrade-apt")
            } else {
                native_i18n::t(locale, "native-tray-upgrade", &[("latest", &u.latest)])
            },
            true,
            None::<&str>,
        )?),
        None => None,
    };
    let check_item = MenuItem::with_id(
        app,
        menu_id::CHECK_UPDATES,
        native_i18n::tr(locale, "native-tray-check-updates"),
        true,
        None::<&str>,
    )?;
    let sep_upgrade = PredefinedMenuItem::separator(app)?;

    match state {
        SidecarState::Starting => {
            let starting = MenuItem::with_id(
                app,
                menu_id::STARTING,
                native_i18n::tr(locale, "native-tray-starting"),
                false,
                None::<&str>,
            )?;
            Menu::with_items(app, &[&starting, &sep1, &settings_item, &quit_item])
        }
        SidecarState::RunningUnauthenticated => {
            let sign_in = MenuItem::with_id(
                app,
                menu_id::SIGN_IN,
                native_i18n::tr(locale, "native-tray-sign-in"),
                true,
                None::<&str>,
            )?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let mut items: Vec<&dyn IsMenuItem<tauri::Wry>> = Vec::new();
            items.push(&sign_in);
            // Updates are their own section BELOW the primary action — never
            // above sign-in: "Update to X.Y.Z…" when one is available, then
            // "Check for updates".
            if updates_enabled {
                items.push(&sep_upgrade);
                if let Some(up) = &upgrade_item {
                    items.push(up);
                }
                items.push(&check_item);
            }
            items.push(&sep1);
            items.push(&dashboard_item);
            items.push(&sessions_item);
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
                native_i18n::tr(locale, "native-tray-signed-in"),
                false,
                None::<&str>,
            )?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let mut items: Vec<&dyn IsMenuItem<tauri::Wry>> = Vec::new();
            items.push(&info);
            // Updates are their own section BELOW the account line — never
            // above it: "Update to X.Y.Z…" when one is available, then
            // "Check for updates".
            if updates_enabled {
                items.push(&sep_upgrade);
                if let Some(up) = &upgrade_item {
                    items.push(up);
                }
                items.push(&check_item);
            }
            items.push(&sep1);
            items.push(&dashboard_item);
            items.push(&sessions_item);
            items.push(&settings_item);
            items.push(&sep2);
            items.push(&quit_item);
            Menu::with_items(app, &items)
        }
        SidecarState::Failed | SidecarState::Stopped => {
            let failed = MenuItem::with_id(
                app,
                menu_id::FAILED,
                native_i18n::tr(locale, "native-tray-failed"),
                false,
                None::<&str>,
            )?;
            let retry = MenuItem::with_id(
                app,
                menu_id::RETRY,
                native_i18n::tr(locale, "native-tray-retry"),
                true,
                None::<&str>,
            )?;
            let show_logs = MenuItem::with_id(
                app,
                menu_id::SHOW_LOGS,
                native_i18n::tr(locale, "native-tray-show-logs"),
                true,
                None::<&str>,
            )?;
            let open_config = MenuItem::with_id(
                app,
                menu_id::OPEN_CONFIG,
                native_i18n::tr(locale, "native-tray-open-config"),
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
        #[cfg(target_os = "macos")]
        menu_id::ABOUT => open_about_window(app),
        menu_id::SETTINGS => open_settings_window(app, None),
        menu_id::DASHBOARD => open_dashboard_window(app),
        menu_id::SESSIONS => open_sessions_window(app),
        menu_id::SIGN_IN => open_settings_window(app, Some("account")),
        menu_id::SHOW_LOGS => do_reveal_logs_dir(app),
        menu_id::OPEN_CONFIG => do_reveal_config_dir(app),
        menu_id::RETRY => retry_startup(app),
        menu_id::UPGRADE => start_update(app),
        menu_id::CHECK_UPDATES => check_updates_from_tray(app),
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

/// The tray's "Update to X.Y.Z…" item: installs in place where supported
/// (see IN_PLACE_UPDATE). An apt install ("Update with apt…") opens Settings →
/// Diagnostics, which shows the apt command to copy; Maximal never runs apt
/// or asks for root. Anything else opens the download page.
fn start_update(app: &AppHandle) {
    if !app.state::<AppProfile>().updates_enabled() {
        return;
    }
    if !IN_PLACE_UPDATE {
        let apt = app
            .state::<LatestUpdate>()
            .get()
            .is_some_and(|u| u.apt_command.is_some());
        if apt {
            open_settings_window(app, Some(APT_UPDATE_SECTION));
        } else {
            open_update_url(app);
        }
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        run_in_place_update(&handle, |_| {}).await;
    });
}

/// Progress the Settings window hears while an in-place update runs.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum UpdateStep {
    /// The user confirmed; the update is downloading.
    Downloading,
}

/// How an in-place update attempt ended. A successful install never
/// returns: Maximal relaunches into the new version.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum UpdateOutcome {
    /// This build doesn't install in place; the caller opens the download page.
    Unavailable,
    /// An update is already running.
    Busy,
    /// The user chose not to install.
    Cancelled,
    /// The install failed. The user was told, and the download page opened.
    Failed,
}

/// The release channel a build follows, read from its version: `X.Y.Z` is
/// `stable`, `X.Y.Z-<label>.N` is `<label>`. Release builds stamp the shell's
/// version from the tag, so this matches `channelForTag` in
/// scripts/write-updates-manifest.ts, which names the manifest file. None for
/// a label that can't name one.
fn update_channel(version: &str) -> Option<&str> {
    let core = version.split('+').next().unwrap_or(version);
    let Some((_, prerelease)) = core.split_once('-') else {
        return Some("stable");
    };
    let label = prerelease.split('.').next().unwrap_or("");
    let mut chars = label.chars();
    let valid = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    valid.then_some(label)
}

/// The desktop updater manifest this build checks, e.g.
/// `https://mxml.sh/updates/desktop/stable.json`.
fn desktop_update_manifest_url(version: &str) -> Option<String> {
    update_channel(version).map(|channel| format!("{DESKTOP_UPDATE_MANIFEST_BASE}{channel}.json"))
}

/// The `.app` bundle an executable runs from
/// (`<bundle>.app/Contents/MacOS/<exe>`), if it runs from one.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn app_bundle_of(exe: &std::path::Path) -> Option<&std::path::Path> {
    let macos_dir = exe.parent()?;
    if macos_dir.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos_dir.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents.parent()?;
    (bundle.extension()? == "app").then_some(bundle)
}

/// Why the macOS update can't swap the `.app` bundle at `bundle`, if it
/// can't: the app was opened from Downloads without being moved (App
/// Translocation runs it from a read-only copy), or it runs from a read-only
/// volume such as the mounted disk image.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn bundle_location_problem(bundle: &std::path::Path, read_only: bool) -> Option<&'static str> {
    if bundle
        .components()
        .any(|part| part.as_os_str() == "AppTranslocation")
    {
        return Some("it runs from App Translocation, not from where it was installed");
    }
    if read_only {
        return Some("it runs from a read-only volume, such as the disk image");
    }
    None
}

/// Whether the volume holding `path` is mounted read-only.
#[cfg(target_os = "macos")]
fn volume_is_read_only(path: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `statvfs` only writes into `stat`, a plain C struct that is
    // valid zeroed, and only reads `c_path`, a NUL-terminated string that
    // outlives the call.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    rc == 0 && (stat.f_flag & libc::ST_RDONLY) != 0
}

/// Why an in-place update can't replace the running app, if it can't. Only
/// macOS has such places: the update swaps the whole `.app` bundle.
#[cfg(target_os = "macos")]
fn update_location_problem() -> Option<String> {
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(err) => return Some(format!("can't find the running app: {err}")),
    };
    let Some(bundle) = app_bundle_of(&exe) else {
        return Some(format!("{} isn't inside an app bundle", exe.display()));
    };
    bundle_location_problem(bundle, volume_is_read_only(bundle))
        .map(|problem| format!("can't replace {}: {problem}", bundle.display()))
}

#[cfg(not(target_os = "macos"))]
fn update_location_problem() -> Option<String> {
    None
}

/// Run one in-place update: check the desktop manifest, confirm the version
/// with the user, download and verify the signed update, install it, stop the
/// sidecar, and relaunch Maximal. Any failure tells the user and opens the
/// download page instead.
async fn run_in_place_update(app: &AppHandle, on_step: impl Fn(UpdateStep)) -> UpdateOutcome {
    if !IN_PLACE_UPDATE {
        return UpdateOutcome::Unavailable;
    }
    if !app.state::<UpdateInstall>().claim() {
        return UpdateOutcome::Busy;
    }
    let outcome = match install_in_place(app, &on_step).await {
        Ok(outcome) => outcome,
        Err(reason) => {
            eprintln!("[shell] in-place update failed: {reason}");
            report_update_failure(app);
            UpdateOutcome::Failed
        }
    };
    app.state::<UpdateInstall>().release();
    outcome
}

/// The steps of `run_in_place_update`. Returns only when the user declines
/// or something fails; a successful install relaunches the app.
async fn install_in_place(
    app: &AppHandle,
    on_step: &impl Fn(UpdateStep),
) -> Result<UpdateOutcome, String> {
    use tauri_plugin_updater::UpdaterExt;

    // Before asking anything: an app that can't replace itself fails over to
    // the download page right away.
    if let Some(problem) = update_location_problem() {
        return Err(problem);
    }

    let current = app_version(app);
    let endpoint = desktop_update_manifest_url(&current)
        .ok_or_else(|| format!("no update channel for version {current}"))?;
    let endpoint = url::Url::parse(&endpoint).map_err(|e| e.to_string())?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .timeout(UPDATE_MANIFEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    // None: the desktop manifest doesn't list a newer release yet (it can
    // trail the version manifest that showed the button).
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no newer release in the desktop manifest".to_string())?;

    if !confirm_update(app, &update.version).await {
        return Ok(UpdateOutcome::Cancelled);
    }
    on_step(UpdateStep::Downloading);

    // `download` verifies the minisign signature against
    // `plugins.updater.pubkey`, and that it was signed for this version.
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    if cfg!(target_os = "windows") {
        // The installer replaces the sidecar's executable, so the sidecar
        // must be gone first. `install` starts the installer and exits (the
        // installer relaunches Maximal); it returns only on failure, after
        // which the sidecar comes back.
        stop_sidecar_and_wait(app).await;
        stop_mcp_brokers_for_update().await;
        if let Err(err) = update.install(&bytes) {
            respawn_sidecar(app);
            return Err(err.to_string());
        }
    } else {
        // macOS swaps the `.app` bundle while Maximal runs, asking for an
        // administrator password when its folder isn't writable, and puts
        // the previous app back if that fails. The sidecar keeps running the
        // old binary until it is stopped, so stop it before relaunching.
        update.install(&bytes).map_err(|e| e.to_string())?;
        stop_sidecar_and_wait(app).await;
    }
    // Relaunch into the new version. From this task, `restart` goes through
    // ExitRequested (nothing left to stop) and the normal exit cleanup.
    app.restart();
}

/// Native confirm naming the version about to be installed. Resolves to
/// true only on the install button.
async fn confirm_update(app: &AppHandle, version: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let locale = app.state::<LocaleState>().get();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(native_i18n::t(
            &locale,
            "native-update-confirm-body",
            &[("version", version)],
        ))
        .title(native_i18n::tr(&locale, "native-update-confirm-title"))
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            native_i18n::tr(&locale, "native-update-confirm-install"),
            native_i18n::tr(&locale, "native-update-confirm-cancel"),
        ))
        .show(move |confirmed| {
            let _ = tx.send(confirmed);
        });
    rx.await.unwrap_or(false)
}

/// Tell the user the in-place update didn't work, then open the download
/// page so they can install it by hand.
fn report_update_failure(app: &AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let locale = app.state::<LocaleState>().get();
    let app_clone = app.clone();
    app.dialog()
        .message(native_i18n::tr(&locale, "native-update-failed-body"))
        .title(native_i18n::tr(&locale, "native-update-failed-title"))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCustom(native_i18n::tr(
            &locale,
            "native-update-failed-open",
        )))
        .show(move |_| {
            if let Err(err) = app_clone.opener().open_url(UPDATE_PAGE_URL, None::<&str>) {
                eprintln!("[shell] failed to open update url: {err}");
            }
        });
}

/// Stop the sidecar and wait for it to exit. The Terminated handler hands the
/// exit to this caller through `SidecarHandoff` instead of independently
/// quitting the app or marking it Failed.
async fn stop_sidecar_and_wait(app: &AppHandle) {
    sidecar_runtime::stop_sidecar_and_wait(app).await;
}

/// The Windows installer also replaces `maximal-mcp-broker.exe`, which the
/// stopped sidecar's broker can still be running for up to a few seconds (a
/// hard-killed sidecar never stops it), and which Claude Desktop runs as its
/// stdio adapter. Either would hold the file. End every copy, as the MSI and
/// install.ps1 do; the NSIS PREINSTALL hook does it again. Ending the broker
/// ends its Job Object, and with it the MCP servers it started.
#[cfg(target_os = "windows")]
async fn stop_mcp_brokers_for_update() {
    const BROKER_STOP_TIMEOUT: Duration = Duration::from_secs(5);
    let kill = tauri::async_runtime::spawn_blocking(|| {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: don't flash a console for the helper.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("taskkill")
            .args(["/F", "/IM", "maximal-mcp-broker.exe", "/T"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
    });
    // taskkill exits non-zero when nothing matched, which is fine.
    match tokio::time::timeout(BROKER_STOP_TIMEOUT, kill).await {
        Ok(Ok(Ok(_))) => {}
        Ok(Ok(Err(err))) => eprintln!("[shell] taskkill for the MCP broker failed: {err}"),
        Ok(Err(err)) => eprintln!("[shell] taskkill for the MCP broker failed: {err}"),
        Err(_) => eprintln!("[shell] MCP broker still stopping after {BROKER_STOP_TIMEOUT:?}"),
    }
}

/// Only the Windows installer replaces the broker while Maximal runs.
#[cfg(not(target_os = "windows"))]
async fn stop_mcp_brokers_for_update() {}

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
fn retry_startup(app: &AppHandle) {
    if matches!(
        app.state::<AppStatus>().get(),
        SidecarState::Failed | SidecarState::Stopped
    ) {
        dismiss_splash(app);
    }
    sidecar_runtime::retry_startup(app);
}

/// Tear down the running sidecar and boot a fresh one. The reap→respawn→poll
/// core shared by the tray-driven `retry_startup` (recovery from Failed) and
/// the `restart_sidecar` command (a deliberate reboot for account switch /
/// sign-out — we reconstruct from the on-disk config rather than mutating the
/// running instance, so no in-process auth state can leak across the change).
/// Callers gate WHEN this is allowed; this function always reboots.
fn respawn_sidecar(app: &AppHandle) {
    dismiss_splash(app);
    sidecar_runtime::respawn_sidecar(app);
}

/// Opens (or focuses) the unified main webview on the sidecar's Settings shell.
/// The optional `section` becomes a URL fragment so the frontend can scroll to
/// or select that section.
fn open_settings_window(app: &AppHandle, section: Option<&str>) {
    open_settings_window_with_presentation(app, section, MainWindowPresentation::Foreground);
}

fn open_settings_window_with_presentation(
    app: &AppHandle,
    section: Option<&str>,
    presentation: MainWindowPresentation,
) {
    // Any foreground window taking the stage retires the splash (it's
    // always-on-top and would otherwise sit over this one — e.g. the
    // first-launch sign-in nudge). Windows' minimized startup window keeps it.
    if presentation == MainWindowPresentation::Foreground {
        dismiss_splash(app);
    }
    // The settings UI is served by the sidecar at /ui/settings/ (embedded
    // in the binary), in dev and prod alike — there is no separate dev
    // server to point at anymore.
    let Some(endpoint) = app.state::<ManagedEndpoint>().current() else {
        eprintln!("[shell] cannot open Settings before the sidecar is ready");
        return;
    };
    let settings_origin = endpoint.browser_origin();
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

    let surface = match section {
        Some(main_surface::DASHBOARD) => main_surface::DASHBOARD,
        Some(main_surface::SESSIONS) => main_surface::SESSIONS,
        _ => main_surface::SETTINGS,
    };
    let title = main_surface_title(app, surface);
    if let Some(existing) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        #[cfg(target_os = "windows")]
        if presentation == MainWindowPresentation::WindowsStartupMinimized {
            return;
        }
        app.state::<MainSurfaceState>().set(surface);
        let _ = existing.set_title(&title);
        let _ = apply_main_surface_constraints(&existing, surface);
        let js = match section {
            Some(s) => format!("window.location.hash = {:?};", s),
            None => "window.dispatchEvent(new CustomEvent('maximal:open-settings'));".to_string(),
        };
        if existing.eval(&js).is_err() {
            let _ = existing.navigate(url);
        }
        present_window(app, &existing);
        return;
    }
    app.state::<MainSurfaceState>().set(surface);

    // Surface the version in the titlebar (window-level identity belongs in
    // the title, not a content H1 — see docs/design/failure-modes.md). Drop
    // the suffix in dev where the version is the `0.0.0` placeholder.
    let builder = WebviewWindowBuilder::new(app, SETTINGS_WINDOW_LABEL, WebviewUrl::External(url))
        .title(title)
        // The fallback is used only when the plugin has no saved state. Build
        // hidden so controlled restoration and repair finish before the window
        // is presented, avoiding a fallback-size flash.
        .inner_size(MAIN_WINDOW_FALLBACK_WIDTH, MAIN_WINDOW_FALLBACK_HEIGHT)
        .min_inner_size(main_window_min_width(surface), MAIN_WINDOW_MIN_HEIGHT)
        .prevent_overflow_with_margin(LogicalSize::new(
            MAIN_WINDOW_WORK_AREA_MARGIN,
            MAIN_WINDOW_WORK_AREA_MARGIN,
        ))
        .center()
        .visible(false)
        .background_color(tauri::webview::Color(22, 22, 22, 255));

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    match builder.build() {
        Ok(window) => {
            restore_main_window(app, &window, presentation);
        }
        Err(err) => {
            eprintln!("[shell] settings window build failed: {err}");
        }
    }
}

/// The default Windows desktop contract keeps Maximal represented in the
/// taskbar after its splash retires. Build the unified window only after the
/// sidecar origin is authorized, then show it minimized without activation.
#[cfg(target_os = "windows")]
fn ensure_windows_taskbar_window(app: &AppHandle) {
    if !app.state::<DockVisibilityState>().always_visible()
        || [SETTINGS_WINDOW_LABEL, DASHBOARD_WINDOW_LABEL]
            .iter()
            .any(|label| app.get_webview_window(label).is_some())
    {
        return;
    }
    open_settings_window_with_presentation(
        app,
        None,
        MainWindowPresentation::WindowsStartupMinimized,
    );
}

/// The profile-specific app-data root resolved once during setup and passed
/// explicitly to every sidecar as `COPILOT_API_HOME`.
fn maximal_data_dir(app: &AppHandle) -> Option<PathBuf> {
    Some(app.state::<AppDataDir>().0.clone())
}

fn do_reveal_config_dir(app: &AppHandle) {
    let Some(dir) = maximal_data_dir(app) else {
        return;
    };
    let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
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
fn persisted_locale(app: &AppHandle) -> Option<String> {
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

/// Path to the last version the update notification announced: one line, no
/// leading "v". Lives beside the `locale` file so "once per version" survives
/// restarts; the in-memory `LatestUpdate` alone resets every launch.
fn update_notified_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    maximal_data_dir(app).map(|d| d.join("update-notified"))
}

/// The last version announced, if any.
fn persisted_update_notified(app: &AppHandle) -> Option<String> {
    let path = update_notified_file(app)?;
    Some(std::fs::read_to_string(path).ok()?.trim().to_string())
}

/// Record that `latest` has been announced. Called before the notification
/// fires. Best-effort: a write failure is logged and the notification still
/// shows; the next launch may then announce the same version once more.
fn write_update_notified(app: &AppHandle, latest: &str) {
    let Some(path) = update_notified_file(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(err) = std::fs::write(&path, latest) {
        eprintln!("[shell] could not persist notified update {latest}: {err}");
    }
}

/// Whether to announce `latest`: only if it isn't the version last announced.
/// A newer release than the one recorded is announced; so is any other change
/// (e.g. the manifest rolled back), since that is a version not yet shown.
fn should_notify_update(latest: &str, notified: Option<&str>) -> bool {
    notified != Some(latest)
}

/// Path to the persisted Dock / taskbar visibility mode ("always" or
/// "when-window-open"). Defaults to "always" when absent.
fn dock_visibility_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    maximal_data_dir(app).map(|d| d.join("dock-visibility"))
}

fn persisted_dock_visibility(app: &AppHandle) -> Option<String> {
    let path = dock_visibility_file(app)?;
    let raw = std::fs::read_to_string(path).ok()?.trim().to_string();
    match raw.as_str() {
        "always" | "when-window-open" => Some(raw),
        _ => None,
    }
}

fn write_dock_visibility(app: &AppHandle, mode: &str) {
    let Some(path) = dock_visibility_file(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(err) = std::fs::write(&path, mode) {
        eprintln!("[shell] could not persist dock visibility {mode}: {err}");
    }
}

/// The Settings window title for the active locale — versioned unless the
/// version is the dev `0.0.0` placeholder. Shared by the window builder and the
/// live retitle on a locale change so the two can't diverge.
fn settings_title(app: &AppHandle) -> String {
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

/// Re-title any already-open unified Settings/Dashboard/Sessions window.
/// Called from `set_locale` so a picker change updates the OS-drawn titlebar
/// live, not just on the next window open. No-op for windows that aren't up.
fn main_surface_title(app: &AppHandle, surface: &str) -> String {
    let locale = app.state::<LocaleState>().get();
    match surface {
        main_surface::DASHBOARD => native_i18n::tr(&locale, "native-window-dashboard-title"),
        main_surface::SESSIONS => native_i18n::tr(&locale, "native-window-sessions-title"),
        _ => settings_title(app),
    }
}

fn retitle_windows(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        let surface = app.state::<MainSurfaceState>().get();
        let _ = win.set_title(&main_surface_title(app, &surface));
    }
    if let Some(win) = app.get_webview_window(DASHBOARD_WINDOW_LABEL) {
        let locale = app.state::<LocaleState>().get();
        let _ = win.set_title(&native_i18n::tr(&locale, "native-window-dashboard-title"));
    }
}

fn do_reveal_logs_dir(app: &AppHandle) {
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

/// Opens (or focuses) the unified window on its Dashboard view.
/// The dashboard surface itself is still served by the sidecar at
/// `/ui/dashboard/` (embedded inside the unified window and reachable in a
/// plain browser), so the proxy route contract remains intact.
fn open_dashboard_window(app: &AppHandle) {
    const _DASHBOARD_ROUTE_CONTRACT: &str = "/ui/dashboard/";
    open_settings_window(app, Some(main_surface::DASHBOARD));
}

/// Opens (or focuses) the unified window on its Sessions view.
fn open_sessions_window(app: &AppHandle) {
    const _SESSIONS_ROUTE_CONTRACT: &str = "/ui/sessions/";
    open_settings_window(app, Some(main_surface::SESSIONS));
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CloseWindowAction {
    ConfirmQuit,
    Hide,
}

fn close_window_action(is_windows: bool) -> CloseWindowAction {
    if is_windows {
        CloseWindowAction::ConfirmQuit
    } else {
        CloseWindowAction::Hide
    }
}

/// Windows follows the ordinary desktop contract: closing the main window
/// asks for confirmation, then quits Maximal after bounded sidecar/configurator
/// shutdown. macOS/Linux retain the menu-bar/tray close-to-background behavior.
/// Both paths prevent Tauri's code-less last-window exit request.
fn attach_main_window_behavior(app: &AppHandle, window: &tauri::WebviewWindow) {
    let window_clone = window.clone();
    let app_clone = app.clone();
    let was_maximized = Mutex::new(window.is_maximized().unwrap_or(false));
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            match close_window_action(cfg!(windows)) {
                CloseWindowAction::ConfirmQuit => request_quit(&app_clone),
                CloseWindowAction::Hide => {
                    let _ = window_clone.hide();
                    update_activation_policy(&app_clone);
                }
            }
        }
        WindowEvent::Resized(_) => {
            let Ok(is_maximized) = window_clone.is_maximized() else {
                return;
            };
            let returned_to_normal = {
                let mut previous = was_maximized
                    .lock()
                    .expect("main window maximized mutex poisoned");
                let returned_to_normal = *previous && !is_maximized;
                *previous = is_maximized;
                returned_to_normal
            };
            if returned_to_normal {
                let surface = app_clone.state::<MainSurfaceState>().get();
                let _ = apply_main_surface_constraints(&window_clone, &surface);
            }
        }
        WindowEvent::ScaleFactorChanged { .. } => {
            let surface = app_clone.state::<MainSurfaceState>().get();
            let _ = apply_main_surface_constraints(&window_clone, &surface);
        }
        _ => {}
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
static POLICY_IS_REGULAR: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "macos")]
fn update_activation_policy(app: &AppHandle) {
    use std::sync::atomic::Ordering;

    let always_visible = app.state::<DockVisibilityState>().always_visible();
    let labels = [SETTINGS_WINDOW_LABEL, DASHBOARD_WINDOW_LABEL];
    let any_window_visible = labels.iter().any(|label| {
        app.get_webview_window(label)
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false)
    });
    let want_regular = always_visible || any_window_visible;

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
fn update_activation_policy(app: &AppHandle) {
    let always_visible = app.state::<DockVisibilityState>().always_visible();
    for label in [SETTINGS_WINDOW_LABEL, DASHBOARD_WINDOW_LABEL] {
        if let Some(win) = app.get_webview_window(label) {
            let visible = win.is_visible().unwrap_or(false);
            let want_taskbar = always_visible || visible;
            let _ = win.set_skip_taskbar(!want_taskbar);
        }
    }
}

/// Show the restored Windows startup window minimized without activating it.
/// `SW_SHOWMINNOACTIVE` creates the taskbar button while leaving focus with the
/// person's current application; ordinary Tauri `show()` can activate a newly
/// visible window after minimizing it.
#[cfg(target_os = "windows")]
fn show_windows_startup_window(app: &AppHandle, window: &WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWMINNOACTIVE};

    if let Err(error) = window.set_skip_taskbar(false) {
        eprintln!("[shell] could not include startup window in taskbar: {error}");
    }
    match window.hwnd() {
        Ok(hwnd) => {
            // SAFETY: Tauri owns this live HWND, and restoration calls this helper
            // on the main thread before any close path can destroy the window.
            unsafe {
                let _ = ShowWindow(hwnd, SW_SHOWMINNOACTIVE);
            }
            update_activation_policy(app);
        }
        Err(error) => {
            eprintln!("[shell] could not access startup window handle: {error}");
        }
    }
}

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

async fn finish_quit<F, E>(sidecar_stop: F, exit: E)
where
    F: std::future::Future<Output = ()>,
    E: FnOnce(),
{
    sidecar_stop.await;
    exit();
}

fn exit_gracefully(app: AppHandle) {
    if !begin_exit(&app) {
        return;
    }
    if cfg!(target_os = "windows") {
        let app_for_stop = app.clone();
        tauri::async_runtime::spawn(async move {
            finish_quit(stop_sidecar_and_wait(&app_for_stop), || app.exit(0)).await;
        });
    } else {
        app.exit(0);
    }
}

fn request_native_quit_dialog(app: &AppHandle) {
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
                exit_gracefully(app_clone);
            }
        });
}

/// Windows uses the app-styled confirmation dialog in the unified main window.
/// Queue before opening and signal after: a newly loading webview observes the
/// flag on mount, while an existing hidden webview receives the live event. The
/// webview acknowledges the flag only after React renders the dialog.
#[cfg(target_os = "windows")]
fn request_quit(app: &AppHandle) {
    if app.state::<ManagedEndpoint>().current().is_none() {
        request_native_quit_dialog(app);
        return;
    }

    app.state::<PendingQuitPrompt>().request();
    open_settings_window(app, None);
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        if let Err(err) = window.eval(QUIT_REQUESTED_DOM_EVENT_SCRIPT) {
            eprintln!("[shell] eval quit-requested failed: {err}");
        }
    }
    if let Err(err) = app.emit_to(SETTINGS_WINDOW_LABEL, QUIT_REQUESTED_EVENT, ()) {
        eprintln!("[shell] emit quit-requested failed: {err}");
    }
}

/// macOS keeps the native confirmation that already matches the platform.
#[cfg(not(target_os = "windows"))]
fn request_quit(app: &AppHandle) {
    request_native_quit_dialog(app);
}

#[tauri::command]
fn has_quit_request(state: State<'_, PendingQuitPrompt>) -> bool {
    state.pending()
}

#[tauri::command]
fn take_quit_request(state: State<'_, PendingQuitPrompt>) -> bool {
    state.take()
}

#[tauri::command]
fn confirm_quit(app: AppHandle) {
    exit_gracefully(app);
}

fn dispatch_or_queue_shell_action(app: &AppHandle, action: ShellAction) {
    if app.state::<ManagedEndpoint>().current().is_none() {
        app.state::<PendingShellAction>().request(action);
    } else {
        dispatch_shell_action(app, action);
    }
}

fn dispatch_shell_action(app: &AppHandle, action: ShellAction) {
    match action {
        ShellAction::OpenDefault => focus_or_open_main_window(app),
        ShellAction::About => open_about_window(app),
        ShellAction::Settings => open_settings_window(app, None),
        ShellAction::Dashboard => open_dashboard_window(app),
        ShellAction::Sessions => open_sessions_window(app),
        ShellAction::CheckUpdates => check_updates_from_tray(app),
        ShellAction::ShowLogs => do_reveal_logs_dir(app),
        ShellAction::OpenConfig => do_reveal_config_dir(app),
    }
}

/// Focus an existing main window, or open Settings if none exists.
///
/// Called after a plain second launch reaches the existing process. Settings is
/// the default surface; Dashboard is the fallback if Settings isn't built yet
/// but Dashboard is. If neither exists we open Settings fresh, which also runs
/// `update_activation_policy` to bring the Dock icon back.
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

/// Keep the OS-drawn title in sync with the unified frontend surface.
#[tauri::command]
fn set_main_surface(app: AppHandle, surface: String) -> Result<(), String> {
    let normalized = match surface.as_str() {
        main_surface::DASHBOARD => main_surface::DASHBOARD,
        main_surface::SESSIONS => main_surface::SESSIONS,
        main_surface::SETTINGS => main_surface::SETTINGS,
        _ => return Err("unknown main surface".to_string()),
    };
    app.state::<MainSurfaceState>().set(normalized);
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        window
            .set_title(&main_surface_title(&app, normalized))
            .map_err(|error| error.to_string())?;
        apply_main_surface_constraints(&window, normalized).map_err(|error| error.to_string())?;
    }
    Ok(())
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
/// `maximal uninstall --unattended --keep-app --force` (plus `--purge` when the
/// Settings webview asks). `--force` is mandatory here: the in-app flow is an
/// explicit "uninstall now" action that can't surface the CLI's
/// refuse-while-apps-enabled message, so the CLI disables any enabled app
/// integrations itself and reverts them through the registry. `--keep-app` is
/// likewise mandatory: the running `.app` can't delete the bundle it's
/// executing from, so the CLI removes the launchd agent, its app-owned service
/// binary, and a legacy `~/.local/bin/maximal` symlink if present.
/// Package-manager binaries remain
/// untouched; the user drags Maximal to the Trash to finish. Returns
/// `Err(String)` (a
/// human-readable reason) on a missing binary or non-zero exit so the webview
/// can surface a non-blocking inline error instead of silently stranding the
/// user. Mirrors the spawn+`.output()` shape of `reconcile_claude_code_revert`.
#[tauri::command]
async fn uninstall_maximal(app: AppHandle, purge: bool) -> Result<(), String> {
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
        .args(args)
        .env("HOST", LOOPBACK_HOST)
        .env("COPILOT_API_HOME", app.state::<AppDataDir>().0.as_os_str());
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
fn set_locale(app: AppHandle, locale: State<'_, LocaleState>, tag: String) -> Result<(), String> {
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
    #[cfg(target_os = "windows")]
    install_windows_jump_list(&app);
    retitle_windows(&app);
    Ok(())
}

#[tauri::command]
fn get_dock_visibility(state: State<'_, DockVisibilityState>) -> String {
    state.get()
}

/// Tauri command — whether "Update to X.Y.Z" installs in place on this
/// build (Windows, macOS) or opens the download page. The Settings window
/// reads it for the button's tooltip.
#[tauri::command]
fn update_installs_in_place(profile: State<'_, AppProfile>) -> bool {
    profile.updates_enabled() && IN_PLACE_UPDATE
}

/// Tauri command — Settings ran a fresh update check ("Check now"). The
/// sidecar has the answer; read it back (a cached read, no new fetch) so the
/// tray's "Update to X.Y.Z…" item agrees with what Settings now shows.
#[tauri::command]
async fn refresh_update_status(app: AppHandle) {
    if !app.state::<AppProfile>().updates_enabled() {
        return;
    }
    let Some(endpoint) = app.state::<ManagedEndpoint>().current() else {
        return;
    };
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    else {
        return;
    };
    let _ = check_for_update(&app, &client, &update_status_endpoint(endpoint, false)).await;
}

/// Tauri command — the topbar "Update to X.Y.Z" button. Runs the in-place
/// update (confirm, download, install, relaunch) and streams its progress on
/// `on_step`. Returns `unavailable` where updates don't install in place, so
/// the webview opens the download page itself; on success it never returns.
#[tauri::command]
async fn install_update(app: AppHandle, on_step: Channel<UpdateStep>) -> UpdateOutcome {
    if !app.state::<AppProfile>().updates_enabled() {
        return UpdateOutcome::Unavailable;
    }
    run_in_place_update(&app, |step| {
        let _ = on_step.send(step);
    })
    .await
}

#[tauri::command]
fn set_dock_visibility(
    app: AppHandle,
    state: State<'_, DockVisibilityState>,
    mode: String,
) -> Result<String, String> {
    let normalized = match mode.trim() {
        "always" => "always",
        "when-window-open" => "when-window-open",
        other => return Err(format!("unsupported dock visibility mode: {other}")),
    };
    state.set(normalized.to_string());
    write_dock_visibility(&app, normalized);
    let app_for_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        update_activation_policy(&app_for_main);
    });
    Ok(normalized.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn consumes_a_queued_quit_prompt_once() {
        use super::PendingQuitPrompt;

        let prompt = PendingQuitPrompt::new();
        assert!(!prompt.take());
        prompt.request();
        assert!(prompt.take());
        assert!(!prompt.take());
    }

    #[test]
    fn waits_for_sidecar_stop_before_exiting() {
        use super::finish_quit;
        use std::sync::{Arc, Mutex};

        let events = Arc::new(Mutex::new(Vec::new()));
        let stop_events = Arc::clone(&events);
        let exit_events = Arc::clone(&events);

        tauri::async_runtime::block_on(finish_quit(
            async move {
                stop_events.lock().unwrap().push("sidecar stopped");
            },
            move || exit_events.lock().unwrap().push("shell exited"),
        ));

        assert_eq!(*events.lock().unwrap(), ["sidecar stopped", "shell exited"]);
    }

    #[test]
    fn confirms_before_the_main_window_closes_on_windows() {
        use super::{close_window_action, CloseWindowAction};

        assert_eq!(close_window_action(true), CloseWindowAction::ConfirmQuit);
    }

    #[test]
    fn preserves_hide_on_close_outside_windows() {
        use super::{close_window_action, CloseWindowAction};

        assert_eq!(close_window_action(false), CloseWindowAction::Hide);
    }

    #[test]
    fn selects_platform_specific_startup_notification_copy() {
        use super::startup_notification_body_key;

        assert_eq!(
            startup_notification_body_key(true, false),
            "native-notify-startup-body-macos"
        );
        assert_eq!(
            startup_notification_body_key(false, true),
            "native-notify-startup-body-windows"
        );
        assert_eq!(
            startup_notification_body_key(false, false),
            "native-notify-startup-body-other"
        );
    }

    #[test]
    fn selects_platform_specific_sign_in_notification_copy() {
        use super::sign_in_notification_body_key;

        assert_eq!(
            sign_in_notification_body_key(true),
            "native-notify-signin-body-windows"
        );
        assert_eq!(
            sign_in_notification_body_key(false),
            "native-notify-signin-body"
        );
    }

    #[test]
    fn parses_windows_jump_list_actions_from_process_arguments() {
        use super::{shell_action_from_args, ShellAction};

        for (value, expected) in [
            ("about", ShellAction::About),
            ("settings", ShellAction::Settings),
            ("dashboard", ShellAction::Dashboard),
            ("sessions", ShellAction::Sessions),
            ("check-updates", ShellAction::CheckUpdates),
            ("show-logs", ShellAction::ShowLogs),
            ("open-config", ShellAction::OpenConfig),
        ] {
            assert_eq!(
                shell_action_from_args(["Maximal.exe", &format!("--maximal-action={value}")]),
                Some(expected),
            );
        }
    }

    #[test]
    fn rejects_unknown_or_conflicting_shell_actions() {
        use super::shell_action_from_args;

        assert_eq!(
            shell_action_from_args(["Maximal.exe", "--maximal-action=unknown"]),
            None,
        );
        assert_eq!(
            shell_action_from_args([
                "Maximal.exe",
                "--maximal-action=settings",
                "--maximal-action=dashboard",
            ]),
            None,
        );
    }

    #[test]
    fn every_jump_list_action_argument_round_trips() {
        use super::{shell_action_from_args, ShellAction};

        for action in [
            ShellAction::About,
            ShellAction::Settings,
            ShellAction::Dashboard,
            ShellAction::Sessions,
            ShellAction::CheckUpdates,
            ShellAction::ShowLogs,
            ShellAction::OpenConfig,
        ] {
            let argument = action.argument().unwrap();
            assert_eq!(
                shell_action_from_args(["Maximal.exe", argument]),
                Some(action)
            );
        }
        assert_eq!(ShellAction::OpenDefault.argument(), None);
    }

    #[test]
    fn pending_shell_action_keeps_the_latest_request_and_consumes_it_once() {
        use super::{PendingShellAction, ShellAction};

        let pending = PendingShellAction::new();
        assert_eq!(pending.take(), None);
        pending.request(ShellAction::Settings);
        pending.request(ShellAction::Dashboard);
        assert_eq!(pending.take(), Some(ShellAction::Dashboard));
        assert_eq!(pending.take(), None);
    }

    #[test]
    fn macos_tray_icons_are_black_and_alpha_templates() {
        for bytes in [
            include_bytes!("../icons/tray/macos/icon@2x.png").as_slice(),
            include_bytes!("../icons/tray/macos/icon-starting@2x.png").as_slice(),
            include_bytes!("../icons/tray/macos/icon-attention@2x.png").as_slice(),
        ] {
            let image = tauri::image::Image::from_bytes(bytes).unwrap();
            assert_eq!((image.width(), image.height()), (44, 44));
            assert!(image
                .rgba()
                .chunks_exact(4)
                .filter(|pixel| pixel[3] > 0)
                .all(|pixel| pixel[..3] == [0, 0, 0]));
        }
    }

    #[test]
    fn windows_attention_icon_keeps_contrast_on_light_and_dark_taskbars() {
        fn linear(channel: u8) -> f64 {
            let value = f64::from(channel) / 255.0;
            if value <= 0.04045 {
                value / 12.92
            } else {
                ((value + 0.055) / 1.055).powf(2.4)
            }
        }
        fn luminance(pixel: &[u8]) -> f64 {
            0.2126 * linear(pixel[0]) + 0.7152 * linear(pixel[1]) + 0.0722 * linear(pixel[2])
        }
        fn contrast(left: f64, right: f64) -> f64 {
            let (lighter, darker) = if left > right {
                (left, right)
            } else {
                (right, left)
            };
            (lighter + 0.05) / (darker + 0.05)
        }

        let image = tauri::image::Image::from_bytes(include_bytes!(
            "../icons/tray/windows/icon-attention@2x.png"
        ))
        .unwrap();
        assert_eq!((image.width(), image.height()), (44, 44));
        let dark = luminance(&[23, 23, 23]);
        let opaque: Vec<&[u8]> = image
            .rgba()
            .chunks_exact(4)
            .filter(|pixel| pixel[3] >= 204)
            .collect();
        let adaptable = opaque
            .iter()
            .filter(|pixel| {
                let value = luminance(pixel);
                contrast(value, 1.0) >= 3.0 && contrast(value, dark) >= 3.0
            })
            .count();
        assert!(adaptable * 100 >= opaque.len() * 35);
    }

    #[test]
    fn fits_the_main_window_inner_size_inside_the_physical_frame_and_work_area() {
        use super::{fitted_main_window_inner_size, outer_size_for_inner};
        use tauri::PhysicalSize;

        let frame = PhysicalSize::new(32, 80);
        let inner = fitted_main_window_inner_size(PhysicalSize::new(1800, 1200), 2.0, frame);
        assert_eq!(inner, PhysicalSize::new(1640, 992));
        assert_eq!(
            outer_size_for_inner(inner, frame),
            PhysicalSize::new(1672, 1072),
        );

        assert_eq!(
            fitted_main_window_inner_size(
                PhysicalSize::new(900, 600),
                1.0,
                PhysicalSize::new(16, 40),
            ),
            PhysicalSize::new(820, 496),
        );
    }

    #[test]
    fn constrains_only_the_settings_surface_width() {
        use super::{main_surface, main_window_constraints};
        use tauri::{LogicalUnit, PixelUnit};

        let settings = main_window_constraints(main_surface::SETTINGS);
        assert_eq!(
            settings.max_width,
            Some(PixelUnit::Logical(LogicalUnit::new(1100.0))),
        );
        assert_eq!(settings.max_height, None);
        assert_eq!(
            settings.min_width,
            Some(PixelUnit::Logical(LogicalUnit::new(736.0))),
        );
        assert_eq!(
            settings.min_height,
            Some(PixelUnit::Logical(LogicalUnit::new(480.0))),
        );

        for surface in [main_surface::DASHBOARD, main_surface::SESSIONS] {
            let observability = main_window_constraints(surface);
            assert_eq!(
                observability.min_width,
                Some(PixelUnit::Logical(LogicalUnit::new(640.0))),
            );
            assert_eq!(observability.max_width, None);
            assert_eq!(observability.max_height, None);
        }
    }

    #[test]
    fn centers_a_repaired_main_window_in_its_work_area() {
        use super::centered_main_window_position;
        use tauri::{PhysicalPosition, PhysicalRect, PhysicalSize};

        let work_area = PhysicalRect {
            position: PhysicalPosition::new(0, 66),
            size: PhysicalSize::new(3456, 1988),
        };
        assert_eq!(
            centered_main_window_position(PhysicalSize::new(2200, 1440), &work_area),
            PhysicalPosition::new(628, 340),
        );
    }

    #[test]
    fn clamps_a_restored_main_window_to_a_negative_origin_work_area() {
        use super::clamp_main_window_position;
        use tauri::{PhysicalPosition, PhysicalRect, PhysicalSize};

        let work_area = PhysicalRect {
            position: PhysicalPosition::new(-1920, 0),
            size: PhysicalSize::new(1920, 1080),
        };
        assert_eq!(
            clamp_main_window_position(
                PhysicalPosition::new(-2100, -40),
                PhysicalSize::new(1200, 700),
                &work_area,
            ),
            PhysicalPosition::new(-1920, 0),
        );
    }

    #[test]
    fn persists_only_safe_main_window_state() {
        use super::{
            main_window_state_flags, MAIN_WINDOW_FALLBACK_HEIGHT, MAIN_WINDOW_FALLBACK_WIDTH,
        };
        use tauri_plugin_window_state::StateFlags;

        let flags = main_window_state_flags();
        assert!(flags.contains(StateFlags::SIZE));
        assert!(flags.contains(StateFlags::POSITION));
        assert!(flags.contains(StateFlags::MAXIMIZED));
        assert!(!flags
            .intersects(StateFlags::VISIBLE | StateFlags::DECORATIONS | StateFlags::FULLSCREEN));
        assert_eq!(MAIN_WINDOW_FALLBACK_WIDTH, 1100.0);
        assert_eq!(MAIN_WINDOW_FALLBACK_HEIGHT, 720.0);
    }

    #[test]
    fn remembers_the_active_main_surface_without_a_url_fragment() {
        use super::{main_surface, MainSurfaceState};
        let state = MainSurfaceState::new();
        assert_eq!(state.get(), main_surface::SETTINGS);
        state.set(main_surface::SESSIONS);
        assert_eq!(state.get(), main_surface::SESSIONS);
    }

    #[test]
    fn notifies_each_update_version_once() {
        use super::should_notify_update;
        assert!(should_notify_update("0.4.47", None));
        assert!(!should_notify_update("0.4.47", Some("0.4.47")));
        assert!(should_notify_update("0.4.48", Some("0.4.47")));
    }

    #[test]
    fn picks_the_desktop_manifest_for_the_release_channel() {
        use super::{desktop_update_manifest_url, update_channel};
        // Release builds stamp the shell's version from the tag.
        assert_eq!(update_channel("0.4.49"), Some("stable"));
        assert_eq!(update_channel("0.4.49-beta.1"), Some("beta"));
        assert_eq!(update_channel("0.4.49-rc-2.1"), Some("rc-2"));
        assert_eq!(update_channel("0.4.49+abc"), Some("stable"));
        // Dev placeholder version: checks stable, which is never older.
        assert_eq!(update_channel("0.0.0"), Some("stable"));
        // A label that can't name a manifest file.
        assert_eq!(update_channel("0.4.49-1"), None);
        assert_eq!(update_channel("0.4.49-"), None);
        assert_eq!(
            desktop_update_manifest_url("0.4.49").as_deref(),
            Some("https://mxml.sh/updates/desktop/stable.json")
        );
        assert_eq!(
            desktop_update_manifest_url("0.5.0-beta.3").as_deref(),
            Some("https://mxml.sh/updates/desktop/beta.json")
        );
        assert_eq!(desktop_update_manifest_url("0.4.49-1"), None);
    }

    #[test]
    fn installs_in_place_on_windows_and_macos() {
        assert_eq!(
            super::IN_PLACE_UPDATE,
            cfg!(any(target_os = "windows", target_os = "macos"))
        );
    }

    #[test]
    fn rc_builds_check_the_rc_manifest() {
        use super::desktop_update_manifest_url;
        // rc.1 → rc.2 is the upgrade path RC testing exercises.
        assert_eq!(
            desktop_update_manifest_url("0.5.0-rc.1").as_deref(),
            Some("https://mxml.sh/updates/desktop/rc.json")
        );
    }

    #[test]
    fn finds_the_app_bundle_a_binary_runs_from() {
        use super::app_bundle_of;
        use std::path::Path;
        assert_eq!(
            app_bundle_of(Path::new(
                "/Applications/Maximal.app/Contents/MacOS/maximal-shell"
            )),
            Some(Path::new("/Applications/Maximal.app"))
        );
        // `cargo run` / a bare binary isn't in a bundle.
        assert_eq!(
            app_bundle_of(Path::new(
                "/repo/shell/src-tauri/target/debug/maximal-shell"
            )),
            None
        );
        assert_eq!(
            app_bundle_of(Path::new("/x/Maximal/Contents/MacOS/maximal-shell")),
            None
        );
    }

    #[test]
    fn refuses_bundles_an_update_cant_replace() {
        use super::bundle_location_problem;
        use std::path::Path;
        let installed = Path::new("/Applications/Maximal.app");
        assert_eq!(bundle_location_problem(installed, false), None);
        // Opened from Downloads without moving it: Gatekeeper runs a
        // read-only translocated copy.
        let translocated =
            Path::new("/private/var/folders/x/T/AppTranslocation/1234/d/Maximal.app");
        assert!(bundle_location_problem(translocated, false).is_some());
        // Run straight from the mounted disk image.
        let on_dmg = Path::new("/Volumes/Maximal/Maximal.app");
        assert!(bundle_location_problem(on_dmg, true).is_some());
    }

    #[test]
    fn update_outcomes_serialize_for_the_webview() {
        use super::{UpdateOutcome, UpdateStep};
        let json = |v: serde_json::Value| v.as_str().map(str::to_owned);
        assert_eq!(
            json(serde_json::to_value(UpdateOutcome::Unavailable).unwrap()),
            Some("unavailable".into())
        );
        assert_eq!(
            json(serde_json::to_value(UpdateOutcome::Cancelled).unwrap()),
            Some("cancelled".into())
        );
        assert_eq!(
            json(serde_json::to_value(UpdateStep::Downloading).unwrap()),
            Some("downloading".into())
        );
    }
}
