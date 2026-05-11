# PRD: Dashboard window ("Open Maximal")

## Problem

Today "Open Maximal" opens a single-purpose webview pointed at `/usage-viewer?endpoint=/usage` — the Copilot rate-limit dashboard. That answers exactly one question ("what's my Copilot budget?") and ignores the others a user has when they click their menu bar app:

- **Is the proxy actually serving?** No status indicator anywhere.
- **Is my auth still good?** No way to see token health without leaving the app.
- **How do I point my client at this?** Nothing surfaces the URL, headers, or a working example.
- **What's happening right now?** Daily log lives on disk; no tail.

We have two adjacent PRDs in flight — first-run setup (`/setup-status`) and Settings (provider keys, routing, etc.). The Dashboard is the *third* window in that triangle: the user's at-rest read-only view. It should compose the data the other two manage, not duplicate them.

## Goals

- Single primary window that answers "Is it on, is it healthy, what's it doing, and how do I use it?" in one scroll.
- Compose existing surfaces (`/usage`, `/setup-status`, `/_debug/state`, daily log) rather than build new business logic.
- Live updates for status + activity; static snapshot for usage (Copilot rate-limit data is rate-limited itself, can't poll cheaply).
- Reuse the same Vite-built page pattern as Settings and the setup window. One repo, three consistent surfaces.

## Non-Goals

- Editing anything. All writes belong in Settings. The Dashboard is read-only.
- A request inspector / mitmproxy-style timeline. Out of scope; daily log tail covers the "what just happened" need at v1 resolution.
- Multi-window / detachable panels. One window, sections, scroll.
- Replacing the existing standalone `/usage-viewer` page. That page remains for users who want a deep-link or share-a-link experience; the Dashboard reuses its data + chart code.

## Surface

A Tauri webview window at `http://localhost:4142/dashboard`, served from `shell/src/dashboard/` (Vite-built static bundle). The tray "Open Maximal" handler swaps from the current `/usage-viewer` target to `/dashboard`.

Window: `~960×720`, resizable, single-instance (re-show + focus if already open). The existing `DASHBOARD_LABEL` constant in `lib.rs` continues to identify this window — only the URL changes.

## Layout

Vertical stack, scrollable, one section per concern:

```
┌─────────────────────────────────────────────────────────────┐
│  ●  maximal  ·  v0.1.0+abcd1234  ·  serving on :4142   ⟳    │ ← status strip
├─────────────────────────────────────────────────────────────┤
│  Copilot                                                    │
│    Plan: Business      Tokens this month: 8,432 / unlimited │
│    [usage chart from existing /usage-viewer code]           │
├─────────────────────────────────────────────────────────────┤
│  Connect                                                    │
│    OpenAI-compatible:    http://localhost:4142/v1           │
│    Anthropic-compatible: http://localhost:4142              │
│    Header:               x-api-key: <generate in Settings>  │
│    [Copy curl]  [Copy env vars]                             │
├─────────────────────────────────────────────────────────────┤
│  Recent activity                                            │
│    14:32:01 POST /v1/messages claude-sonnet-4-6  200  1.2s  │
│    14:31:58 POST /v1/chat/completions gpt-5     200  0.4s  │
│    [...]                                                    │
│    [Open logs folder]                                       │
├─────────────────────────────────────────────────────────────┤
│  Quick actions                                              │
│    [Settings]  [Sign out]  [Restart proxy]  [Help]          │
└─────────────────────────────────────────────────────────────┘
```

### Section: Status strip

One row, persistent at top.

Left to right:
- **Dot indicator**: green = healthy, yellow = degraded (auth ok, but `/usage` failing or sidecar log warns), red = unhealthy (no token, sidecar down). Animated subtle pulse only on yellow/red.
- **App name + version line**: `maximal · v0.1.0+abcd1234 · serving on :4142`. Version pulls from `BUILD_VERSION` / `BUILD_GIT_SHA`.
- **Refresh button** (top-right): forces a re-fetch of all sections.

Data source: `/setup-status` (already specified in the first-run-setup PRD) — its `ready` field maps to green; `nextStep` reasons map to yellow/red.

If `/setup-status` returns `ready: false`, the entire Dashboard window swaps content for a "Setup not complete" panel with a CTA to open the setup window. Don't show stale data when the proxy isn't ready.

### Section: Copilot

Lift the existing `/usage-viewer` chart + numbers wholesale — same fetch, same chart library. Wrap in a section card. Loading state: skeleton. Error state: "Couldn't reach `/usage` (last attempt 14:32:01)" with a retry button. No polling — Copilot's usage endpoint is itself rate-limited.

Stretch goal (out of v1): show the proxy-side request counter as a complement (since the proxy can count requests it served regardless of upstream rate-limit response). Defer until we have a metrics endpoint.

### Section: Connect

The "how do I use this?" panel. Static content driven by config:

- **OpenAI base URL**: `http://localhost:<port>/v1`
- **Anthropic base URL**: `http://localhost:<port>`
- **API key header**: `x-api-key: <key>` — show "Generate in Settings → API clients" if `auth.apiKeys` is empty, else show a masked tail.
- **Sample curl** (collapsible, default open):
  ```sh
  curl http://localhost:4142/v1/chat/completions \
    -H "x-api-key: maximal_xxxxxx" \
    -H "content-type: application/json" \
    -d '{"model": "gpt-5", "messages": [{"role": "user", "content": "hi"}]}'
  ```
- **Sample env vars** (collapsible):
  ```sh
  export OPENAI_BASE_URL=http://localhost:4142/v1
  export OPENAI_API_KEY=maximal_xxxxxx
  export ANTHROPIC_BASE_URL=http://localhost:4142
  export ANTHROPIC_API_KEY=maximal_xxxxxx
  ```
- Two Copy buttons: "Copy curl" (full block, real key if generated), "Copy env vars" (real values).

Data source: `GET /config` (from the Settings PRD) for the API-keys list — masked tail only. Port comes from a new `GET /info` route or piggybacks on `/setup-status` (cheapest: extend the existing payload with `port` and `apiKeyTail`).

### Section: Recent activity

A live tail of today's daily log (`~/.local/share/maximal/logs/messages-handler-<date>.log`), filtered to one line per request.

Format: `HH:MM:SS  METHOD PATH  model  status  duration`.

Last 50 entries by default, scroll for more. Live-updates via Server-Sent Events from a new endpoint:

```
GET /activity/stream    (SSE, unauthenticated, sends one event per logged request)
GET /activity?limit=50  (snapshot, for initial render and reconnect)
```

Filter chips above the list:
- All / Anthropic / OpenAI / Errors
- Toggle: "Auto-scroll" (default on)

"Open logs folder" button at the bottom of the section — replaces the affordance removed from the tray menu in the earlier menu rename.

Privacy note: payloads are NOT shown in the Dashboard. Path + model + status + duration only. The daily log file (which contains payloads) is one click away for users who want depth.

### Section: Quick actions

Four buttons:
- **Settings** → opens the Settings window (matches tray-menu item).
- **Sign out** → confirmation dialog, then DELETE on the auth token; Dashboard re-renders to the setup-incomplete panel.
- **Restart proxy** → routes through the same Tauri command described in the Settings PRD (`POST /proxy/restart` semantics). Greyed out while not needed (no stale config).
- **Help** → opens the project README in the system browser.

## Backend changes

Mostly composing existing endpoints. New work:

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/dashboard` | — | static Vite bundle |
| `GET` | `/info` | — | `{ port, version, gitSha, gitBranch, apiKeyTail?, ready }` — convenience aggregate used by the status strip + connect section |
| `GET` | `/activity?limit=N` | — | array of `{ ts, method, path, model?, status, durationMs }` |
| `GET` | `/activity/stream` | — | SSE; one event per request as it completes |

All four unauthenticated, scoped to localhost via the existing middleware skip-list.

`/activity` data source: tail the daily log file directly (cheap; structured-ish lines). Future: in-memory ring buffer of the last N requests, populated by a request-lifecycle hook so we don't pay the log-parse cost. For v1, parse-on-demand is fine.

`/activity/stream` implementation: a Hono SSE handler subscribing to a process-wide `EventEmitter` populated by a new middleware that emits one event per response. Backpressure handled by Hono's `streamSSE` (already used for `/v1/messages` streaming responses).

## Live update strategy

| Section | Strategy |
|---|---|
| Status strip | Poll `/setup-status` every 5s when window is foregrounded; pause when minimized. |
| Copilot | Snapshot on open + manual refresh. Never auto-poll. |
| Connect | Static; re-fetch only on refresh or when Settings tells us a key changed. |
| Recent activity | SSE for live append; snapshot on initial mount + on reconnect. |

The Tauri webview has a `visibilitychange` event we can subscribe to so the page knows when it's hidden — stop SSE + polling, resume on re-show.

## Failure modes

- **Sidecar down** → status dot red, all sections render their last-known data with a "stale" badge. Status strip displays "Proxy not responding — last seen N seconds ago." Retry button.
- **`/setup-status` returns 503** during boot race → wait + retry up to 5s before declaring red.
- **SSE drops** → activity section auto-reconnects with exponential backoff capped at 30s; shows "Reconnecting…" subtle line above the list while disconnected.
- **Log file missing** (clean install, no requests yet) → activity section shows empty state "No requests yet. Once you point a client at maximal, requests will appear here."
- **API key missing** (Settings empty) → Connect section shows the headers with placeholders and a CTA: "Generate a key to enable client auth." The proxy still accepts all local requests when `auth.apiKeys` is empty (current behavior); the section notes this.

## Telemetry / Observability

- The Dashboard itself does not phone home.
- `/_debug/state` (verbose-mode) adds an `activity` block: ring-buffer size, SSE subscriber count.
- The activity endpoints log at debug-level (one line per stream connect/disconnect, never per event — would explode the log).

## Migration

- Today's `/usage-viewer?endpoint=/usage` URL keeps working — old bookmarks, old `lib.rs` builds. The new `/dashboard` is added alongside.
- Tray "Open Maximal" handler updated to open `/dashboard` after this PRD lands. The change is one-line in `lib.rs`'s `open_dashboard()`.
- No `config.json` changes. No on-disk file format changes.

## Open questions

1. **Should the Dashboard be window-on-launch?** macOS tradition is to start as a menu-bar app and only open windows on click. We've kept that for v1; revisit if user research suggests the dashboard should auto-open on first-run completion.
2. **Activity privacy at the model level.** Showing model + status + duration is non-sensitive. Showing the path includes message routing (e.g. `/v1/messages` vs. `/responses`) — fine. Showing the user prompt or system prompt is out (already excluded above). Confirm this is the right line.
3. **Per-host triple Dashboard window size.** macOS likes resizable, Windows users sometimes prefer a fixed size. Default to resizable everywhere; revisit if Windows users complain.
4. **Eventual: pin to top / always-on-top toggle.** Cheap to add (`window.setAlwaysOnTop`). Out of v1.
5. **Stream vs. WebSocket for `/activity/stream`.** SSE is simpler, one-way, fewer failure modes. Lean SSE. Switch to WebSocket only if we need server-side queries from the page (none planned).
6. **Reuse Settings' "Reveal config" button as a Dashboard footer?** Probably no — Settings already exposes the file path. Keep the Dashboard focused on read.

## Acceptance

A fresh launch on a setup-complete install:

1. Tray icon → Open Maximal.
2. Window opens within ~500ms; status dot is green; the version string + port are visible.
3. Copilot section shows the user's rate-limit chart, identical to the existing `/usage-viewer`.
4. Connect section shows real URLs, a masked API key tail (or placeholder + CTA), Copy buttons that put working content in the clipboard.
5. Recent activity shows the last 50 requests on initial load; firing a `curl` against the proxy from another terminal appends a new row within ~1s without manual refresh.
6. Clicking Settings opens the Settings window. Clicking Help opens the GitHub README.
7. Killing the sidecar (test only) flips the dot to red, surfaces the "Proxy not responding" message, freezes Copilot data with a "stale" badge, and SSE shows "Reconnecting…" before recovering when the sidecar comes back.

Throughout: no editing happens in the Dashboard. No raw JSON. No terminal use.
