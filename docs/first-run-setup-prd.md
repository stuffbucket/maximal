# PRD: First-Run Setup Detection & GUI Setup Flow

## Problem

Maximal's setup story is CLI-shaped: `maximal auth` runs an interactive device-code flow, prints a code, copies it to the clipboard, polls until the user approves. That works because there's a terminal.

When a user installs maximal from a `.dmg` and launches it from `/Applications`, **there is no terminal**. The Tauri shell starts the sidecar (`maximal start --port 4142`), the tray icon appears, the user clicks "Open Maximal" — and gets a dashboard pointed at a proxy that may have:

- no GitHub token → every Copilot request 401s
- no `~/.local/share/maximal/` dir → file writes fail with EACCES/ENOENT
- a stale or invalid `config.json` → server may have refused to boot

None of these are surfaced as actionable UI. The proxy may just be silently broken.

This PRD covers detection on every launch, a machine-readable status surface, and a GUI flow for executing the remaining setup steps without a terminal.

## Goals

- On every launch (CLI or shell), maximal knows whether it is ready to serve.
- The Tauri shell can ask one HTTP question to find out, and renders a setup window if anything is missing.
- The GUI setup flow uses the existing device-code OAuth — no new auth path, no browser-bound callbacks.
- CLI behavior unchanged: `maximal auth` and `maximal start` keep their existing prompts and exits.

## Non-Goals

- Provider keys (Anthropic, OpenAI). Surfaced read-only in Settings later; not part of first-run.
- Browser-redirect OAuth. Device-code already works everywhere; redirect flow adds attack surface (open ports, callback routing) for no UX gain on a desktop app.
- Online updater / first-launch migration UI. The existing path-rename auto-migration handles the only known migration.

## Setup State Machine

A "setup check" is a named boolean with a reason string when false. The proxy exposes the aggregate via `GET /setup-status`:

```json
{
  "ready": false,
  "checks": {
    "appDir":     { "ok": true,  "path": "~/.local/share/maximal" },
    "config":     { "ok": true,  "path": "~/.local/share/maximal/config.json" },
    "db":         { "ok": true,  "path": "~/.local/share/maximal/copilot-api.sqlite" },
    "githubAuth": { "ok": false, "reason": "github_token missing" }
  },
  "nextStep": "github_auth"
}
```

| Check        | Pass condition                                                                                       |
|--------------|------------------------------------------------------------------------------------------------------|
| `appDir`     | `~/.local/share/maximal` (or `$COPILOT_API_HOME`) exists, writable.                                  |
| `config`     | `config.json` either absent OR parses through the zod `AppConfig` schema. Empty = OK = defaults.     |
| `db`         | `copilot-api.sqlite` opens, is on the current schema (migrations not pending).                       |
| `githubAuth` | `github_token` file present, non-empty, validates against Copilot's token-introspection endpoint.    |

`ready = all(ok)`. `nextStep` is the first failing check in canonical order (`appDir` → `config` → `db` → `githubAuth`), or `null` when ready.

The endpoint is **unauthenticated** — same posture as `/` and `/usage-viewer`. It must work *before* any API key has been issued.

## Detection

### Where checks happen

- **At process start** (`src/main.ts` `start` command): existing path-creation + token-load logic is already most of this. Surface results to the trace log; do not exit on missing-auth (the GUI needs the proxy alive to call `/setup-status`).
- **At `/setup-status` request time**: cheap re-evaluation each call; ms-scale, no caching needed.

### What changes in the proxy

- New module: `src/lib/setup-status.ts`. Pure function `evaluateSetup(): SetupStatus`, no I/O hiding. Composed of per-check helpers already implemented in `src/lib/paths.ts`, `src/lib/config.ts`, `src/lib/github-token-store.ts`.
- New route: `GET /setup-status` (handler under `src/routes/setup-status.ts`). Bypasses `createAuthMiddleware`.
- Boot path: `src/server.ts` registers the route before the auth middleware so it's reachable when no API key is configured.

### What does NOT change

- `maximal auth` and `maximal start` exit codes and prompts.
- Existing auth tests.
- The `/_debug/state` surface (kept; complementary, deeper).

## GUI Execution

### Detection on shell launch

The Tauri shell already spawns the sidecar at launch. After spawn it polls `GET http://localhost:4142/setup-status` with a short timeout, retrying for ~5 seconds while the sidecar binds.

- **If `ready: true`:** behave as today. "Open Maximal" opens the dashboard webview.
- **If `ready: false`:** the tray icon shows a state badge (small dot overlay). Left-click opens a **setup window** instead of the dashboard webview. The dashboard menu item is greyed out with subtitle "Setup required."

### Setup window

A single Tauri webview window (~520×600) loading `/setup` on the sidecar. The page is a static Vite-built HTML+TS bundle from `shell/src/setup/` driven by the same `/setup-status` data.

