# @stuffbucket/maximal-plugin-workiq

The Work IQ plugin for maximal. It connects maximal directly to Microsoft's
hosted Work IQ MCP service (`https://workiq.svc.cloud.microsoft/mcp`, MCP
Streamable HTTP) with its own Microsoft Entra sign-in, and exposes the
service's tools — exactly the list the service returns from `tools/list`
(names, descriptions, schemas and annotations unchanged) — as plugin tools.
maximal serves them to MCP clients under the plugin id `workiq`, so tool names
keep the `mcp__workiq__*` prefix. No `workiq` CLI or external MCP process is
involved.

## Requirements

- A **work or school** Microsoft Entra account (personal accounts are refused).
- **Tenant admin consent** for the Work IQ app,
  client id `ba081686-5d24-4bc6-a0d6-d034ecffed87` ("Work IQ CLI", Microsoft's
  first-party public client). Without it sign-in or the service fails with a
  consent error.
- A **Work IQ license** for the account (Microsoft 365 Copilot). Without it
  the service answers HTTP 403 and the plugin reports a licence error.
- Acceptance of Microsoft's Work IQ terms
  (<https://github.com/microsoft/work-iq>), recorded by the `accept-terms`
  action.

## Sign-in and tokens

- Interactive OAuth authorization code + PKCE in the system browser
  (`ctx.host.openExternal`), via `@azure/msal-node`'s loopback listener on
  `http://localhost:12798` (the app's registered redirect; MSAL falls back to
  a free port when it is busy). Authority
  `https://login.microsoftonline.com/organizations`, scope
  `fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask`.
- Sign-in times out after 5 minutes and is cancelled by `sign-out` or by
  unloading the plugin.
- Every upstream HTTP request carries a fresh `Authorization: Bearer` token
  acquired silently (MSAL cache / refresh token).
- Only the most recently signed-in account is kept.
- Files in the plugin's private storage directory `<app dir>/plugins/workiq/`
  (directory 0700, files 0600):
  - `msal-token-cache.json` — MSAL's serialized token cache (refresh and
    access tokens, plain JSON). `sign-out` deletes it.
  - `terms.json` — terms acceptance.

## Upstream behaviour

- Throttling (HTTP 429/503/504) is retried up to 5 attempts in total, waiting
  2, 4, 8 and 16 s, or the server's `Retry-After` (capped at 60 s).
- One upstream MCP session per downstream MCP session id, closed after 10
  minutes idle; calls without a session id and `tools/list` share one session.
  An upstream session the server has forgotten (HTTP 404) is reopened once.
- Upstream progress notifications are relayed to the calling client; upstream
  elicitation requests go to the client of the same session when it supports
  elicitation and are declined otherwise.
- The tool list is refreshed after sign-in and whenever the service sends
  `notifications/tools/list_changed`. No tools are registered until the
  plugin is `ready`; they are removed on sign-out and when the sign-in or
  access is lost.

## Status codes (`ctx.surface.setStatus`)

| `code` | `state` | Meaning | Actions |
|---|---|---|---|
| `working` | `working` | Starting, connecting, or waiting for the browser sign-in | `sign-out` ("Cancel") while signing in |
| `terms-needed` | `needs-setup` | Work IQ terms not accepted yet | `accept-terms` |
| `signin-needed` | `needs-setup` | No usable sign-in (never signed in, signed out, expired, cancelled, timed out); `detail` says why | `sign-in` |
| `ready` | `ready` | Connected; facts Account, Tenant, Tools | `sign-out` |
| `error` | `error` | Admin consent missing, licence missing, personal account, access denied, network or service failure; `summary` is the English explanation | `retry`, `sign-in` (account problems), `sign-out` |

## Actions (`ctx.surface.registerAction`)

| Id | Effect |
|---|---|
| `accept-terms` | Record terms acceptance, then continue to sign-in (or connect when a sign-in is cached). |
| `sign-in` | Interactive browser sign-in, then connect and mirror the tools. A new `sign-in` restarts a pending one. |
| `sign-out` | Cancel any pending sign-in, close upstream sessions, remove the tools, delete the token cache. |
| `retry` | Re-check the sign-in and reconnect. |

Action failures are reported through the status, never thrown.

## Configuration

```jsonc
{ "endpoint": "https://workiq.svc.cloud.microsoft/mcp",            // optional
  "authority": "https://login.microsoftonline.com/organizations" }  // optional
```

`{}` is valid.

## Layout

| Module | Role |
|---|---|
| `src/index.ts` | Plugin module exports (`name`, `meta`, `inject`, `Config`, `apply`) |
| `src/plugin.ts` | `createWorkIqPlugin(options)` — wires the pieces to `ctx`; options are test seams (token provider, retry delays, timeouts, base `fetch`) |
| `src/config.ts` | Config schema and Work IQ constants |
| `src/auth/` | `TokenProvider` interface and the MSAL implementation |
| `src/upstream/` | Bearer-injecting retrying `fetch`, MCP client session, session pool |
| `src/tools.ts` | Upstream `tools/list` → plugin tool definitions |
| `src/state.ts` | Setup state machine, statuses and actions |
| `src/errors.ts` | Error classification and user-facing messages |

## Tests

`bun test test` runs against a real loopback MCP Streamable HTTP server
(`test/fake-workiq.ts`, built on `@modelcontextprotocol/server`), a fake
`TokenProvider`, and the real MSAL provider driven offline (injected Entra
network client, real loopback redirect). No real network or Entra.
