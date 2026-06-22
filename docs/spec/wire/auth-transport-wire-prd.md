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

Registered in `src/server.ts:58-112`, in order:

| # | Middleware | Wire effect |
|---|---|---|
| 1 | `traceIdMiddleware` (`src/lib/trace.ts:8`) | Reads `x-trace-id` from the request, generates one if missing/invalid, and echoes `x-trace-id` on the response. Stored in request context for log correlation. |
| 2 | `logger()` | Hono's default request logger (stdout). |
| 3 | `cors()` | Hono's default CORS — **permissive**: all origins, all methods, standard headers. No origin allowlist on the wire (`src/server.ts:60`). |
| 4 | `createAuthMiddleware(...)` | Client API-key validation. See below. |
| 5 | `staleRefreshMiddleware(...)` | After auth, fire-and-forget background refresh of the model cache if stale. Never blocks or alters the triggering response. See `models-wire-prd.md`. |

`requireGithubAuth` is **not** in the global stack — it is mounted only
on upstream-touching route groups (`src/server.ts:194-203`). See *GitHub
token gate* below.

## Client authentication

### Credential extraction

`src/lib/request-auth.ts:140-164`, in precedence order:

1. `x-api-key` header (trimmed).
2. `Authorization: Bearer <token>` (scheme match is case-insensitive).
3. Query string `?key=<token>` — **only** on the `/settings/api/events`
   SSE endpoint (EventSource cannot set headers).

### Validation

- When key enforcement is **on** (`config.auth.enforce === true`),
  `apiKeyAllowed()` requires an exact match against a configured key
  (`src/lib/request-auth.ts:96-114`).
- When enforcement is **off** (default for a fresh install), any/no key
  is accepted (`src/lib/request-auth.ts:227-229`).
- `OPTIONS` preflight bypasses auth (`allowOptionsBypass`, default true,
  `src/lib/request-auth.ts:189-194`).

### Path classes

Configured at the middleware call site (`src/server.ts:61-95`):

| Class | Paths | Behavior |
|---|---|---|
| **Unauthenticated** | `/`, `/status`, `/usage-viewer` + `/settings`/`/settings/` (legacy 301 redirects), `/_debug/state`, `/setup-status` | No key required. |
| **Unauthenticated prefix** | `/ui/*` | The settings + dashboard UI shells and their assets load without a key. |
| **Require-auth prefix** | `/settings/api/*` | Data endpoints require a key. |
| **Loopback-only** | `/usage`, `/token-usage`, `/token-usage/events`, `/_internal/shutdown` | Auth is **skipped for loopback callers**; a remote caller still needs a valid key (and `/_internal/shutdown` rejects remote outright — see `usage-status-wire-prd.md`). |

Loopback is determined by peer IP ∈ {`127.0.0.1`, `::1`,
`::ffff:127.0.0.1`} via `isLoopbackAddress()`
(`src/lib/request-auth.ts:48-66`). The rationale: the local dashboard at
`/ui/dashboard` fetches `/usage` and `/token-usage` from the same
machine, so trusting loopback lets us drop the client-side API-key UI
without exposing those endpoints to remote callers.

### Client failure responses

| Scenario | Status | Body / headers |
|---|---|---|
| Missing/invalid API key (enforce on) | `401` | `{ "error": { "message": "Unauthorized", "type": "authentication_error" } }` + `WWW-Authenticate: Bearer realm="copilot-api"` (`src/lib/request-auth.ts:166-177`) |
| `requireGithubAuth` with no GitHub token | `401` | `{ "error": "not_authenticated", "hint": "Open Settings → Account to sign in, or run \`maximal auth\`." }` (`src/lib/request-auth.ts:267-273`) |

## GitHub token gate (`requireGithubAuth`)

Mounted on `/chat/completions(*)`, `/models(*)`, `/embeddings(*)`,
`/responses(*)`, `/v1/*`, `/:provider/v1/*` (`src/server.ts:194-203`).

When the sidecar boots **without** a GitHub token, the HTTP server still
listens (so the Tauri shell can load Settings and trigger auth on
demand), but every upstream-touching endpoint returns the
`not_authenticated` 401 above instead of crashing or firing the
device-code flow.

