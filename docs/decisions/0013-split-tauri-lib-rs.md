---
id: ADR-0013
title: Split shell/src-tauri/src/lib.rs into a module tree
status: proposed
date: 2026-06-15
authors:
  - stuffbucket
supersedes: []
related_adrs:
  - docs/decisions/0004-unify-shell-ui-on-react-islands.md
links:
  current_file: shell/src-tauri/src/lib.rs
  entry_point: shell/src-tauri/src/main.rs
  tauri_conf: shell/src-tauri/tauri.conf.json
---

# Split shell/src-tauri/src/lib.rs into a module tree

## Context

`shell/src-tauri/src/lib.rs` is **2016 lines** in one file with no
section markers (no `// ----` dividers). It holds at least eight
distinct concerns:

1. **State containers** — 9 `Mutex<Option<…>>` wrappers for Tauri's
   managed-state API: `Sidecar`, `LastRejection`, `LastSidecarError`,
   `AppStatus`, `SetupPromptShown`, `StartupAnnounced`,
   `SplashDismissed`, `SidecarRestarting`, `ShellApiKey`.
2. **Sidecar lifecycle** — spawn the bundled `maximal` binary, hold
   the `CommandChild`, `Drop` impl that kills, SIGTERM-then-SIGKILL
   escalation, respawn for the account-switch reboot.
3. **Tray state machine** — `Starting → RunningAuthenticated /
   RunningUnauthenticated / Attention → Failed`, icon swaps, menu
   rebuilds on every transition.