Layout: one card per failing check. Cards render in canonical order; later cards are disabled until earlier ones pass.

#### `githubAuth` card — the only interactive case for v1

UI:
- Heading: "Sign in to GitHub Copilot"
- Body: "Maximal proxies your existing GitHub Copilot subscription. Sign in once; we'll keep the token in `~/.local/share/maximal/`."
- Primary button: "Sign in with GitHub"

Flow on click:
1. Setup page POSTs `/auth/start`. Proxy invokes the existing `setupGitHubToken` initiator (see `src/lib/token.ts`), which calls GitHub's device-code endpoint. Returns `{ verification_uri, verification_uri_complete?, user_code, expires_in, interval }`.
2. Proxy writes the user-code to the OS clipboard (already done in `src/lib/token.ts:165`). Setup page reflects "Copied to clipboard."
3. Setup page calls Tauri's `opener::open_url(verification_uri_complete ?? verification_uri)` to launch the default browser. The user pastes the code, approves.
4. Setup page polls `GET /auth/poll` every `interval` seconds (default 5s, RFC 8628). The proxy threads through the existing polling logic; when the token arrives it persists to `github_token` and returns `{ status: "ready" }`.
5. Setup page calls `GET /setup-status` once more, animates the card from "Action needed" → "Done," then advances to the next failing card, or — if `ready: true` — closes the setup window and triggers the dashboard.

#### Other cards (`appDir`, `config`, `db`)

These should self-heal on every boot via existing logic (`ensurePaths`, zod-default-fill, sqlite migrations). If one of them is still failing at `/setup-status` time, the card shows:

- The check name, the reason string, and the resolved path.
- A "Reveal in Finder" button (already wired via `opener`).
- A "Retry" button that re-runs boot-path init and re-polls `/setup-status`.

No automatic write/overwrite from the GUI; the user's filesystem state should not be silently mutated past what the proxy already does on its own.

### Tray menu while not ready

```
[badge] maximal
  • Open Maximal        (greyed: "Setup required")
    Settings
    ─────────────
    Sign in with GitHub
    Quit Maximal
```

The "Sign in with GitHub" item is the same primary action as the setup window's button; one-click bypass for users who close the setup window without finishing.

## Failure Modes

- **Sidecar doesn't bind to 4142 within 5s.** Shell shows a "Maximal failed to start" tray subtitle + Settings → Reveal logs. Same path users have today, just made explicit.
- **`/setup-status` returns 500.** Treat as `ready: false` with reason "internal error"; surface in setup window with a "Reveal logs" affordance.
- **Device-code polling slow / token never arrives.** Setup page surfaces the remaining `expires_in` countdown; on expiry, offers "Try again" which re-invokes `/auth/start`.
- **User closes setup window mid-flow.** Tray persists; the auth state is whatever the proxy has so far. Reopening the setup window resumes polling against the still-live device code if not expired.

## Telemetry / Observability

- `/_debug/state` gains a `setup` block mirroring `/setup-status` (same shape, served behind the verbose flag).
- Each `/setup-status` call logs at debug-level only — not info — to avoid noise during shell polling.
- Boot path logs `evaluateSetup()` result once at info-level.

## Migration

The Tauri shell already exists. The proxy side is additive (one new route, one new module). No on-disk format changes. Users upgrading from a working CLI install will have `ready: true` immediately; the setup window never appears.

## Open Questions

1. Should `/setup-status` include a check for *available* provider keys (Anthropic etc.) as an advisory? Lean **no** for v1 — out-of-scope per Non-Goals — but the shape is forward-compatible.
2. Should the setup window survive a sidecar crash? Lean **yes** — display "Sidecar offline, retrying…" rather than going blank.
3. Should the tray badge persist on subsequent launches once setup completes, or only show during the unsetup phase? Lean **only unsetup**; ready = no badge.
4. CLI `maximal setup-status` command (machine-readable mirror of the HTTP route) — useful for shell scripts and `claude-code` plugins. Cheap; include in v1 unless it complicates the citty CLI surface.

## Acceptance

A fresh `.dmg` install on a Mac with no `~/.local/share/maximal/` directory:

1. User double-clicks Maximal.app.
2. Tray icon appears within ~2s; carries a "needs setup" badge.
3. Clicking the tray icon shows: greyed dashboard item, Settings, "Sign in with GitHub," Quit.
4. Clicking "Sign in with GitHub" (or the icon) opens the setup window.
5. The user signs in via the browser, code is pre-pasted.
6. Within ~10s of approval, the setup window closes and the dashboard opens against a working proxy.
7. Subsequent launches go straight to the dashboard with no badge, no setup window.

No terminal touched. No env vars set. The CLI install path remains unchanged.
