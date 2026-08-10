# PRD: Auth, Middleware & Upstream Transport (Wire)

This is the foundation document for the wire-protocol PRD set. Every
other surface inherits the middleware stack, the client-auth contract,
and the upstream header-injection and error-mapping rules described here.

## Scope

- The Hono middleware stack that wraps **every** request.
- How the proxy authenticates a **client** (API key) and which paths are
  exempt or loopback-restricted.
- How the proxy authenticates **itself to Copilot upstream** (GitHub
  token → Copilot bearer) and the full header set it injects.
- CORS, rate limiting, and the shared upstream error contract.

## Middleware stack

Registered in `src/server.ts:44-149`, in order:

| # | Middleware | Wire effect |
|---|---|---|
| 1 | `traceIdMiddleware` (`src/lib/http/trace.ts`) | Reads `x-trace-id` from the request, generates one if missing/invalid, and echoes `x-trace-id` on the response. Stored in request context for log correlation. |
| 2 | version-stamp middleware (inline, `src/server.ts:51-54`) | Sets `x-maximal-version: <BUILD_VERSION>` on every response. |
| 3 | `logger()` | Hono's default request logger (stdout). |
| 4 | `cors(buildCorsOptions(boundPort))` (`src/lib/auth/origin-guard.ts`) | **Narrowed, not permissive**: echoes `Access-Control-Allow-Origin` only for `http://localhost:<boundPort>` / `http://127.0.0.1:<boundPort>` / `[::1]`; any other origin gets no CORS header (browser blocks the cross-origin read). Control-surface hardening, ADR-0021 / spec §6 — this replaced the old `cors()` default (`*`, all origins). |
| 5 | `createOriginGuardMiddleware` (`src/lib/auth/origin-guard.ts`) | 403s any request whose `Origin` header is **present** and not `localhost:<boundPort>`, but only on `CSRF_GUARDED_PREFIXES` (`/settings/api`, `/_internal`, `/_debug/state`, `/ws`). A **missing** Origin always passes — the CLI/plugin/SDK invariant, since non-browser callers never send one. Mounted before auth so a cross-origin browser call is refused regardless of any key. |
| 6 | `createAuthMiddleware(...)` | Client API-key validation. See below. |
| 7 | `staleRefreshMiddleware(...)` | After auth, fire-and-forget background refresh of the model cache if stale. Never blocks or alters the triggering response. See `models-wire-prd.md`. |

`requireGithubAuth` is **not** in the global stack — it is mounted only
on upstream-touching route groups (`src/server.ts:193-202`). See *GitHub
token gate* below.

## Client authentication

### Credential extraction

`src/lib/auth/request-auth.ts`, in precedence order:

1. `x-api-key` header (trimmed).
2. `Authorization: Bearer <token>` (scheme match is case-insensitive).
3. Query string `?key=<token>` — **only** on the `/settings/api/events`
   SSE endpoint (EventSource cannot set headers).

### Validation

- When key enforcement is **on** (`config.auth.enforce === true`),
  `apiKeyAllowed()` requires an exact match against a configured key.
