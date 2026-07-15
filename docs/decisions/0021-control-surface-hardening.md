---
id: ADR-0021
title: Control-surface hardening (Origin allowlist + mandatory settings-api auth)
status: accepted
date: 2026-07-14
authors:
  - stuffbucket
supersedes: []
links:
  spec: docs/spec/single-window-redesign.md
  server: src/server.ts
  request_auth: src/lib/auth/request-auth.ts
  settings_routes: src/routes/settings
  internal_route: src/routes/internal/route.ts
---

# Control-surface hardening (Origin allowlist + mandatory settings-api auth)

## Context

A security audit found the sidecar's control surface is **already CSRF-exposed
today**, independent of the UI shell:

- Auth is **off by default** — `decideAuth` allows every request unless
  `auth.enforce === true`, which the default config never sets
  (`request-auth.ts`). So `/settings/api/*` mutations succeed with no key.
- There is **no `Origin`/`Referer` check** anywhere on those routes.
- `cors()` is the permissive default (`Access-Control-Allow-Origin: *`).
- Loopback gating checks the **source IP only** — a malicious website driving
  the user's local browser originates from `127.0.0.1` and passes it.
- `POST /_internal/shutdown` is loopback-gated + auth-exempt — the **same
  hole class**: a visited web page can shut the sidecar down.

The Tauri webview earns no origin benefit today (same `http://localhost` origin
as the API); its only real protection is the IPC boundary (the `get_shell_api_key`
handoff + uninstall being IPC-only). Browser-tab delivery (ADR-0018) removes
the IPC handoff and makes the hole trivially exploitable from any visited page,
so hardening becomes **mandatory** — but it should be fixed regardless.

## Decision

1. **Origin/Referer allowlist** on `/settings/api/*` **and** `/_internal/*`
   (and read-only `/_debug/state`): reject any request whose `Origin` is
   present and not `http://localhost:<port>` / `http://127.0.0.1:<port>`.
   `Origin` is a **Forbidden header** — page JS cannot forge it — so this
   blocks all browser-driven cross-origin calls. Independent of `enforce`.
2. **Mandatory auth on `/settings/api/*`, decoupled from the `enforce`
   toggle.** The user-facing "block unknown connections" flag continues to
   govern only the proxy surfaces (`/v1/*`, …).
3. **Tighten `cors()`** from `*` to an explicit localhost allowlist (the
   `OPTIONS` preflight is load-bearing — auth bypasses it).
4. **Destructive/irreversible ops stay native/IPC-only** — uninstall already
   is; consider `accounts/remove` + `api-keys/enforce` too.
5. **A minted session token** in the served `/ui` document
   (same-origin-readable only) replaces the Tauri-IPC shell-key handoff a
   browser tab can't reach; the WebSocket (ADR-0019) authenticates with it.

**Invariant — must not regress CLI/plugin clients.** Claude Code, opencode,
and SDK clients send **no `Origin`** and call `/v1/*`, `/responses`,
`/chat/completions`, `/v1/models`, `/embeddings` + the `api claude-code` key
mint — not `/settings/api`. The Origin gate (missing-`Origin` passes), the
`enforce`-decoupled auth (keep honoring `Authorization: Bearer <key>`), and the
narrowed **global** `cors()` must all leave those routes reachable.

## Alternatives considered

- **Rely on obscurity / the status quo.** Already broken; a browser origin
  makes it obvious. Rejected.
- **Loopback-only gating as the defense.** Source-IP loopback does not
  distinguish a legitimate local tab from a malicious-site-driven local
  request. Insufficient.
- **Keep the whole control surface IPC-only.** Impossible under browser
  delivery — there is no Tauri host in the tab.

## Consequences

- Closes a live CSRF hole (sign-out, account-switch/remove, key mgmt,
  enforce-toggle, config writes, sidecar shutdown).
- The read-only `/ui/diagnostics` page needs none of this — it mutates
  nothing and is CSRF-safe by construction.
- The `state.shellApiKey` role changes (ADR-0003): clarify whether it survives
  as the minted token's source or is replaced.

## Implementation status

**Landed (Build Track 1, 2026-07-15) — the live hole is closed:**

- **Origin allowlist (§6.1):** `createOriginGuardMiddleware`
  (`src/lib/auth/origin-guard.ts`) 403s any present, non-localhost `Origin` on
  `/settings/api`, `/_internal` (incl. `/_internal/shutdown`), and `/_debug/state`;
  a missing `Origin` passes (CLI/plugin/SDK invariant, §6.6). Mounted in
  `server.ts` before auth. Port-exact against `state.boundPort` (set by
  `runServer` from `--port`, default 4141).
- **Mandatory `/settings/api` auth (§6.2):** delivered as the
  `alwaysEnforcePrefixes` mode of the existing `createAuthMiddleware`, so the
  `shellApiKey` bypass + client attribution stay single-sourced. Read-only
  `/settings/api/diagnostics` GET is exempt (§1.7/§6.5), CSRF-safe via the Origin
  guard.
- **CORS narrowed (§6.3):** `buildCorsOptions` replaces `cors()`'s `*` with a
  localhost-on-the-bound-port echo (null otherwise), covering the OPTIONS preflight.
- **CLI/plugin non-regression (§6.6):** asserted by
  `tests/security/cli-client-regression.test.ts` (no-Origin `Bearer` on `/v1/*`
  still 200). `origin-guard.ts` mutation score 88%.

**Pending (later tracks):**

- **Minted WS session token (§6.5)** — depends on the WS transport track; today the
  Settings UI still authenticates via `state.shellApiKey`. The `shellApiKey`-vs-token
  question (ADR-0003) is unresolved.
- **Destructive ops native/IPC-only (§6.4)** — `accounts/remove` + `api-keys/enforce`
  are Origin-gated + auth-mandatory now, but not yet IPC-only.

## Migration

Spec §6. Ship on its own track — independent of the window/nav work, ideally
first (it closes a live hole today).

## Testing

Permanent `tests/security/` suite (spec §10): per-mutation Origin tests
(evil→403, localhost→200); `enforce:off → 401` on `/settings/api`; CORS never
`*`/never-echo + the OPTIONS preflight; IPC-only ops 404 over HTTP; the WS
rejects a missing/wrong token; a **self-extending route-enumeration** test that
walks `app.routes` so a new `/settings/api` route that isn't Origin-gated fails
by omission; a **no-`Origin` `Bearer` `/v1/*` regression** test; and a
mutation-test that kills the "re-couple auth to `enforce`" mutant.

## Out of scope

- Rate limiting / abuse protection on the proxy surface.
- The proxy `/v1/*` auth model (governed by the existing enforce/API-key flow).

## Open questions

- Move `accounts/remove` + `api-keys/enforce` to IPC-only, or keep them HTTP
  behind the Origin + mandatory-auth gate with re-confirmation?
