# PRD: Auth, Middleware & Upstream Transport (Wire)

Every HTTP surface inherits the middleware stack, the client-auth
contract, and the upstream header-injection and error-mapping rules
described here.

## Scope

- The Hono middleware stack that wraps **every** request.
- How the proxy authenticates a **client** (API key) and which paths are
  exempt or loopback-restricted.
- How the proxy authenticates **itself to Copilot upstream** (GitHub
  token → Copilot bearer) and the full header set it injects.
- CORS, rate limiting, and the shared upstream error contract.

## Middleware stack

Registered globally in `src/server.ts`, in order:

| # | Middleware | Wire effect |
|---|---|---|
| 1 | `traceIdMiddleware` (`src/lib/http/trace.ts`) | Reads `x-trace-id` from the request, generates one if missing/invalid, and echoes `x-trace-id` on the response. Stored in request context for log correlation. |
| 2 | version stamp (inline) | Sets `x-maximal-version: <BUILD_VERSION>` on every response, including redirects and errors. |
| 3 | `logger()` | Hono's default request logger (stdout). |
| 4 | `cors()` | Hono's default CORS — **permissive**: all origins, all methods, standard headers. No origin allowlist on the wire. |
| 5 | `createAuthMiddleware(...)` | Client API-key validation. See below. |
| 6 | `staleRefreshMiddleware(...)` | After auth, fire-and-forget background refresh of the model cache if stale. Never blocks or alters the triggering response. |

`requireGithubAuth` is **not** in the global stack — it is mounted only
on upstream-touching route groups. See *GitHub token gate* below.

## Client authentication

### Credential extraction

`extractRequestApiKey()` (`src/lib/auth/request-auth.ts`), in precedence
order:

1. `x-api-key` header (trimmed).
2. `Authorization: Bearer <token>` (scheme match is case-insensitive).
3. Query string `?key=<token>` — **only** on the `/settings/api/events`
   SSE endpoint (`SSE_EVENTS_PATH`; EventSource cannot set headers).

### Validation

`createAuthMiddleware()` decides each non-exempt request:

- A key equal to `state.shellApiKey` (the `MAXIMAL_SHELL_KEY` env var the
  desktop shell injects when it spawns the sidecar) is always allowed, so
  enabling enforcement cannot lock the user out of their own Settings UI.
- When key enforcement is **off** (`config.auth.enforce !== true`, the
  default for a fresh install), any/no key is accepted; a matching key is
  used only to attribute the request to a named client.
- When enforcement is **on**, `apiKeyAllowed()` requires an exact match
  against the configured keys (`getConfiguredApiKeys()`: legacy
  `auth.apiKeys` plus enabled `auth.apiKeyEntries`).
- `OPTIONS` preflight bypasses auth (`allowOptionsBypass`, default true).

### Path classes

Configured at the `createAuthMiddleware` call site in `src/server.ts`.
Exact-path entries match `c.req.path` literally; prefix entries match the
prefix itself or anything under `<prefix>/`.

| Class | Paths | Behavior |
|---|---|---|
| **Unauthenticated (exact)** | `/`, `/status`, `/_debug/state`, `/setup-status`, and the legacy 301 redirects (`LEGACY_REDIRECTS` in `src/server.ts`: `/usage-viewer`, `/settings`, each with and without a trailing slash) | No key required. |
| **Unauthenticated prefix** | `/ui/*` | The settings + dashboard UI shells and their assets load without a key. |
| **Own-route auth** | `/mcp/*` | Skips the global middleware; `src/routes/mcp/route.ts` authenticates itself. An endpoint with its own `apiKey` accepts exactly that key; otherwise the same main-port rules apply. Requests must also come from loopback with no foreign `Origin`. No GitHub token required. |
| **Require-auth prefix** | `/settings/api/*` | Data endpoints require a key (overrides any unauthenticated prefix). |
| **Loopback-exempt** | `/usage`, `/token-usage`, `/token-usage/events` | Auth is **skipped for loopback callers**; a remote caller still needs a valid key. |
| **Loopback-only** | `/_internal/shutdown`, `/_internal/reload` | Auth is skipped for loopback callers, and the handlers in `src/routes/internal/route.ts` reject any non-loopback caller with `404`, even one holding a valid key. |
| **Everything else** | completion, model, embeddings, provider routes, etc. | Normal client authentication. |

Loopback is determined by peer IP ∈ {`127.0.0.1`, `::1`,
`::ffff:127.0.0.1`} via `isLoopbackAddress()`. The rationale: the local
dashboard at `/ui/dashboard` fetches `/usage` and `/token-usage` from the
same machine, so trusting loopback lets us drop the client-side API-key UI
without exposing those endpoints to remote callers.

### Client failure responses

| Scenario | Status | Body / headers |
|---|---|---|
| Missing/invalid API key (enforce on) | `401` | `{ "error": { "message": "Unauthorized", "type": "authentication_error" } }` + `WWW-Authenticate: Bearer realm="copilot-api"` |
| `requireGithubAuth` with no GitHub token | `401` | `{ "error": "not_authenticated", "hint": "Open Settings → Account to sign in, or run \`maximal auth\`." }` |

