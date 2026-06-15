---
id: ADR-0007
title: Replace shell polling with sidecar-pushed SSE events
status: accepted
date: 2026-06-14
authors:
  - stuffbucket
supersedes: []
links:
  event_bus: src/lib/event-bus.ts
  settings_event_bus: src/lib/settings-events.ts
  events_route: src/routes/settings/events.ts
  shell_entry: shell/src/main.ts
  shell_client: shell/src/api.ts
  auth_route: src/routes/settings/auth.ts
  accounts_route: src/routes/settings/accounts.ts
  apps_route: src/routes/settings/apps.ts
  clients_route: src/routes/settings/clients.ts
---

> **Implementation status (slice 1, accepted).** The SSE channel is built and
> shipping for the **auth** flow — the path that most needed it (sign-in now
> flips to authenticated the instant the device-code poller resolves, with no
> 2s poll lag). Delivered:
>
> - `src/lib/settings-events.ts` — `settingsEventBus` (typed; `auth.changed`
>   today, map shaped to grow) on top of the existing `EventBus`.
> - `src/routes/settings/events.ts` — `GET /settings/api/events` via Hono
>   `streamSSE`: initial snapshot + bus relay + 15s heartbeat + abort cleanup.
> - `src/lib/auth-controller.ts` — every `authState` transition routes through
>   a single `setAuthState()` writer that publishes `auth.changed`, so a new
>   state can't be added that silently fails to notify the UI. `signOut` was
>   reordered so the emitted snapshot is fully cleared (no stale rejection).
>   The controller registers its `getAuthStatus` projector on the bus so other
>   producers can emit the canonical snapshot without an import cycle.
> - `src/lib/state.ts` — the upstream-rejection sidecar (`setLastUpstreamRejection`
>   / `clearLastUpstreamRejection`) is part of the auth status, so a mid-session
>   rejection now emits `auth.changed` too (guarded to fire only on an actual
>   change, so the hot request path doesn't spam the stream). Without this the
>   banner wouldn't appear/clear live once polling stopped in the authed state.
> - `src/lib/request-auth.ts` — `extractRequestApiKey` honours `?key=` **only**
>   for `SSE_EVENTS_PATH` (EventSource can't send headers); never elsewhere.
> - `shell/src/api.ts` — `subscribeAuthEvents()` wraps `EventSource`.
> - `shell/src/main.ts` — the Account section drives `renderAccount` from
>   `auth.changed`; the GET poll is now a **fallback**, gated on the stream
>   being down (`sseConnected`), so a dropped stream degrades to polling.
> - Tests: `tests/events-route.test.ts` (delivery, snapshot, path-scoped query
>   auth), `tests/auth-controller-events.test.ts` (producer emits on
>   transition).
>
> **Not yet migrated** (future slices, same channel): `accounts.changed`,
> `apps.changed`, `clients.changed`, `upstream.rejection`, `boot.state`. Their
> poll loops in `shell/src/main.ts` remain until each producer publishes to the
> bus and the shell subscribes — mechanical follow-ups, one event at a time.

# Replace shell polling with sidecar-pushed SSE events

## Context

The Tauri shell discovers sidecar state changes by polling. At least
six poll loops exist (auth status, accounts list, gh-cli status, apps
list, active clients, upstream rejection clear). Polling produces:

- **Laggy UI on transitions.** Account switch *"reboots the sidecar
  into it"* (architecture doc §Config and state) — the shell has no
  way to know when reboot is complete other than polling until the
  next status response succeeds.
- **Race conditions in sign-in.** The device-code flow polls; the
  shell polls auth status; the two polls interleave and the shell
  can render "polling" after the controller has already moved to
  "authenticated."
- **Wasted work.** The shell polls every few seconds even when the
  user isn't looking at the Account section.

The codebase already has `src/lib/event-bus.ts` for in-process pub/sub,
and `Hono` (the server framework) supports streaming responses. There
is no shell↔sidecar event channel yet.

## Decision

Add one SSE endpoint, **`GET /settings/api/events`**, that streams
typed events to a single shell subscriber. Event types (initial set):

- `auth.changed` — payload is the full new `AuthStatus`
- `accounts.changed` — payload is the new `AccountsListResponse`
- `apps.changed` — payload is the new `AppsListResponse`
- `clients.changed` — payload is the new `ActiveApiClientsResponse`
- `upstream.rejection` — payload is the new `UpstreamRejection`
- `boot.state` — payload describes sidecar reboot transitions
  (e.g. account-switch reboot complete)

Each event payload is the same shape the corresponding GET endpoint
returns. The shell keeps the GETs for initial fetch on mount and as
a fallback if the SSE connection drops.

Subscribe pattern in the shell:

```ts
const es = new EventSource("/settings/api/events", { withCredentials: false });
es.addEventListener("auth.changed", (e) => renderAccount(JSON.parse(e.data)));
es.addEventListener("accounts.changed", (e) => renderAccounts(JSON.parse(e.data)));
// …
es.onerror = () => /* drop back to single GET; reconnect with backoff */
```

The sidecar publishes via the existing `event-bus.ts`; the SSE route
is a thin adapter that subscribes to the bus and writes events out.

## Alternatives considered

- **WebSockets.** Bidirectional, but the shell never needs to push
  state — it acts via existing POST endpoints. SSE is simpler, one
  connection, browser/Tauri-webview supported natively.
- **Tauri native event channel (`emit`/`listen`).** Couples the
  contract to Tauri; would diverge if anyone ever wanted a
  browser-served settings UI. SSE works in both.
- **Long polling.** Stopgap; ends up reimplementing SSE with worse
  semantics.
- **Keep polling, just reduce intervals.** Doesn't fix races; makes
  laggy worse for batteries.

## Consequences

- The shell removes ~6 polling loops; replaces with one EventSource
  + one initial GET per section on first mount.
- Reboot-on-switch becomes observable: the shell shows a "switching…"
  state until `boot.state` says ready, then auto-renders the new
  account.
- The `last_upstream_rejection` "clears on next successful
  completion" mechanic stops needing a poll to be observed —
  `upstream.rejection` arrives with `null`/cleared marker.
- One new dep on the SSE client side (built-in `EventSource`); no
  new runtime dep on the server side (Hono supports streaming).

## Auth

The SSE endpoint is auth-gated like the rest of `/settings/api/*`.
The shell already passes the API key for those calls — extend the
same approach for `EventSource`, which doesn't natively send custom
headers. Use a query-string token for the SSE endpoint
(`?key=<api_key>`) **only on this endpoint**, validated by the same
middleware. Mark it allowlisted for the query-string path in the
auth middleware, never for any other endpoint. Document the choice
in the route file.

## Migration

1. Add `src/routes/settings/events.ts` and register it in the
   settings router with a streaming-aware Hono handler.
2. Have producers (`auth-controller.ts`, account-switch handler,
   apps reconciler, etc.) publish to `event-bus.ts` after any
   mutation that affects observable state.
3. Add a tiny `subscribeEvents()` helper in `shell/src/api.ts`
   wrapping `EventSource` with typed event payloads (uses ADR-0005
   shared types).
4. Replace each polling loop in `shell/src/main.ts` (and React
   feature hooks) one by one. Keep the GET-on-mount for initial
   render; remove the recurring fetch.
5. Add `tests/events-route.test.ts` covering: event delivery, auth
   gating, reconnect handling.

## Out of scope

- Multi-subscriber fan-out (one shell, one connection). If a CLI
  consumer ever wants events, generalize later.
- Replay / event sourcing. Initial-GET + live-events is enough.

## Open questions

- Heartbeats: send a comment line every 15s to keep proxies from
  closing the connection? Yes — minimal cost, big reliability win.
- Should the `EventSource` be re-established after a sidecar reboot
  during account switch? Yes — the shell will see `onerror`, wait
  briefly, reconnect; the controller emits `boot.state` once the
  sidecar is healthy. Document the reconnect contract.