4. **Two background polling loops** — token-usage poller (drives
   the Dashboard's `Channel<TokenUsageEvent>`) and upstream-
   rejection poller (drives the ATTENTION tray icon + one-shot OS
   notifications).
5. **Splash window** management (show during Starting; dismiss on
   first Running; never recreate, per the SplashDismissed guard).
6. **Settings + Dashboard window** construction and section routing.
7. **OS notifications** with one-shot dedupe rules so auth-flip
   transitions don't re-announce "we're running".
8. **`#[tauri::command]` fns** (7 of them): `subscribe_token_usage`,
   `get_shell_api_key`, `open_settings_at`, `open_dashboard`,
   `reveal_config_dir`, `reveal_logs_dir`, `restart_sidecar`.
9. **`pub fn run()`** — entry that wires everything: builder,
   plugins, managed state registrations, setup hook, command
   handler registration.

`main.rs` is already minimal (6 lines, calls `run()`). The single-
file `lib.rs` is the only place this code lives.

The cost pattern is identical to the 1360-line vanilla
`shell/src/main.ts` that ADR-0004 addresses on the frontend side:

- New OS-integration features (the rejection poller, the splash
  dismissal logic, account-switch respawn) have all been appended
  to the bottom rather than slotted into a clear module.
- Reviewers diff against the whole file for any change.
- No enforced module boundary makes test scaffolding awkward (Rust
  unit tests typically live in `#[cfg(test)] mod tests` per
  module — that's painful when the module is 2000 lines).
- A future contributor onboarding to the Tauri shell has to read
  the whole file to find where any concern lives, instead of
  navigating an index `lib.rs` → topic file.

This isn't a behavioral problem — the file works. It's the same
architectural-debt class the React-island migration is fixing on
the frontend: too much in one place, no boundaries.

## Decision

Split `shell/src-tauri/src/lib.rs` into a module tree under
`shell/src-tauri/src/`. Target layout:

```
shell/src-tauri/src/
  main.rs                # unchanged: 6 lines, calls lib::run()
  lib.rs                 # ~150-200 lines: pub fn run() + mod wiring
  sidecar.rs             # Sidecar struct, spawn, Drop, SIGTERM/SIGKILL,
                         #   respawn_sidecar, SidecarRestarting guard
  tray.rs                # SidecarState enum, icon swaps, menu construction,
                         #   refresh_tray helpers
  state.rs               # the 9 Mutex<Option<…>> state containers
                         #   (or split into 2-3 thematic state files if
                         #   the 9 don't cluster cleanly)
  poll/
    mod.rs               # spawn_pollers() — wires both loops
    token_usage.rs       # token-usage poller + Channel emission
    rejection.rs         # upstream-rejection poller + tray effect +
                         #   OS-notification side effect
  windows.rs             # splash + settings + dashboard creation,
                         #   section URL routing
  commands.rs            # the 7 #[tauri::command] fns, each delegating
                         #   to helpers in the topic module that owns
                         #   the state they touch
  notifications.rs       # one-shot dedupe guards + emit helpers
```

Each module 150-400 lines. `lib.rs` becomes a navigation index plus
the `pub fn run()` entry that wires plugins, managed state, the
setup hook, and the command handler registration.

Rust visibility rules:

- Internal types are `pub(crate)` so other modules in the same crate
  can reach them but downstream consumers can't.
- The state-container types stay `pub(crate)` since they're
  registered with `app.manage(...)` from `run()`.
- The `#[tauri::command]` fns stay `pub` (Tauri's macro requires it).

## Alternatives considered

- **Leave as-is, add section markers.** Cheaper but doesn't fix the
  navigability or test-scaffolding cost. Section markers degrade
  over time as people append below them.
- **Split into a separate crate** (`maximal-shell-core` workspace
  member). Overkill. Single binary, no external consumers; modules
  in one crate are correct here.
- **Split by feature instead of by concern** (e.g. one file per
  invoke command). Produces too many tiny files and doesn't match
  how the state is shared — multiple commands touch the same
  `AppStatus` / `Sidecar`.
- **Wait until adding the next feature** forces the split. The
  pattern of "append below the bottom" has been going for a while;
  the forcing function never comes naturally.

## Consequences

- New OS-integration features have a natural home (a module per
  concern). Adding upstream-rejection logic touches `poll/rejection.rs`,
  not "somewhere in lib.rs."
- Per-module `#[cfg(test)] mod tests` becomes practical. Today
  there are zero Rust-side unit tests in `shell/src-tauri/`; the
  split lowers the activation energy for the first ones.
- `cargo build` enforces the module boundaries — no risk of
  reaching into another module's internals once visibility is
  declared.
- One-time mechanical cost (~1 focused day). No business-logic
  change. No Tauri config change. No tauri.conf.json change.

## Migration

Sequence to keep the build green at every step:

1. Create `state.rs` and move the 9 state containers (each is a
   self-contained `struct + impl`). Re-export via `mod state; use
   state::*;` at the top of `lib.rs`. `cargo build`. Should pass.
2. Create `sidecar.rs` and move the Sidecar struct, `Drop` impl,
   `respawn_sidecar`, SIGTERM/SIGKILL escalation. Re-export. Build.
3. Create `tray.rs` and move `SidecarState` (the high-level enum,
   distinct from the `Sidecar` struct), icon-swap, menu-build
   helpers. Build.
4. Create `poll/{mod.rs,token_usage.rs,rejection.rs}` and move the
   two polling loops + their helpers. The pollers spawn tokio tasks
   from `run()`; expose one `spawn_pollers(app: &AppHandle)` from
   `poll::mod.rs`. Build.
5. Create `windows.rs` and move splash/settings/dashboard window
   creation. Build.
6. Create `notifications.rs` and move the OS-notification emit
   helpers + their one-shot guards. Build.
7. Create `commands.rs` and move the 7 `#[tauri::command]` fns.
   Update the `tauri::generate_handler![...]` macro call in
   `run()` to reference `commands::*`. Build.
8. `lib.rs` now contains only `pub fn run()` (and any tiny
   constants like `BOOT_STATUS_MARKER`). Compare line counts to
   the target; if `run()` is still long, consider extracting a
   `setup_app(app)` helper to `setup.rs`.

Run `cd shell && bun run tauri dev` after each step to confirm the
app still boots, the tray still appears, sign-in still works, and
the sidecar still terminates on app quit.

## Out of scope

- Adding Rust-side unit tests. The split enables them; writing them
  is a follow-up.
- Refactoring the polling loops themselves (current sleep-loop +
  abort flag pattern is fine).
- Migrating any logic from Rust to TypeScript or vice versa.
- The frontend `shell/src/main.ts` split — covered by ADR-0004.

## Open questions

- The 9 state containers may not cluster cleanly into one `state.rs`.
  If they fall into obvious thematic groups (e.g. "sidecar lifecycle
  state" vs "UX one-shot guards" vs "polling snapshots"), split into
  `state/{lifecycle,oneshot,polling}.rs`. Decide during the move
  based on what reads cleanly.
- Should the `BOOT_STATUS_MARKER` constant (mirroring
  `src/start.ts`) live in `sidecar.rs` (where it's consumed) or a
  small `constants.rs`? Recommendation: `sidecar.rs`, with a
  comment cross-referencing the TS source. One constant doesn't
  warrant a dedicated file.
- Do we need a `prelude.rs` to re-export common types? Likely no
  — most modules need only 1-2 imports from siblings. Add only if
  the import lines grow noisy.
