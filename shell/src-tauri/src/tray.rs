use tauri::{
    image::Image,
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

use crate::commands::{do_reveal_config_dir, do_reveal_logs_dir, request_quit};
use crate::native_i18n;
use crate::sidecar::retry_startup;
use crate::state::{LastRejection, LatestUpdate, LocaleState, RejectionSnapshot, SidecarState};
use crate::updater::handle_upgrade;
use crate::windows::{open_dashboard_window, open_settings_window};

pub(crate) const TRAY_ID: &str = "main";

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

pub(crate) mod menu_id {
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

pub(crate) fn install_tray(app: &AppHandle) -> tauri::Result<()> {
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
        .on_menu_event(handle_menu_event)
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
                    let section = if app.state::<crate::state::AppStatus>().get()
                        == SidecarState::RunningUnauthenticated
                    {
                        Some("account")
                    } else {
                        None
                    };
                    open_settings_window(app, section);
                }
                #[cfg(target_os = "macos")]
                let _ = tray;
            }
        })
        .build(app)?;
    Ok(())
}

pub(crate) fn refresh_tray(app: &AppHandle, state: SidecarState) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let locale = app.state::<LocaleState>().get();
    let rejection = app.state::<LastRejection>().get();
    let menu = build_menu(app, &locale, state)?;
    tray.set_menu(Some(menu))?;
    tray.set_icon(Some(icon_for(state, rejection.is_some())?))?;
    tray.set_tooltip(Some(tooltip_for(&locale, state, rejection.as_ref())))?;
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
pub(crate) fn set_dock_icon() {
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

fn icon_for(state: SidecarState, has_rejection: bool) -> tauri::Result<Image<'static>> {
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

fn tooltip_for(locale: &str, state: SidecarState, rejection: Option<&RejectionSnapshot>) -> String {
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
    let quit_item = MenuItem::with_id(
        app,
        menu_id::QUIT,
        native_i18n::tr(locale, "native-tray-quit"),
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
            native_i18n::t(locale, "native-tray-upgrade", &[("latest", &u.latest)]),
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
                native_i18n::tr(locale, "native-tray-signed-in"),
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
        menu_id::SETTINGS => open_settings_window(app, None),
        menu_id::DASHBOARD => open_dashboard_window(app),
        menu_id::SIGN_IN => open_settings_window(app, Some("account")),
        menu_id::SHOW_LOGS => do_reveal_logs_dir(app),
        menu_id::OPEN_CONFIG => do_reveal_config_dir(app),
        menu_id::RETRY => retry_startup(app),
        menu_id::UPGRADE => handle_upgrade(app),
        menu_id::QUIT => request_quit(app),
        _ => {}
    }
}
