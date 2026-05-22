---
id: ADR-0003
title: max wrapper command + per-platform install / uninstall gaps
status: proposed
date: 2026-05-21
authors:
  - stuffbucket
supersedes: []
links:
  uninstall_cli: src/uninstall.ts
  configure_claude_desktop: src/configure-claude-desktop.ts
  installers_workflow: .github/workflows/installers.yml
  release_workflow: .github/workflows/release.yml
  legacy_app_template: build/macos/app-template/
  tauri_shell_conf: shell/src-tauri/tauri.conf.json
related_files:
  scripts/max: posix shell wrapper that env-injects ANTHROPIC_*/OPENAI_*
  src/print-shell-key.ts: CLI subcommand the wrapper invokes
  src/routes/internal/route.ts: hosts the loopback-only /_internal/shell-key endpoint
---

# `max` wrapper + per-platform install / uninstall gaps

## Context

Two adjacent problems landed at the same time during v0.4.x:

1. **Cross-platform CLI ergonomics.** A non-technical user wants to run
   `claude`, `opencode`, etc. against the local proxy without editing
   their shell rc. The natural answer is a thin wrapper command
   (`max claude`, `max opencode`) that injects `ANTHROPIC_BASE_URL` /
   `ANTHROPIC_API_KEY` (and the OpenAI-shaped equivalents) and `exec`s
   the target. We need to decide what `max` actually *is* (script vs
   binary), where it lives on disk per OS, and how it survives uninstall.

2. **Cleanup gaps on uninstall.** Trashing
   `/Applications/Maximal.app` only removes the bundle — not the
   `~/Library/LaunchAgents/co.stuffbucket.maximal.plist` from the
   legacy `build/macos/app-template` shim, not
   `~/.local/share/maximal/` state, not `~/.local/bin/maximal` symlinks,
   not `claude_desktop_config.json` keys that
   `maximal configure-claude-desktop` wrote. Windows MSI uninstall
   removes manifest-declared files but not runtime state.
   Linux packages don't exist yet, but their `prerm` script will need
   the same treatment.

These are coupled because `max` is just another thing the installer
drops and the uninstaller has to remove. Deciding `max`'s shape
without deciding cleanup risks a v1 that ships a fourth orphan.

## Decision

### `max` is a shell script, not a compiled binary

- **POSIX (macOS / Linux):** `scripts/max` — a 30-line `/bin/sh`
  script. Reads the per-launch key via `maximal print-shell-key` and
  `exec env ... "$@"`s the target.
- **Windows:** ship a `max.cmd` + `max.ps1` pair when the Windows MSI
  flow lands. Same logic.

Rationale, in order of weight:

1. **Size honesty.** A Bun-compiled wrapper would be ~60 MB just to
   inject env vars and `exec` — that is the Bun runtime baseline.
   A Rust port is 1–3 MB but adds a new target-triple matrix to
   `release.yml`. A shell script is ~1 KB and rides on `/bin/sh`
   that every supported OS ships.
2. **No new toolchain.** No Rust crate, no `bun build --compile`
   target for the wrapper, no platform-specific build step.
3. **Migration path is open.** When v2 needs richer logic — detecting
   pre-existing `/login` state in Claude Code, prompting the user,
   etc. — porting the script to Rust or Go is mechanical. The first
   slice doesn't justify the complexity.

The downside accepted: shell scripts can't easily do auth-state
detection across all the tools we'll eventually wrap. v1 explicitly
defers that — see "Deferred" below.

### `maximal print-shell-key` is the seam

`max` doesn't read disk or sidecar state directly. It shells out to
`maximal print-shell-key`, which:

- Hits `GET http://127.0.0.1:4141/_internal/shell-key` on the running
  sidecar.
- The endpoint is loopback-only (rejects non-127.0.0.1 callers; no
  auth header required since presence on loopback is treated as the
  authentication).
- Returns the per-launch shell key in plain text.
- Exits non-zero with a clear stderr message if the proxy isn't
  running.

Why a new endpoint and not "read it from the sidecar's env":

- The CLI invocation has no relationship to the running sidecar
  process — it can't `getenv` from another process's PID.
- Reading from a state file would require writing the key to disk,
  which the per-launch design explicitly avoids (the key only lives
  in `state.shellApiKey` for the lifetime of the sidecar).
- A loopback HTTP request is the same surface every other Settings
  endpoint already uses, so the authentication model is unchanged.

### Install layout per platform

| OS | `maximal` binary | `max` script | Notes |
|---|---|---|---|
| macOS (DMG) | `/Applications/Maximal.app/Contents/MacOS/maximal` | `~/.local/bin/max` | First-launch symlinks both into `~/.local/bin/`. |
| macOS (Homebrew) | `/opt/homebrew/bin/maximal` | `/opt/homebrew/bin/max` | Formula installs both. |
| Linux (`.deb` / `.rpm`, future) | `/usr/local/bin/maximal` | `/usr/local/bin/max` | Package post-install drops both. |
| Windows (MSI, future) | `%LOCALAPPDATA%\Programs\Maximal\maximal.exe` | `%LOCALAPPDATA%\Programs\Maximal\max.cmd` + `max.ps1` | MSI manifest declares both. |

