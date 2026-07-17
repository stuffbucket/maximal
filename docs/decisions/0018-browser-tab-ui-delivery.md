---
id: ADR-0018
title: Deliver the shell UI as a browser tab, not a Tauri webview
status: proposed
date: 2026-07-14
authors:
  - stuffbucket
supersedes: []
links:
  spec: docs/spec/single-window-redesign.md
  ui_route: src/routes/ui/route.ts
  shell_lib: shell/src-tauri/src/lib.rs
  run_server: src/lib/start/run-server.ts
---

# Deliver the shell UI as a browser tab, not a Tauri webview

## Context

Today the shell opens two Tauri webview windows — Settings and Dashboard —
each pointed at a sidecar `/ui/*` URL (`WebviewUrl::External`). The
single-window redesign (see spec) collapses the UI to one surface. That
forced a delivery decision: keep a Tauri webview, or serve the UI into the
user's **real browser tab**.

Six spikes (including two empirical on-host tests in Safari + Edge)
established that a **sidecar-mediated single browser tab** is achievable with
**no PWA, no service worker, and no native scripting** — a tray click routed
through the sidecar closes a stale tab over a WebSocket and opens one fresh
foreground tab, measured to yield exactly one focused tab in both browsers.
Browser delivery also gains real DevTools, the user's extensions, and drops
the WKWebView/WebView2 quirks. ADR-0014 already listed "tray-only Tauri,
dropping the native Settings window" as an open conversation; this realizes
it.

## Decision

Deliver the UI as a **sidecar-served browser tab**. Tauri shrinks to a **tray
+ sidecar supervisor + a native splash/boot/failure window** (the splash is
Tauri-bundled and sidecar-independent, so recovery survives a dead sidecar —
which cannot serve a browser tab). The tray click is routed through the
sidecar, which owns the tab lifecycle (see ADR-0019). No PWA, no service
worker, no native OS automation.

## Alternatives considered

- **Tauri webview (status quo mechanism).** Free single-window + focus +
  splash, no routing refactor, no CSRF-forcing — but WKWebView/WebView2
  quirks and no user extensions/DevTools. Not chosen; the browser experience
  and simpler shell won.
- **Local `app.html` hosting the sidecar UI in an iframe.** Over-engineered —
  it existed only to keep recovery chrome in-window; moving recovery to the
  native splash deletes the whole iframe/`__TAURI__`-in-subframe/IPC-bridge
  problem.
- **Installed PWA (`launch_handler: focus-existing`).** Clean single-instance
  focus, but Chromium-only and install-gated. Rejected — a required install
  step and a browser matrix.
- **AppleScript focus-or-open.** Solves focus+dedup but needs a per-browser
  macOS Automation (TCC) grant (hard-denied with no prompt on the test host)
  and dies on Firefox/off-mac. Excluded by the "no native scripting" line.

## Consequences

- The browser UI must not depend on `window.__TAURI__`: every `invoke()`
  becomes a sidecar HTTP/WS call, and recovery actions live in the native
  splash. (Bonus: the browser-loaded UI stops having the dead buttons it has
  today when opened outside Tauri.)
- The tray-open URL and the WebSocket endpoint must derive from the sidecar's
  **discovered bound port**, never a literal `4141` (`dev`=4242, `beta`,
  `--port`, `:0` all exist).
- **Control-surface hardening becomes mandatory** (ADR-0021) — a real browser
  origin makes the pre-existing CSRF hole exploitable.
- A browser-support matrix appears: Chromium + Safari validated; Firefox and
  Windows/Linux are unverified and treated as degraded pending a spike.
- A separate **read-only `/ui/diagnostics`** page becomes the safe browser
  debug affordance; the app UI carries no debug special-casing.

## Migration

Spec §1, §7. Remove `open_settings_window`/`open_dashboard_window` and the two
webview window labels; keep the splash; the tray gains `open_app` (signal the
sidecar) + `quit_app`. The `architecture.md` Tauri-shell paragraph is rewritten.

## Out of scope

- Installed-PWA / app-store delivery.
- Firefox / Windows / Linux parity (spike separately before claiming support).

## Open questions

- Firefox/Windows/Linux behavior for the open-fresh-and-close-stale flow —
  unverified on the macOS+Safari/Edge test host.