## GitHub token gate (`requireGithubAuth`)

Mounted on `/chat/completions(*)`, `/models(*)`, `/embeddings(*)`,
`/responses(*)`, `/v1/*`, and `/:provider/v1/*` in `src/server.ts`.

When the sidecar boots **without** a GitHub token, the HTTP server still
listens (so the desktop shell can load Settings and trigger auth on
demand), but every upstream-touching endpoint returns the
`not_authenticated` 401 above instead of crashing or firing the
device-code flow.

## Upstream authentication (proxy → Copilot)

### Token exchange

`src/lib/auth/token.ts`, `src/lib/auth/github-token-store.ts`:

- **GitHub token type** is inferred from its prefix (`inferTokenType()`):
  - `gho_*` (OAuth App) — used directly as the Copilot bearer; no
    exchange, no refresh loop.
  - `ghu_*` (GitHub App) — exchanged at `GET
    /copilot_internal/v2/token`, which returns
    `{ token, refresh_in, endpoints: { api } }`. The minted bearer is
    cached as `state.copilotToken` and refreshed by
    `runCopilotRefreshLoop()` 60 s before `refresh_in` elapses (polled in
    15 s wall-clock chunks so a wake from sleep is noticed promptly; 15 s
    retry on failure; a few consecutive auth-fatal refresh rejections are
    tolerated before the account is degraded).

### Credential attachment

Callers never build `Authorization` themselves. Every credentialed
outbound request goes through `src/lib/http/send-request.ts`, which maps
the destination host to its credential (Copilot host → Copilot bearer,
GitHub API host → GitHub token, `api.anthropic.com` → Anthropic key; the
config-selected `/:provider/*` passthrough supplies a resolved provider
config). An unrecognized host gets no credential. The ESLint rule
`credential-attachment-single-mechanism` in `eslint.config.js` enforces
this (see ADR-0001).

### Host discovery & migration

`copilotBaseUrl(state)` (`src/lib/config/api-config.ts`) resolves the
upstream origin in this precedence:

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
(`src/lib/config/api-config.ts`), plus `Authorization: Bearer
<copilotToken>` attached by `send-request.ts`. Two header families
depending on the OAuth app in use:

**GitHub Copilot (default, `githubCopilotHeaders()`):**

| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `copilot-integration-id` | `vscode-chat` |
| `editor-device-id` | `<state.vsCodeDeviceId>` |
| `editor-version` | `vscode/<state.vsCodeVersion>` |
| `editor-plugin-version` | `copilot-chat/<COPILOT_VERSION>` |
| `user-agent` | `GitHubCopilotChat/<COPILOT_VERSION>` |
| `x-github-api-version` | `<API_VERSION>` |
| `x-request-id` | per-request UUID |
| `x-agent-task-id` | same UUID as `x-request-id` |
| `openai-intent` | `conversation-agent` (overridden per endpoint) |
| `x-interaction-type` | `conversation-agent` (overridden per endpoint) |
| `x-vscode-user-agent-library-version` | `electron-fetch` |
| `copilot-vision-request` | `true` — only when `vision === true` |
| `vscode-machineid` | `<state.macMachineId>` — optional |
| `vscode-sessionid` | `<state.vsCodeSessionId>` — optional |

`COPILOT_VERSION` and `API_VERSION` are pinned constants in
`api-config.ts` (see ADR-0016).

**opencode OAuth app:** `Content-Type: application/json`, `User-Agent:
opencode/<version>` (the inbound opencode UA when present),
`Openai-Intent: conversation-edits`, optional `x-session-affinity`,
`x-parent-session-id`, `Copilot-Vision-Request`.

### Per-endpoint header overrides

`/v1/messages`, `/chat/completions`, and `/responses` all build their
headers with `buildCopilotHeaders()` (`src/services/copilot/upstream-request.ts`),
which layers on top of the base set:

- `x-initiator: user|agent` from the per-shape rule in
  `src/services/copilot/agent-initiator.ts` (see below);
- `prepareInteractionHeaders()`: a subagent request forces
  `x-initiator: agent` and `x-interaction-type: conversation-subagent`; a
  session id becomes `x-interaction-id`;
- `prepareForCompact()`: a compaction request forces `x-initiator: agent`
  and, for a compact request, `x-interaction-type`/`openai-intent:
  conversation-other`.

The opencode OAuth app skips the interaction headers.

| Endpoint | Additional overrides |
|---|---|
| `/v1/messages` | `anthropic-beta` (optional); when `metadata.user_id` carries both a safety identifier and a session id, `prepareMessageProxyHeaders()` sets `x-interaction-type`/`openai-intent: messages-proxy`, a `vscode_claude_code/...` user-agent, a fresh `x-request-id`/`x-agent-task-id`, and drops `copilot-integration-id` (skipped for `claude-opus-4.8*` models) |
| `/chat/completions` | — |
| `/responses` | — |
| `/models` | `copilotModelsHeaders()`: `x-interaction-type: model-access`, `openai-intent: model-access`; `x-interaction-id` and `content-type` removed |
| `/embeddings` | base headers only |

