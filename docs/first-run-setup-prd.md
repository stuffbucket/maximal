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

> **Revised against `.design-context.md` and the design-onboard skill.**
> The earlier "four cards in canonical order" model leaked the backend
> mental model into the UI. Only `githubAuth` requires human action;
> the others self-heal or block as exceptional errors. The flow below
> is **one primary action, three states**, optimized for time-to-aha.

### What the user is actually trying to do

A developer on macOS installed maximal from a `.dmg` because they
want to route their AI tooling (Claude Code, Cursor, an SDK script,
opencode) through their existing GitHub Copilot subscription. The
**aha moment** is not "I am signed in" — it is **"my client made a
request and got a response through maximal."** Setup's job is to
remove the only barrier between launch and that moment, then bridge
into the surface where it actually happens (the Dashboard's
Connect + Activity sections).

### Detection on shell launch

The Tauri shell spawns the sidecar at launch and polls
`GET http://localhost:4142/setup-status`, retrying for ~5 seconds
while the sidecar binds.

- **`ready: true`** — tray + dashboard behave as normal.
- **`ready: false` with `nextStep === "githubAuth"`** (the only
  expected pre-setup state in practice) — tray shows a quiet badge,
  the dashboard menu item subtitles "Setup required," and any
  click into the app opens the Setup window.
- **`ready: false` with `nextStep === "appDir" | "config" | "db"`**
  — exceptional. The Setup window's normal welcome content swaps
  for an inline error block (see Failure Modes below). These are
  blockers, not onboarding steps; treating them as cards in a flow
  conflates "the proxy can't run" with "you haven't signed in yet."

### Setup window — three states, one window

A single Tauri webview at `http://localhost:4142/setup`, served from
`shell/src/setup/` (Vite bundle). 520×620 default. Single column,
content max 440px, centered vertically. **No sidebar, no card
nesting, no "step X of N" indicator** — there is one step.

The window has three mutually exclusive states driven by the
device-code lifecycle plus `/setup-status`. The window does not
navigate between routes; it swaps content with a 200ms opacity
crossfade (instant when `prefers-reduced-motion`).

#### State 1 — Welcome (default for an unauthed first launch)

```
                  [brand m]

           Welcome to Maximal

   Route Claude Code, Cursor, or any Anthropic-
   or OpenAI-compatible client through your
   GitHub Copilot subscription.

   Two minutes to set up.


   ┌──────────────────────────────────┐
   │   Sign in with GitHub      →     │   ← primary, single CTA
   └──────────────────────────────────┘


   Already signed in via the CLI?
   Maximal will pick up the existing token —
   close this window and reopen.
```

Notes:
- **Display heading** uses the Fraunces serif (one humanist accent
  per the design-context). Body is Commissioner (per the typeset
  pairing).
- **Honest time estimate** ("two minutes") instead of "Get started"
  — respects user intelligence per the onboarding skill.
- **Rescue path for CLI migrants** is the second-most-important
  thing on the screen, but explicitly secondary type. Someone who
  installed via Homebrew + CLI auth can close the window and skip
  setup entirely; we want them to feel they're already done.
- **No "Skip" button** — there's nothing else to do. Skipping setup
  is closing the window.
- **No telemetry copy, no "By signing in you agree to..."** — the
  agreement is between the user and GitHub, not us.

#### State 2 — Waiting for GitHub approval

Triggered when the user clicks "Sign in with GitHub":

1. Setup page POSTs `/auth/start`. Proxy calls GitHub's device-code
   endpoint via existing `setupGitHubToken` logic, returns
   `{ verification_uri, verification_uri_complete?, user_code,
   expires_in, interval }`.
2. Proxy writes `user_code` to the OS clipboard (already done in
   `src/lib/token.ts:165`).
3. Setup page calls Tauri's `opener::open_url(...)` for
   `verification_uri_complete ?? verification_uri`.