`max` always lives next to `maximal`. PATH is what makes the wrapper
discoverable from the user's shell — same PATH entry the existing
`maximal` install already establishes.

### Cleanup contracts per platform

This is the centerpiece — what we accept as a gap, what we close, and
how each survives a fresh install.

| Platform | Removed by `Trash` / MSI uninstall | Survives unless explicitly removed |
|---|---|---|
| macOS Trash | `/Applications/Maximal.app` | LaunchAgent plist (legacy), `~/Library/Application Support/Claude/claude_desktop_config.json` keys, `~/.local/share/maximal/`, `~/.local/bin/{maximal,max}` symlinks, `~/Claude` workspace folder |
| Windows MSI | Manifest-declared files in `%LOCALAPPDATA%\Programs\Maximal\` | Runtime state in `%APPDATA%\maximal\`, Claude Desktop config keys, PATH entries we didn't add |
| Linux (future) | Package-managed files | Runtime state in `~/.local/share/maximal/`, Claude Desktop config keys |

Three responses, applied in v0.4.x:

1. **In-app Uninstall card** (shipped in v0.4.2 — see
   feat/settings-ia-apps-endpoint PR) — Diagnostics section explains
   what survives and surfaces the existing
   `maximal uninstall --revert-claude` command. Tells the user the
   truth, gives them the one line to fix it.
2. **`maximal uninstall` is the canonical cleanup** for all platforms.
   Already handles launchd plist removal, binary removal, optional
   secrets purge, optional Claude config revert. We do not duplicate
   its logic in three places — installer hooks call this same
   binary.
3. **One-click uninstall in the menubar** is **deferred** to v0.5+
   because it needs a self-shutdown dance (UI calls the sidecar,
   sidecar runs `runUninstall`, exits cleanly) that's worth
   getting right rather than rushing.

## Deferred

These are explicitly out of scope for the v0.4.x slice:

- **`max` auth-state detection.** When the user has run `/login` in
  Claude Code, `max claude` should warn or refuse rather than silently
  override. Needs a research spike on Claude Code's auth state file
  (`~/.claude/.credentials.json` vs `settings.json` vs env-var-only
  paths) before the detection logic lands. The shell script will print
  a one-line warning today; the smarter detection ships when we move
  `max` to a real binary.
- **WiX custom action** for Windows MSI uninstall (invoke
  `maximal.exe uninstall --unattended` on remove). Lands when the
  Windows MSI flow itself lands — see `installers.yml`. No Windows
  user has shipped state today, so the gap is hypothetical.
- **Linux `prerm` hook**. Lands when the `.deb` / `.rpm` packages
  land. Linux `.tar.gz` users invoke `maximal uninstall` manually,
  same as today.
- **A stable named API key** for `max` instead of the per-launch
  shell key. The shell key rotates every sidecar restart; if a user
  starts a long-running `max claude` session and Maximal restarts,
  the child sees a stale key. v1 accepts this — the typical `claude`
  invocation is short. v2 lets the user pick an API-keys entry as
  the "default for `max`" and `print-shell-key` falls through to it.
- **One-click in-app Uninstall button.** v0.4.2 ships the
  documentation card. The button replaces it once the self-shutdown
  flow is implemented.

## Consequences

**Positive.**
- `max <tool>` shipped as a 1 KB script: zero new toolchain, zero new
  CI artifacts on macOS / Linux. Users with the existing macOS DMG get
  it via the next release.
- The Uninstall card already documents the cleanup gap honestly. We
  don't pretend Trash is the whole answer.
- `maximal print-shell-key` is the only new sidecar endpoint —
  loopback-only, no new auth surface.

**Negative.**
- Two-step uninstall on macOS (Trash + `maximal uninstall`) is worse
  than a single-click flow. We're shipping the documentation patch
  now and the button later — the gap is open for one release cycle.
- A user who never reads the Uninstall card will leak state. We
  accept this for v0.4.x because the legacy CLI installer already had
  the same property (the DMG users have today already has these
  orphans).

**Neutral.**
- The shell script is portable but unsigned. macOS Gatekeeper doesn't
  block scripts under `/opt/homebrew/bin` or `~/.local/bin` — they're
  treated as user content. No quarantine xattr issues expected.
- The per-launch key rotates on restart. Some `max claude` sessions
  will break mid-run if Maximal restarts. We treat this as
  acceptable for the typical short-lived CLI invocation and revisit
  if it becomes a real complaint.

## Links

- Earlier convo:
  `chore/secret-scanning` → `feat/tauri-shell-release-macos` → this
  ADR closes the loop on the cleanup question that surfaced when
  v0.4.0's DMG turned out to be the legacy CLI installer and the
  Trash gap became immediately visible.
- `src/uninstall.ts` — canonical cleanup logic.
- `src/configure-claude-desktop.ts` — what we wrote that we'd want
  reverted.
- `.github/workflows/installers.yml` — `tauri-macos` job is where the
  shell-script drop lands (one new step in `Re-zip signed .app`).