### Messages context-editing compatibility

Copilot's model catalog may omit `capabilities.supports.context_editing` even
when a model accepts one or more `context_management.edits` strategies. The
Messages transport therefore keeps three states separate:

- an explicit catalog value of `false` suppresses context management;
- an absent catalog value is unknown, so the original request is attempted;
- a missing rejection-cache entry means support is expected, so the original
  request is attempted;
- only a context-specific rejection is cached, in memory, by account, Copilot
  host, exact model ID, and normalized edit-set signature.

A successful request clears any entry for its scope. A `400` whose error body explicitly
names `context_management` records a rejection for the process lifetime and is
retried once without the field and without only its paired
`context-management-2025-06-27` beta token. Other beta tokens remain intact,
and unrelated errors are not retried. A new exact model ID naturally starts
without a rejection, and process restart clears the in-memory cache. Diagnostics
reports catalog-advertised support separately from current-catalog rejection
entries; neither layer claims that Maximal implements every advertised feature.

`x-initiator` is derived from the **last turn**, per request shape
(`messagesInitiator()`, `chatCompletionsInitiator()`,
`responsesInitiator()`): only a genuine user turn is `user` (for
Messages, a `user` message made solely of `tool_result` blocks counts as
`agent`). This prevents a long multi-turn conversation from being
misclassified as an agent call merely because earlier assistant turns
exist. The header feeds Copilot's billing, so it is a correctness surface.

## Rate limiting

### Client-side throttle

Optional, governed by `state.rateLimitSeconds` (`checkRateLimit()` in
`src/lib/http/rate-limit.ts`). When a request arrives inside the window,
the proxy either waits (`state.rateLimitWait`) or rejects:

```
429  { "message": "Rate limit exceeded" }
```

### Upstream rate-limit signal

Copilot returns `x-usage-ratelimit-session` and
`x-usage-ratelimit-weekly` headers, formatted as
`rem=<remaining>&rst=<reset-epoch>`. The proxy **parses and logs** these
on every upstream response (`logCopilotRateLimits()` in
`src/lib/errors/copilot-rate-limit.ts`); it does not surface them to the
client except when relaying a 429 (below).

## Upstream error contract

`finishUpstreamResponse()` (`src/services/copilot/upstream-request.ts`)
handles every non-OK upstream response. The body is parsed by
`parseCopilotErrorBody()` (`src/lib/errors/copilot-error-parser.ts`),
which extracts a human message from `obj.message` /
`obj.notification.message` / `obj.error.message` / `obj.error` /
`obj.error_description`, and a remediation URL from `documentation_url` /
`message_url` / `url` / `notification.url` / an embedded `github.com`
link. `isAuthFatal()` true — any `401`, or a `403` whose message/URL
contains entitlement markers ("terms of service", "not entitled",
"license revoked", "subscription required", "copilot/signup", …) — throws
`CopilotAuthFatalError`; anything else records the rejection with
`setLastUpstreamRejection()` (a dismissable Settings banner that the next
success clears) and throws `HTTPError`.

The route then maps the error with `forwardError()` (OpenAI-shaped routes)
or `forwardAnthropicError()` (`/v1/messages`, its `count_tokens`, and the
provider-scoped messages route), both in `src/lib/errors/error.ts`:

| Class | Client status | `forwardError()` body | `forwardAnthropicError()` body | Side effect |
|---|---|---|---|---|
| **Auth-fatal** | upstream status (401/403) | `{ "error": { "message", "type": "auth_fatal", "remediation_url"? } }` | Anthropic error envelope; remediation URL appended to the message | `markAuthDegraded()` stops the refresh loop, drops the live tokens, and flags the account `needsReauth` on disk. The saved credential is **retained**, so a restart retries it. |
| **HTTP error** | upstream status, except that `forwardAnthropicError()` turns transient `500`/`502`/`503`/`504` into `529 overloaded_error` and a 4xx (not 429) context overflow into a `400` with a `prompt is too long: …` message | `{ "error": { "message", "type": "error" } }` | `{ "type": "error", "error": { "type", "message" } }` | On `429` (and, for Anthropic routes, transient 5xx), `retry-after` and all `x-*` upstream headers are copied to the client response. Recognizable errors get advice text from `adviseUpstreamError()`. Token **not** cleared. |
| **Generic** (any other exception, e.g. missing Copilot token) | `500` | `{ "error": { "message", "type": "error" } }` | `api_error` envelope | — |

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
4. Every upstream Copilot call carries `Authorization: Bearer` and
   `editor-version`; every completion call carries an `x-initiator`
   consistent with the last turn; `copilot-integration-id: vscode-chat`
   is present except on messages-proxy requests.
5. An upstream `401`, or a `403` containing "not entitled", drops the
   live token, flags the account `needsReauth` (credential retained), and
   returns an auth-fatal error; an upstream `429` is relayed with
   `retry-after` and leaves the token intact.
6. A non-loopback `POST /_internal/shutdown` or `/_internal/reload`
   returns `404` even with a valid key.