- When enforcement is **off** (default for a fresh install), any/no key
  is accepted for most paths — **except** `/settings/api/*`, which is
  now `alwaysEnforcePrefixes`-gated (§6.2, ADR-0021) and requires a key
  (or the shell's own key bypass) regardless of the `enforce` toggle. A
  local browser page must not be able to drive the control surface
  key-less.
- `OPTIONS` preflight bypasses auth (`allowOptionsBypass`, default true).

### Path classes

Configured at the middleware call site (`src/server.ts:69-132`):

| Class | Paths | Behavior |
|---|---|---|
| **Unauthenticated** | `/`, `/status`, `/usage-viewer` (+ `/usage-viewer/`), `/settings` + `/settings/` (legacy 301 redirects to `/ui/settings/`), `/_debug/state`, `/settings/api/diagnostics` (read-only, secret-redacting; GET-only and CSRF-safe via the Origin guard), `/setup-status`, the `/ws` handshake path (Origin-gated + requires its own minted `?key=` session token, so it's exempt from this middleware, not unprotected), `/openapi.json` | No key required. |
| **Unauthenticated prefix** | `/ui/*` | The settings + dashboard UI shells and their assets load without a key. |
| **Require-auth prefix, always-enforced** | `/settings/api/*` (except `/settings/api/diagnostics`) | Requires a key even when `config.auth.enforce` is off (§6.2) — the one exception noted above. |
| **Loopback-only** | `/usage`, `/token-usage`, `/token-usage/events`, `/_internal/shutdown`, `/_internal/tray-open`, `/_internal/quit`, `/_internal/upgrade` | Auth is **skipped for loopback callers**; a remote caller still needs a valid key (and each `/_internal/*` route handler also independently re-checks loopback and rejects a remote caller outright — see `usage-status-wire-prd.md`). |

Loopback is determined by peer IP ∈ {`127.0.0.1`, `::1`,
`::ffff:127.0.0.1`} via `isLoopbackAddress()`
(`src/lib/auth/request-auth.ts`). The rationale: the local dashboard at
`/ui/settings/` (browser-tab delivery — the standalone `/ui/dashboard`
window is gone, see ADR-0018) fetches `/usage` and
`/token-usage` from the same machine, so trusting loopback lets us drop
the client-side API-key UI without exposing those endpoints to remote
callers.

### Cross-origin / CSRF hardening (§6, ADR-0021)

Separate from, and in addition to, the API-key auth above:

- **`CSRF_GUARDED_PREFIXES`** (`src/lib/auth/origin-guard.ts`): `/settings/api`,
  `/_internal`, `/_debug/state`, `/ws`. Any request under these prefixes
  carrying a present, non-localhost `Origin` header gets a `403
  csrf_error` — before auth even runs. A request with **no** `Origin`
  header (every CLI/plugin/SDK caller) always passes this gate.
- **CORS is narrowed** (see middleware stack above) so a cross-origin
  page can't even read a successful response, closing the gap where
  loopback-sourced auth bypass + a permissive `cors()` would let a
  malicious local page ride the user's browser to hit these endpoints.
- Rationale recorded in `src/lib/auth/origin-guard.ts`'s module doc
  comment: before this hardening, `/settings/api/*` was CSRF-exposed
  (auth off by default, no Origin check, `cors()` was `*`, and loopback
  gating was source-IP only — which a malicious page driving the user's
  own browser satisfies).

### Client failure responses

| Scenario | Status | Body / headers |
|---|---|---|
| Missing/invalid API key (enforce on, or an always-enforced prefix) | `401` | `{ "error": { "message": "Unauthorized", "type": "authentication_error" } }` + `WWW-Authenticate: Bearer realm="copilot-api"` |
| Cross-origin request to a CSRF-guarded prefix | `403` | `{ "error": { "message": "Forbidden: cross-origin request to a control endpoint", "type": "csrf_error" } }` |
| `requireGithubAuth` with no GitHub token | `401` | `{ "error": "not_authenticated", "hint": "Open Settings → Account to sign in, or run \`maximal auth\`." }` |

## GitHub token gate (`requireGithubAuth`)

Mounted on `/chat/completions(*)`, `/models(*)`, `/embeddings(*)`,
`/responses(*)`, `/v1/*`, `/:provider/v1/*` (`src/server.ts:193-202`).

When the sidecar boots **without** a GitHub token, the HTTP server still
listens (so the shell can load Settings and trigger auth on
demand), but every upstream-touching endpoint returns the
`not_authenticated` 401 above instead of crashing or firing the
device-code flow.

## Upstream authentication (proxy → Copilot)

### Token exchange

`src/lib/auth/token.ts`, `src/lib/auth/github-token-store.ts`:

- **GitHub token type** is inferred from its prefix
  (`inferTokenType()`, `github-token-store.ts`):
  - `gho_*` (OAuth App) — used directly as the Copilot bearer; no
    exchange, no refresh loop (`token.ts`).
  - `ghu_*` (GitHub App) — exchanged at `GET
    /copilot_internal/v2/token`, which returns
    `{ token, refresh_in, endpoints: { api } }` (`token.ts`).
    The minted bearer is cached as `state.copilotToken` and refreshed on
    a loop (~25 min nominal; 15 s retry on failure).

### Host discovery & migration

`copilotBaseUrl(state)` resolves the upstream origin in this precedence
(`src/lib/config/api-config.ts`):

1. **Enterprise (GHES)** — `COPILOT_API_ENTERPRISE_URL` domain →
   `https://copilot-api.<domain>`.
2. **opencode OAuth app** → `https://api.githubcopilot.com`.
3. **Token-discovered** — `state.copilotApiUrl`, taken from the
   `endpoints.api` field of the `/copilot_internal/v2/token` response and
   validated/branded by `toCopilotHost()` (https-only). This **self-heals
   on token mint and refresh**, which is how the proxy follows a GitHub
   account that gets migrated to a different Copilot endpoint host.
4. **Account-type default** — `hostForAccountType(state.accountType)`.

### Injected upstream headers

Built by `copilotHeaders(state, requestId, vision)`
(`src/lib/config/api-config.ts`). Two header families depending on the
OAuth app in use:

**GitHub Copilot (default):**

| Header | Value |
|---|---|
| `Authorization` | `Bearer <state.copilotToken>` |
| `content-type` | `application/json` |
| `copilot-integration-id` | `vscode-chat` |
| `editor-device-id` | `<state.vsCodeDeviceId>` |
| `editor-version` | `vscode/<state.vsCodeVersion>` |
| `editor-plugin-version` | `copilot-chat/0.46.0` |
| `user-agent` | `GitHubCopilotChat/0.46.0` |
| `x-github-api-version` | `2025-10-01` |
| `x-request-id` | per-request UUID |
| `x-agent-task-id` | same UUID as `x-request-id` |
| `openai-intent` | `conversation-agent` (overridden per endpoint) |
| `x-interaction-type` | `conversation-agent` (overridden per endpoint) |
| `x-vscode-user-agent-library-version` | `electron-fetch` |
| `copilot-vision-request` | `true` — only when `vision === true` |
| `vscode-machineid` | `<state.macMachineId>` — optional |
| `vscode-sessionid` | `<state.vsCodeSessionId>` — optional |

**opencode OAuth app:** `Authorization: Bearer
<copilotToken>`, `Content-Type: application/json`, `User-Agent:
opencode/<version>`, `Openai-Intent: conversation-edits`, optional
`x-session-affinity`, `x-parent-session-id`, `Copilot-Vision-Request`.

### Per-endpoint header overrides

Each surface layers intent/initiator headers on top of the base set.
Summarized here; each surface PRD repeats the detail relevant to it.

| Endpoint | Overrides |
|---|---|
| `/v1/messages` | `x-initiator: user\|agent` (by last-message role); `anthropic-beta` (optional); `x-interaction-type: messages-proxy` + `openai-intent: messages-proxy` + a `vscode_claude_code/...` user-agent via `prepareMessageProxyHeaders()`; optional `x-interaction-id: <sessionId>` |
| `/chat/completions` | `x-initiator: user\|agent`; `x-interaction-type: conversation-subagent\|conversation-other`; optional `x-interaction-id` |
| `/responses` | `x-initiator: agent\|user`; `x-interaction-type`/`openai-intent`/`x-interaction-id` via `prepareInteractionHeaders()` + `prepareForCompact()` |
| `/models` | `x-interaction-type: model-access`, `openai-intent: model-access`; `x-interaction-id` and `content-type` removed |
| `/embeddings` | base headers only |

`x-initiator` is derived from the **last message's role**: an assistant
or tool message → `agent`, otherwise `user`. This prevents a long
multi-turn conversation from being misclassified as an agent call merely
because earlier assistant turns exist.

## Rate limiting

### Client-side throttle

Optional, governed by `state.rateLimitSeconds`
(`src/lib/http/rate-limit.ts`). When a request arrives inside the window,
the proxy either waits (`rateLimitWait`) or rejects:

```
429  { "message": "Rate limit exceeded" }
```

### Upstream rate-limit signal

Copilot returns `x-usage-ratelimit-session` and
`x-usage-ratelimit-weekly` headers, formatted as
`rem=<remaining>&rst=<reset-epoch>`. The proxy **parses and logs** these
on every completion response (`src/lib/errors/copilot-rate-limit.ts`); it does
not surface them to the client except when relaying a 429 (below).

## Upstream error contract

When an upstream call returns non-OK, the body is parsed by
`parseCopilotErrorBody()` (`src/lib/errors/copilot-error-parser.ts`),
which extracts a human message from `obj.message` /
`obj.notification.message` / `obj.error.message` / `obj.error` /
`obj.error_description`, and a remediation URL from `documentation_url` /
`message_url` / `url` / `notification.url` / an embedded `github.com`
link. `forwardError()` (`src/lib/errors/error.ts`) then maps the failure:

| Class | Trigger | Client status | Client body | Side effect |
|---|---|---|---|---|
| **Auth-fatal** | `isAuthFatal()` true: any `401`, or `403` whose message/URL contains entitlement markers ("terms of service", "not entitled", "license revoked", "subscription required", "copilot/signup", …) | upstream status (401/403) | `{ "error": { "message", "type": "auth_fatal", "remediation_url"? } }` | `markAuthFatalAndSignOut()` clears the token, stops the refresh loop, raises a Settings banner |
| **HTTP error** | any other non-OK (`402`, `429`, other `4xx`/`5xx`, `403` without markers) | upstream status | `{ "error": { "message", "type": "error" } }` | On `429`, the upstream `retry-after` and all `x-*` headers are copied to the client response. Token **not** cleared; `setLastUpstreamRejection()` raises a dismissable banner that the next success clears. |
| **Generic** | any unhandled exception (e.g. missing Copilot token) | `500` | `{ "error": { "message": "<err.message>", "type": "error" } }` | — |

## Timeouts

`src/lib/http/http-timeouts.ts`, applied via `AbortSignal.timeout()`:

- `COPILOT_TOKEN_TIMEOUT_MS = 30_000` — token mint + refresh.
- `GITHUB_API_TIMEOUT_MS = 15_000` — user lookup, device-code request.
- `DEVICE_POLL_TIMEOUT_MS = 15_000` — one device-code poll attempt.

Per-completion upstream fetches inherit Copilot's own latency; streaming
responses are held open for the duration of the stream.

## Acceptance

1. A request to `/v1/messages` with no `x-api-key` while
   `auth.enforce=true` → `401` `authentication_error` +
   `WWW-Authenticate`.
2. A request to any upstream endpoint while the sidecar has no GitHub
   token → `401` `not_authenticated` with the Settings hint; the server
   stays up.
3. A remote (non-loopback) `GET /usage` with a valid key succeeds; with
   no/invalid key → `401`. The same path from loopback succeeds without a
   key.
4. Every upstream Copilot call carries `Authorization: Bearer`,
   `copilot-integration-id: vscode-chat`, `editor-version`, and an
   `x-initiator` consistent with the last-message role.
5. An upstream `401`, or a `403` containing "not entitled", clears the
   token and returns `auth_fatal`; an upstream `429` is relayed verbatim
   with `retry-after` and leaves the token intact.
6. A cross-origin browser request (present, non-localhost `Origin`) to
   `/settings/api/*`, `/_internal/*`, `/_debug/state`, or `/ws` → `403
   csrf_error`, regardless of API key. The same request with no `Origin`
   header (a CLI/plugin/SDK caller) is unaffected.
7. `GET /settings/api/anything` with `auth.enforce=false` and no key →
   `401` (the always-enforced prefix), not the pass-through that
   `enforce=false` grants everywhere else.
