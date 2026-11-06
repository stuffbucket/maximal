# @stuffbucket/maximal-connector-kit

Build a maximal **connector** for a remote MCP server (Streamable HTTP) from a
manifest. The kit supplies everything a remote connector needs: sign-in,
upstream sessions, setup status and actions, and the upstream tool list
mirrored as plugin tools. Work IQ (`packages/plugin-workiq`) is built on it.

## Writing a connector

A connector is a manifest plus options:

```ts
import {
  defineRemoteMcpConnector,
  type RemoteMcpConnectorManifest,
} from "@stuffbucket/maximal-connector-kit"

const MANIFEST: RemoteMcpConnectorManifest = {
  id: "example",
  kind: "connector",
  displayName: "Example",
  description: "Example's tools, from its hosted MCP server.",
  settingsVersion: 1,
  connector: {
    transport: "streamable-http",
    endpoint: "https://mcp.example.com/mcp",
    auth: { type: "mcp-oauth", clientId: "maximal" },
    terms: { url: "https://example.com/terms" }, // optional
  },
}

const plugin = defineRemoteMcpConnector(MANIFEST, {
  errors: { adminHint: "An admin can check the Example app in …" },
})
export const { name, manifest, inject, Config } = plugin
export const apply: typeof plugin.apply = (ctx, config) => plugin.apply(ctx, config)
```

`defineRemoteMcpConnector(manifest, options)` returns a complete plugin module:
`name` (= `manifest.id`), `manifest` (with `configSchema` filled in), `inject`
(`tools`, `surface`, `storage`, `host`), `Config`, `apply`, and
`defaultToolPermission` / `migrateSettings` when the options give them.

