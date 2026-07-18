//! Pure, UI-free decision logic for the single-window redesign (spec §1.2, §3.3).
//!
//! `cargo test` is not in CI and a Tauri app can't be driven headlessly, so the
//! redesign's rule that "push handler logic to pure `click_action` /
//! `failure_surface_for`" (spec §10) lives here: no `AppHandle`, no tray, no
//! window — just enums in, a decision out — so every branch is unit-tested below
//! and `clippy`-clean. `lib.rs` maps real Tauri events onto these inputs and acts
//! on the returned decision.

/// High-level tray state. Each transition rebuilds the tray icon/tooltip and,
/// via [`failure_surface_for`], drives the splash. Moved here (from `lib.rs`) so
/// the decisions that read it are testable without a running app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SidecarState {
    Starting,
    RunningUnauthenticated,
    RunningAuthenticated,
    #[allow(dead_code)]
    Stopped,
    Failed,
}

/// The mouse button of a tray click (a pure mirror of Tauri's `MouseButton`, so
/// this module needs no Tauri dependency).
#[allow(dead_code)] // the tray rewire (§1.2) constructs these; tests already do
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClickButton {
    Left,
    Right,
    Middle,
}

/// The up/down phase of a tray click (mirror of Tauri's `MouseButtonState`).
#[allow(dead_code)] // the tray rewire (§1.2) constructs these; tests already do
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClickPhase {
    Down,
    Up,
}

/// What a tray click should do. The redesign deletes the tray menu: a click no
/// longer opens a menu — it signals the sidecar to focus/open the one app tab.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TrayAction {
    /// Signal the sidecar to open (or focus) the single app tab (spec §1.2).
    OpenApp,
}

/// Resolve a tray click to an action. Single-click, no menu, on BOTH platforms
/// (spec §1.2: "route left-click (both platforms) to `open_app`"): only a
/// left-button *release* opens the app; every other button/phase is ignored so a
/// press, a right-click, or a middle-click never double-fires or leaks a menu.
#[allow(dead_code)] // wired when the tray single-click rewire lands (§1.2)
pub(crate) fn click_action(button: ClickButton, phase: ClickPhase) -> Option<TrayAction> {
    match (button, phase) {
        (ClickButton::Left, ClickPhase::Up) => Some(TrayAction::OpenApp),
        _ => None,
    }
}

/// What the native splash should do for a given sidecar state (spec §3.3). This
/// window is sidecar-independent (a dead sidecar can't serve a browser tab), so
/// it owns boot progress AND failure recovery.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SplashSurface {
    /// Still booting — keep the progress UI, keep polling (up to a hard cap).
    Progress,
    /// Sidecar is up — fade the splash out (after the minimum display time).
    Dismiss,
    /// Sidecar failed/stopped — show the recovery UI and **hold it** until the
    /// user acts. Fixes the latent bug where a 12 s timer auto-dismissed the
    /// splash and ate the recovery affordance (spec §3.3).
    HoldRecovery,
}

/// Map a sidecar state to the splash surface. Pure — the splash poll loop in
/// `lib.rs` acts on the result instead of matching states inline, so the
/// "hold recovery, never auto-dismiss on failure" rule is unit-tested here.
pub(crate) fn failure_surface_for(state: SidecarState) -> SplashSurface {
    match state {
        SidecarState::Starting => SplashSurface::Progress,
        SidecarState::RunningAuthenticated | SidecarState::RunningUnauthenticated => {
            SplashSurface::Dismiss
        }
        SidecarState::Failed | SidecarState::Stopped => SplashSurface::HoldRecovery,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn left_release_opens_the_app() {
        assert_eq!(
            click_action(ClickButton::Left, ClickPhase::Up),
            Some(TrayAction::OpenApp),
        );
    }

    #[test]
    fn a_left_press_does_not_fire_yet() {
        assert_eq!(click_action(ClickButton::Left, ClickPhase::Down), None);
    }

    #[test]
    fn right_and_middle_clicks_do_nothing_no_menu() {
        assert_eq!(click_action(ClickButton::Right, ClickPhase::Up), None);
        assert_eq!(click_action(ClickButton::Middle, ClickPhase::Up), None);
    }

    #[test]
    fn starting_shows_progress() {
        assert_eq!(
            failure_surface_for(SidecarState::Starting),
            SplashSurface::Progress,
        );
    }

    #[test]
    fn running_states_dismiss() {
        assert_eq!(
            failure_surface_for(SidecarState::RunningAuthenticated),
            SplashSurface::Dismiss,
        );
        assert_eq!(
            failure_surface_for(SidecarState::RunningUnauthenticated),
            SplashSurface::Dismiss,
        );
    }

    #[test]
    fn failure_holds_recovery_never_auto_dismisses() {
        // The §3.3 fix, pinned: a failed/stopped sidecar must NOT resolve to
        // Dismiss (the old 12 s auto-dismiss that ate the recovery UI).
        assert_eq!(
            failure_surface_for(SidecarState::Failed),
            SplashSurface::HoldRecovery,
        );
        assert_eq!(
            failure_surface_for(SidecarState::Stopped),
            SplashSurface::HoldRecovery,
        );
        assert_ne!(
            failure_surface_for(SidecarState::Failed),
            SplashSurface::Dismiss,
        );
    }
}