## Upstream authentication (proxy → Copilot)

### Token exchange

`src/lib/token.ts`, `src/lib/github-token-store.ts`:

- **GitHub token type** is inferred from its prefix
  (`inferTokenType()`, `github-token-store.ts:38-42`):
  - `gho_*` (OAuth App) — used directly as the Copilot bearer; no
    exchange, no refresh loop (`token.ts:97-106`).
  - `ghu_*` (GitHub App) — exchanged at `GET
    /copilot_internal/v2/token`, which returns
    `{ token, refresh_in, endpoints: { api } }` (`token.ts:112-115`).
    The minted bearer is cached as `state.copilotToken` and refreshed on
    a loop (~25 min nominal; 15 s retry on failure, `token.ts:153-218`).

### Host discovery & migration

`copilotBaseUrl(state)` resolves the upstream origin in this precedence
(`src/lib/api-config.ts:157-181`):

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
(`src/lib/api-config.ts:233-301`). Two header families depending on the
OAuth app in use:

**GitHub Copilot (default, `api-config.ts:269-301`):**

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

**opencode OAuth app (`api-config.ts:238-263`):** `Authorization: Bearer
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
| `/models` | `x-interaction-type: model-access`, `openai-intent: model-access`; `x-interaction-id` and `content-type` removed (`api-config.ts:218-231`) |
| `/embeddings` | base headers only |

`x-initiator` is derived from the **last message's role**: an assistant
or tool message → `agent`, otherwise `user`. This prevents a long
multi-turn conversation from being misclassified as an agent call merely
because earlier assistant turns exist.

## Rate limiting

### Client-side throttle

Optional, governed by `state.rateLimitSeconds`
(`src/lib/rate-limit.ts:8-46`). When a request arrives inside the window,
the proxy either waits (`rateLimitWait`) or rejects:

```
429  { "message": "Rate limit exceeded" }
```

### Upstream rate-limit signal

Copilot returns `x-usage-ratelimit-session` and
`x-usage-ratelimit-weekly` headers, formatted as
`rem=<remaining>&rst=<reset-epoch>`. The proxy **parses and logs** these
on every completion response (`src/lib/copilot-rate-limit.ts`); it does
not surface them to the client except when relaying a 429 (below).

## Upstream error contract

When an upstream call returns non-OK, the body is parsed by
`parseCopilotErrorBody()` (`src/lib/copilot-error-parser.ts:36-49`),
which extracts a human message from `obj.message` /
`obj.notification.message` / `obj.error.message` / `obj.error` /
`obj.error_description`, and a remediation URL from `documentation_url` /
`message_url` / `url` / `notification.url` / an embedded `github.com`
link. `forwardError()` (`src/lib/error.ts:38-112`) then maps the failure:

| Class | Trigger | Client status | Client body | Side effect |
|---|---|---|---|---|
| **Auth-fatal** | `isAuthFatal()` true: any `401`, or `403` whose message/URL contains entitlement markers ("terms of service", "not entitled", "license revoked", "subscription required", "copilot/signup", …) (`copilot-error-parser.ts:58-84`) | upstream status (401/403) | `{ "error": { "message", "type": "auth_fatal", "remediation_url"? } }` | `markAuthFatalAndSignOut()` clears the token, stops the refresh loop, raises a Settings banner (`error.ts:44-72`) |
| **HTTP error** | any other non-OK (`402`, `429`, other `4xx`/`5xx`, `403` without markers) | upstream status | `{ "error": { "message", "type": "error" } }` | On `429`, the upstream `retry-after` and all `x-*` headers are copied to the client response (`error.ts:74-82`). Token **not** cleared; `setLastUpstreamRejection()` raises a dismissable banner that the next success clears. |
| **Generic** | any unhandled exception (e.g. missing Copilot token) | `500` | `{ "error": { "message": "<err.message>", "type": "error" } }` | — |

## Timeouts

`src/lib/http-timeouts.ts`, applied via `AbortSignal.timeout()`:

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