**Config** (zod): `{ endpoint }`, defaulting to `manifest.connector.endpoint`,
plus `authority` for Entra connectors (defaulting to the manifest's). `{}` is
valid. `manifest.configSchema` is its JSON Schema (`z.toJSONSchema`, input
side) with `"x-maximal-advanced": true` on both fields. The upstream token
goes wherever these point, so an override other than the default must be
`https:` on an allowed host — for `endpoint`, the default endpoint's host or
one of `manifest.connector.allowedHosts`; for `authority`, the manifest
authority's host, `login.microsoftonline.com` or `login.microsoft.com` —
else validation fails with an issue on that field (shown inline in
Settings). The code-level `options.endpoint` is the default and is not
restricted (the bench's loopback fake).

**Options** (all optional): `endpoint` (replace the default endpoint, e.g. a
local fake), `auth` (replace the manifest's strategy, e.g. `fakeAuth()`),
`errors` (`messages` per account-level code, `adminHint`), `wording` (terms
step), `defaultToolPermission`, `migrateSettings`, `limits` and `throttle`
(see *Rate limiting*), and seams (`retryDelaysMs`, `sleep`, `clock`,
`random`, `fetch`, `sessionIdleMs`, `maxSessions`, `callTimeoutMs`,
`requestTimeoutMs`, `signInTimeoutMs`, `secretStore` — the OS credential
store, e.g. `memorySecretStore()` in tests).

## Sign-in strategies

`manifest.connector.auth` picks one (`authStrategyFor`); `options.auth`
replaces it.

- **`entra`** — `{ clientId, authority, scopes, redirectUri }`. Microsoft
  Entra public client through `@azure/msal-node`: authorization code + PKCE in
  the system browser (`ctx.host.openExternal`) with MSAL's loopback listener
  on the **port of `redirectUri`** (the app's registered redirect). If that
  port is busy, sign-in fails with `port-in-use` before a browser opens —
  Entra would reject any other redirect. The first sign-in sends no `prompt`
  (the browser session decides); signing in again sends `select_account`.
  Every upstream request gets a token silently (MSAL cache / refresh token);
  only the most recently signed-in account is kept. Cache:
  `msal-token-cache.sealed.json`, encrypted (see *Credentials* below); a
  plaintext `msal-token-cache.json` from an older version is moved into it
  when the connector starts and deleted. `config.authority` overrides the
  authority.
- **`mcp-oauth`** — `{ clientId?, scopes? }`. The MCP Authorization spec:
  protected-resource metadata (RFC 9728, from the endpoint) → authorization
  server metadata (RFC 8414 / OIDC discovery) → authorization code + PKCE
  through a one-shot loopback redirect on `127.0.0.1` (any free port, RFC
  8252), with the RFC 8707 `resource` indicator (the MCP endpoint) on the
  authorization, token and refresh requests. Discovery, registration, PKCE
  and the code exchange are the MCP SDK's `auth()` with an
  `OAuthClientProvider` the kit implements; refresh uses the persisted
  discovery result. The loopback answers 400 to, and ignores, a redirect
whose `state` is not this sign-in's. A static `clientId` is used as is; without one the kit
  registers dynamically (RFC 7591) only if the server advertises it, and
  fails clearly otherwise. Account details come from an `id_token` when the
  server sends one. State (client, tokens, discovery, resource) is sealed
  like Entra's cache, below: `oauth.sealed.json`, key entry
  `<id>/mcp-oauth/<key id>`; a plaintext `oauth.json` from an older version
  is moved in at start and deleted. A rejected refresh token means signing
  in again.
- **`none`** — public server: no sign-in, no `Authorization` header, no
  sign-in/sign-out actions.

On HTTP 401 the upstream fetch asks the strategy to refresh once
(`invalidate(rejectedToken)`) and retries; a 401 with a freshly refreshed
token means the service refuses the account (`not-entitled`), not that
sign-in expired. Concurrent 401s for the same token share one refresh, and
a 401 for a token already replaced just retries. A refresh is shared by
every caller and runs under the plugin's lifetime: one caller aborting
stops only its own wait, and rotated tokens are always saved — unless a
sign-in or sign-out happened meanwhile, in which case the result is dropped
(it never writes the old account back).

The bearer token is sent only to the configured endpoint's origin; the
fetch does not follow redirects with it, except same-origin 307/308.

**Credentials are per connector.** They live only in that connector's own
`ctx.storage` (`<app dir>/plugins/<id>/`, 0700, files 0600), separate from
Maximal's GitHub/Copilot sign-in and from every other connector. MCP clients
never see upstream tokens: they talk to Maximal's `/mcp/<id>` with Maximal's
key, and only the connector adds the upstream `Authorization` header.

**Entra's token cache is sealed** (`SealedCache`, `src/auth/sealed-cache.ts`):
the file holds AES-256-GCM ciphertext and the name of its key; the key (32
random bytes) is an entry in the OS credential store through `Bun.secrets`
(`src/auth/secret-store.ts`): macOS Keychain, Windows Credential Manager, or
the Secret Service (libsecret over D-Bus) on Linux. The entry's service is
`Maximal connectors` and its name `<id>/msal-token-cache/<random key id>`, so
each data directory has its own. Only the key goes into the store because
Credential Manager caps a value at 2.5 KB and an MSAL cache is bigger.
`Bun.secrets` runs off the event loop and never puts a value on a command
line. The key is read once per start and kept in memory. Sign-out deletes the
file and the entry; a key missing from the store, or a file that fails to
decrypt, means signed out. Every store call is bounded (`SECRET_STORE_TIMEOUT_MS`,
60 s); `Bun.secrets` runs off the event loop, so only this cache's callers
ever wait. When the store can't be used (no Secret Service, access denied, no
answer) the newest cache is kept in memory for the rest of the process, under
`AuthEnv.scope` (connector id and data directory), so it outlives the
connector being turned off and on, and is never written in plain text; the
`ready` status says so (a "Sign-in" fact and a `detail` naming what to
install). The sealed file is never deleted because the store failed. A
refused call is retried after `SECRET_STORE_RETRY_MS` (5 minutes), and the
in-memory cache is sealed once the store works; a call that gets no answer
stops store use until restart and raises a `sign-in-not-saved` notice
(`AuthEnv.notify`). Tests reset the per-process state with
`resetSealedCacheScopes()` from the testing export. Under `bun test` the OS store
refuses every call, so a test that forgets to inject one gets the
memory-only behaviour, never the real Keychain. MCP OAuth's state is sealed
the same way.

## Upstream

- MCP protocol: each upstream session negotiates the newest revision both
  sides support (`versionNegotiation: auto` — a `server/discover` probe for
  2026-07-28, else the 2025 `initialize` handshake). The version is logged
  and shown as the `Protocol` fact.
- One upstream session per downstream MCP session id (idle-closed after 10
  minutes, at most 16), plus a shared one for `tools/list` and calls without
  a session; a forgotten session (HTTP 404) is reopened once. The shared
  session carries the `list_changed` subscription and is never idle-closed;
  when a tool call has to reopen it, the tools are listed again. A sweep
  never closes a session a call has picked up. Unloading never cuts a
  handshake short (the upstream session would stay open with its id lost):
  it finishes, bounded by the request timeout, and is then ended (`DELETE`).
- Tool calls go through the connector's shared limiter and retry policy
  (*Rate limiting*). The transport retries only protocol requests
  (`initialize`, `server/discover`, `tools/list`, …) on 429/503/504, and
  never a `tools/call`.
- Upstream progress is relayed to the caller; upstream elicitation goes to
  the calling client when it can elicit and is declined otherwise. Upstream
  EULA mechanisms (an `accept_eula` tool, elicitation) pass through untouched.
- Tools are the upstream `tools/list`, verbatim (names, descriptions,
  schemas, annotations), refreshed on `list_changed`, after sign-in and on
  *Try again*. Whatever subset comes back is mirrored.

## Rate limiting

One `ConnectorLimiter` and one `GuardedUpstream` per connector (built in
`apply`, shared by every downstream session and upstream session) sit in
front of `UpstreamPool.callTool`. `GuardedUpstream` is the **only** place a
`tools/call` is retried; the HTTP fetch keeps the bearer token, the one 401
refresh, and retries of protocol requests, so attempts never multiply.

**Admission.** A call waits for a global slot (`maxConcurrency`), a slot in
its lane (`lanes[name].maxConcurrency`, spacing `minIntervalMs`) and the end
of any cool-down. Waiters are served round robin across downstream
sessions, FIFO per lane within one (a cooling or full lane does not hold up
the session's calls in other lanes). More than `maxQueue` waiting fails at once
(`queue-full`); waiting longer than `queueTimeoutMs` fails (`queue-timeout`);
a cool-down longer than the call may wait fails at once (`cooldown`, with the
remaining time). Aborting a waiting call frees its place.

**Cool-down and AIMD.** Any throttle (HTTP or inside a result, from any
session) closes the cool-down for everyone: for the call's lane when the
throttle is in a result (one workload's data), for the whole connector when
the endpoint itself answered 429/503 (including a throttled `initialize` or
`tools/list`). It lasts the server's `Retry-After`, else the low end of the
jittered fallback; each retrying caller then waits its own jittered delay
past it, so callers throttled together do not resume together. A throttle
also halves the scope's concurrency (once per cool-down window, floor
`minConcurrency`); 8 successes in a row add one back, a quiet minute
restores the cap. Sign-out, reconnect (`closeAll`) and unload clear this
state and refuse waiters (`reset`).

**Retry.** Wait before retry *n* = max(`Retry-After` + 0–250 ms, fallback[*n*]
× (1 ± `jitter`)). `Retry-After` is delta-seconds or an HTTP-date, never
capped and never undercut: a hint longer than `retry.maxWaitMs` is not
waited for — the call fails at once with the time to wait. Attempts stop at
`retry.attempts` or when queueing plus backoff would exceed `retry.budgetMs`.

| Tool kind | 429 (HTTP or result) | 503/504 | Lost connection / timeout | 500/502 |
|---|---|---|---|---|
| `read` | retry | retry | retry once, at once | fail |
| `idempotent-write` | retry | retry once | outcome unknown | outcome unknown |
| `write` | retry (refused, not run) | outcome unknown | outcome unknown (unless never sent) | outcome unknown |

Kinds come from `throttle.kind`, else the annotations (`readOnlyHint` ⇒
read, `idempotentHint` ⇒ idempotent write, else write). An aborted call is
never retried.

**Batch reads** (`throttle.batch`, e.g. `{ tool: "fetch", argument:
"entityUrls" }`): a longer list is split into chunks of `fetchBatchSize`
(sequential; `0` disables); when `throttle.inspect` reports throttled
entries, only those items are re-issued after the wait and spliced back in
order. Attempts count per chunk and per re-issue round (an item is tried at
most `retry.attempts` times); `retry.budgetMs` stays per call. Entries still throttled when attempts or budget run out keep their
throttled status, with a note in a second text block; other entries (404,
403, …) pass through unchanged.

**What callers see.** While queued or backing off, a call that asked for
progress gets a notification at most once per `progressIntervalMs` ("…
rate-limiting requests (HTTP 429); retrying in 8 s.", "Waiting for a free …
slot (2 ahead)."); upstream progress keeps flowing and stays increasing
across retries. Final failures are `isError` tool results with a
`ConnectorError` (`code: "busy"`, `busy: { reason, retryAfterMs?, attempts,
waitedMs }`): `throttled` ("… is rate-limiting requests (HTTP 429); tried 5
times over 30 s. Try again in about 16 s."), `cooldown`, `queue-full`,
`queue-timeout`, `reset`, and `outcome-unknown` ("The request may have been
carried out: … returned HTTP 504 for create_entity, which changes data.
Check before retrying.").

**Numbers** — `manifest.connector.limits` (JSON, validated by the SDK), then
`options.limits`; lanes and retry merge per key. `retryDelaysMs` (older
option) sets the fallback and, unless `retry.attempts` is given, attempts =
its length + 1.

| Field | Default | |
|---|---|---|
| `maxConcurrency` | 4 | in-flight calls per connector (Outlook allows 4 per mailbox) |
| `minConcurrency` | 1 | AIMD floor |
| `lanes` | none | `{ [lane]: { maxConcurrency?, minIntervalMs? } }` |
| `maxQueue` | 32 | waiting calls across all sessions |
| `queueTimeoutMs` | 30 000 | longest wait for a slot |
| `retry.attempts` | 5 | first call included (agent-kit parity) |
| `retry.fallbackDelaysMs` | 2000, 4000, 8000, 16 000 | without `Retry-After` |
| `retry.jitter` | 0.25 | ±25 % on fallback waits |
| `retry.maxWaitMs` | 30 000 | longest single wait; longer hints fail fast |
| `retry.budgetMs` | 120 000 | queueing + backoff per call |
| `retry.retryWritesOn429` | true | |
| `fetchBatchSize` | 20 | Graph's `$batch` cap; 0: no splitting |
| `progressIntervalMs` | 1000 | |

**Behaviour** — `options.throttle` (`ThrottleHooks`, code, not manifest):
`kind(tool, args, annotations)`, `lane(tool, args)`, `attempts(tool, args)`
(fewer for expensive tools), `inspect(result, { tool, args, now })` →
`{ status, retryAfterMs?, indexes? }` for throttling inside a normal
result, and `batch`. Without hooks the kit classifies by annotations, uses
one lane, and sees HTTP status only. `limiter.snapshot()` gives in-flight,
queued, concurrency and cool-down per lane for logs.

## Setup status and actions

| `code` | `state` | When | Actions |
|---|---|---|---|
| `working` | `working` | Starting, connecting, waiting for the browser | `sign-out` ("Cancel") while signing in |
| `terms-needed` | `needs-setup` | `manifest.connector.terms` set and not accepted (acceptance of that URL, with time, in `terms.json`) | `accept-terms` |
| `signin-needed` | `needs-setup` | No usable sign-in; a cancelled or timed-out sign-in | `sign-in` |
| `ready` | `ready` | Connected. Facts: Account, Tenant (or "Signed in at"), Sign-in (only when it is kept in memory, with the reason in `detail`), Tools, Protocol | `sign-out` (interactive) |
| `error` | `error` | Sign-in blocked, not entitled, network, service failure | `retry`; `sign-in` for account problems; `sign-out` when signed in |

Account-level failures carry the connector's `adminHint` in `detail`:
`consent-needed`, `not-assigned`, `conditional-access`, `app-disabled`,
`personal-account` (sign-in blocked; recognised from AADSTS codes), and
`not-entitled`, `license-needed` (signed in, but the service refuses with
401-after-refresh or 403 on connect or `tools/list`). Not-entitled keeps the
sign-in, so `retry` works once an admin acts. A 403 on a single `tools/call`
is that call's `isError` result (`policy-denied` wording) and changes
nothing else; a 401-after-refresh on a call re-checks the tool list. When a
list returns fewer tools than an earlier one for the same sign-in, the Tools
fact says some may be restricted. `retry` re-runs the full check with a
fresh token. Action failures are reported through the status, never thrown.

## Testing (`./testing`)

- `startFakeRemoteMcp(options)` — a real MCP Streamable HTTP server on
  loopback: seedable `tools`, per-tool `handlers` and canned `results`, bearer
  check (`token`, `null` for none), `protocol: "modern"` to also serve
  2026-07-28 traffic, `oauth` for RFC 9728 metadata plus an auto-approving
  authorization server (PKCE + `resource` checks, refresh, optional dynamic
  registration, `denyWith`), recorded `requests`, `calls()` and `oauth`
  activity, injected HTTP failures (`fail`, optionally per `tool`),
  `setTools` (`list_changed`), `expireSessions`. Recorded requests carry
  the `Mcp-Protocol-Version` header (`protocolVersion`). `notifyProgress` /
  `elicitForm` help handlers. Throttling: `throttle({ mode, status,
  retryAfter, where, tool, rpc, paths, times })` answers matching requests
  with HTTP 429/503/504 (`mode: "http"`, `Retry-After` header) or with a
  normal tool result carrying Graph-style `{ statusCode, error }` — per
  `entityUrls` entry for batch calls, only for `paths` that match, with the
  `Retry-After` in `headers`, `error.retryAfter` or the message (`mode:
  "result"`); `rateLimit: { perSecond, burst?, mode?, status?, retryAfter?,
  tool? }` (option) throttles `tools/call` beyond a token bucket, a bench
  scenario; `throttled` counts throttled answers; requests record `tool`
  and `at` (from the `now` option).
- `FakeClock` — virtual time for the limiter and retries (`clock`,
  `sleep` options): `advance(ms)`, `next()`, and `run(promise)`, which fires
  timers whenever nothing else is happening.
- `fakeAuth({ account?, token?, signedIn?, cache?, browserUrl? })` — a
  strategy that signs in instantly as `account`; `cache` keeps the sign-in
  (account, access and refresh token) in the connector's storage
  (`fake-token-cache.json` by default) so it survives reloads and sign-out
  deletes it; `browserUrl` is opened with `ctx.host.openExternal` on sign-in; `FakeTokenProvider` for finer control (manual
  sign-in, token errors, `refreshable`, `notice` for a memory-only sign-in).
- `memorySecretStore({ unavailable? })` — an in-memory OS credential store
  (`entries`, `calls`); set `unavailable` to an error to act like Linux
  without a Secret Service.

`bun test test` covers the state machine, terms gate, upstream relays,
transport retries, the limiter and retry policy on a virtual clock (shared
cool-down, caps, AIMD, queue limits, fairness, abort, progress cadence,
write rules, batch splitting and partial re-issue, a token-bucket burst),
protocol negotiation, Entra through the real MSAL flow (offline:
injected network client, real loopback), the sealed token cache (migration,
sign-out, a missing or tampered key, no credential store) against
`memorySecretStore()`, MCP OAuth against the fake
authorization server, and the entitlement cases. Nothing touches the real
network. Not exercised against real services: Microsoft Entra itself, a real
MCP OAuth authorization server, a real 2026-07-28 server, and real
throttling (where a service puts `Retry-After` inside a result).
