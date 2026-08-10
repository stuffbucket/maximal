---
id: ADR-0024
title: Electron main owns the private control-plane connection
status: accepted
date: 2026-08-09
authors:
  - stuffbucket
amends:
  - docs/decisions/0023-control-plane-jsonrpc-over-http-sse.md
depends_on:
  - docs/decisions/0021-control-surface-hardening.md
  - docs/decisions/0023-control-plane-jsonrpc-over-http-sse.md
---

# Electron main owns the private control-plane connection

## Context

ADR-0023 chose stateless JSON-RPC 2.0 over HTTP+SSE for the sidecar control
plane, but left the Electron native-window trust boundary open. The first client
implementation gave the product renderer the sidecar's private, ephemeral
control origin and constructed `ControlClient` instances there. Electron main
then stripped outgoing `Origin` and `Referer` headers and added permissive CORS
response headers so those renderer requests could bypass maximal-core's
ADR-0021 browser-origin defense.

That arrangement made every current and future control method reachable to
renderer code. The UI needs only a small set of auth and account operations;
it does not need the private origin, discovery response, arbitrary method
names, raw control snapshots, or destructive process/account operations.

## Decision

1. **Electron main is the only product-client process that holds the private
   control origin.** It owns discovery, the live `ControlClient`, and the
   reconnecting SSE subscription for the lifetime of the app.
2. **Preload exposes named capabilities only.** The renderer may request auth
   status/start/cancel/sign-out, list/switch accounts, read the public proxy URL,
   observe redacted sidecar lifecycle state, and open a validated HTTP(S) URL.
   It cannot invoke an arbitrary control method or access raw Electron IPC.
3. **Discovery remains in main.** `server/discover`, including any
   `ports.control` value, never crosses IPC. Main validates the running
   sidecar's protocol version, identity, required methods, and feed support
   before installing a client.
4. **Control errors cross IPC as typed values.** Main preserves the JSON-RPC
   code, reason, retryability, request id, and remediation URL because Electron
   does not preserve custom `Error` fields through `ipcRenderer.invoke`.
5. **Control-change events carry no state.** They tell renderer adapters to
   re-read through their named capabilities. Unsubscribing a renderer listener
   never closes main's app-scoped SSE connection.
6. **Sidecar restarts replace the main-owned client.** A generation guard drops
   stale callbacks from the old ephemeral origin.
7. **The renderer CORS shim is removed.** Electron no longer strips browser
   security headers or rewrites maximal-core's CORS response. This restores
   ADR-0021's Origin protection instead of impersonating a non-browser client.
8. **Unneeded methods receive no bridge channel.** This includes
   `accounts/remove`, `app/quit`, `app/upgrade`, `config/get`, and every other
   method not explicitly required by the current First-run and Settings
   capability interfaces.

This amends ADR-0023 section 6 and closes its Electron native-window origin
question. ADR-0023's wire protocol, stateless semantics, and five
client/sidecar design rules remain unchanged.

## Consequences

- A compromised product renderer cannot learn the private control origin or
  select arbitrary present or future core methods.
- First-run and Settings retain their existing component-facing capability
  interfaces; only their transport adapters change.
- The public `414x` proxy URL remains available to the renderer for display and
  copy because external API clients are expected to use it.
- Main owns one app-scoped reconnect loop instead of each renderer surface
  owning a connection.
- Adding a new renderer capability now requires an explicit shared type,
  preload method, main handler, and boundary test.
- A future core-served diagnostics page is a separate consumer. This ADR does
  not grant it the product renderer's IPC capabilities or decide its
  authentication model.

## Rejected alternatives

- **Keep renderer-direct HTTP+SSE and the CORS shim.** This deliberately defeats
  the browser-origin control that protects the private loopback surface.
- **Expose a generic `call(method, params)` IPC bridge.** It moves the socket but
  preserves arbitrary method authority, including future methods unknown to
  the renderer when shipped.
- **Relay a redacted discovery or control snapshot.** The current UI consumes
  neither. Named reads and payload-free invalidation events are narrower and
  do not require a growing redaction policy.

## Verification

- Main and preload tests assert the exact named IPC/bridge allowlists and the
  absence of `core:origin` and a generic call channel.
- Lifecycle tests prove a ready event carries the public proxy URL but no
  control origin.
- Renderer lint rules prohibit importing `ControlClient`, the wire contract, or
  IPC channel constants.
- Packaged-app E2E inspects the real preload surface while retaining runtime
  assertions for context isolation, disabled Node integration, and sandboxing.
- Main tests prove Electron webRequest CORS hooks are never registered.