4. Setup page transitions to State 2 and starts polling `/auth/poll`
   every `interval` seconds.

```
                  [brand m]

              Almost there

   We opened github.com/login/device in your
   browser. Paste this code and approve:

         ┌────────────────────────┐
         │       ABCD-EFGH        │   ✓ copied
         └────────────────────────┘

   We'll pick it up the moment you approve.

   ────────────────────────────────────
   Code expires in 9:42                ← live mm:ss

   [ Open browser again ]              ← fallback only;
                                         secondary style
```

Notes:
- **Code is the focal point.** Display size, monospace
  (`--font-mono`), high-contrast text — readable across the room
  in case the user moved their browser to a second monitor.
- **"✓ copied"** confirmation appears immediately, fades after 4s.
  No toast. No modal. The page is the affordance.
- **Live `mm:ss` countdown** of `expires_in` — concrete, not "a few
  minutes." On <60s remaining, the countdown switches to red and a
  subtle "Code expires soon" inline appears (no modal).
- **"Open browser again"** is the recovery affordance for the user
  who dismissed the browser tab. Secondary style; not a primary
  CTA. Does NOT request a new code — same code, same expiry.
- **No "Cancel" button.** Closing the window via the OS chrome
  cancels. Tray icon retains the badge so they can return.

#### State 3 — Connected (success bridge)

Triggered by `/auth/poll` returning `{ status: "ready" }`. Brief
moment (~600ms) for the user to see the success before the bridge.

```
                  [brand m]

             You're connected

      Signed in as @stuffbucket.
      Maximal is serving on localhost:4142.


      Next: point a client at it.


   ┌──────────────────────────────────┐
   │   Show me how              →     │   ← bridges to Dashboard
   └──────────────────────────────────┘
```

Click "Show me how":
- Setup window closes.
- Dashboard opens with the **Connect section scrolled into view**
  (deep-link via `#connect` anchor).
- The Activity section below is empty, but its empty state teaches
  the next action (see "Activity empty state" below).

If the user closes State 3 without clicking the bridge, no harm:
the tray's "Open Maximal" now opens the Dashboard directly.

### Activity empty state — the actual aha moment

Lives in the Dashboard PRD's Recent Activity section. Specified
here because it's the second beat of the onboarding arc, and the
Setup → Dashboard bridge depends on it being right.

```
   Recent activity
   ────────────────────────────────

         No requests yet.

         Try this from a terminal:

   ┌──────────────────────────────────┐
   │  curl http://localhost:4142/v1/  │
   │       chat/completions \         │
   │    -H "x-api-key: maximal_…"  \  │   ← real key, masked
   │    -H "content-type: application │
   │            /json" \              │
   │    -d '{"model":"gpt-5",         │
   │         "messages":[{"role":     │
   │         "user","content":"hi"}]}'│
   └──────────────────────────────────┘
              [ Copy ]

   Your first request will appear here
   when it arrives.
```

Notes:
- **Real working command** — pre-populated with the user's actual
  port, model, and either their first generated API key (if one
  exists) or a single-line note "Generate a key in Settings →
  API clients" with a deep-link.
- **Show, don't tell.** No tutorial popup. No "Click here to
  continue." The instruction IS the action.
- **The feed will SSE-update** the moment that curl completes; the
  user sees their request transcribed in real time in the same
  window. That's the peak moment.

### Tray menu while not ready

The earlier PRD spec'd a "Sign in with GitHub" tray-menu item as a
bypass. Re-evaluating: this duplicates the Setup window's CTA and
adds a menu item that disappears on first success. Drop it. The
Setup window is one click away from "Open Maximal" and shows the
same affordance.

Tray menu while unauthed:

```
[badge] maximal
   Open Maximal       (subtitled: "Set up first")
   Settings
   ──────────
   Quit Maximal
```

The "Set up first" subtitle is the breadcrumb. Clicking the
greyed item still opens the Setup window — the greying is signal,
not a block.

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
