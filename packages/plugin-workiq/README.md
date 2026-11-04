# @stuffbucket/maximal-plugin-workiq

The Work IQ connector for maximal. It connects maximal directly to
Microsoft's hosted Work IQ MCP service (`https://workiq.svc.cloud.microsoft/mcp`,
MCP Streamable HTTP) with its own Microsoft Entra sign-in, and exposes the
service's tools — exactly the list the service returns from `tools/list` — as
plugin tools under the id `workiq`, so tool names keep the `mcp__workiq__*`
prefix. It is a manifest and Work IQ wording on top of
`@stuffbucket/maximal-connector-kit`, which does the work (see its README for
upstream behaviour, statuses and actions).

## Manifest

`kind: "connector"`, endpoint `https://workiq.svc.cloud.microsoft/mcp`, terms
`https://github.com/microsoft/work-iq`, and Entra sign-in with the same setup
as the Work IQ CLI and agent-kit's tools:

| | |
|---|---|
| Client id | `ba081686-5d24-4bc6-a0d6-d034ecffed87` ("Work IQ CLI", Microsoft's first-party public client) |
| Authority | `https://login.microsoftonline.com/organizations` (work or school accounts) |
| Scope | `fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask` |
| Redirect | `http://localhost:12798` — the registered redirect; sign-in fails with "port 12798 in use" rather than use another port |

Interactive authorization code + PKCE in the system browser, a silent token
for every request, only the signed-in account kept. The token cache is this
connector's own (`<app dir>/plugins/workiq/msal-token-cache.json`, 0600): it
does not read or share agent-kit's keychain-encrypted cache, and it is
separate from Maximal's GitHub/Copilot sign-in. MCP clients never see it.

## Throttling

Work IQ calls Microsoft Graph for the user and reports Graph's answer inside
a normal tool result — per path for `fetch` (`{ results: [{ statusCode,
data, error }] }`), for the whole call otherwise (`{ statusCode, error }`) —
so Graph throttling arrives as a successful MCP result carrying 429/503/504.
Work IQ itself does not retry ("the MCP client makes client-side retry
decisions"). `WORKIQ_THROTTLE` (the kit's `throttle` hooks) and
`WORKIQ_LIMITS` (in the manifest's `connector.limits`) teach the kit's
limiter about that; see the kit README (*Rate limiting*) for the policy.

| Tool | Kind | Lane |
|---|---|---|
| `fetch` | read (batch: `entityUrls`, chunks of 20, throttled paths re-read alone) | by first path |
| `call_function`, `get_schema`, `search_paths` | read | by path argument |
| `fetch_blob` | read | `files` |
| `ask` (2 attempts at most), `retrieve`, `list_agents`, `get_debug_link` | read | `copilot` |
| `do_action` with `actionUrl` `/search/query` | read | by `entityTypes`: `chatMessage` → `teams`, `message`/`event` → `outlook`, `driveItem`/`listItem`/`site`/… → `files` |
| `do_action` (anything else, e.g. `…/send`), `create_entity`, `update_entity`, `delete_entity` | write | by path argument |
| `upload_blob` | write | `files` |
| `accept_eula` | idempotent write | default |
| anything else | from its annotations | by path argument |

Lanes by path (first `entityUrls` entry, else `functionUrl` / `actionUrl` /
`parentUrl` / `entityUrl` / `path`; `users/{id}` treated like `me`):

| Lane | Paths | Cap |
|---|---|---|
| `teams` | `/chats`, `/me/chats`, `/teams`, `/me/joinedTeams`, `/users/*/chats`, `…/teamwork`, `…/onlineMeetings` | 2 in flight, starts ≥ 500 ms apart (Graph throttles Teams hardest) |
| `outlook` | `/me/messages`, `/me/mailFolders`, `/me/events`, `/me/calendar*`, `/me/contacts`, `/me/mailboxSettings`, `/me/reminderView`, … | 4 (Outlook's four concurrent requests per mailbox) |
| `files` | `/drives`, `/shares`, `/sites`, `/me/drive`, `/users/*/drive`, `/groups/*/drive` | 2 (`fetch_blob` carries up to 4 MB) |
| `copilot` | `ask`, `retrieve`, `list_agents`, `get_debug_link` | 2 |
| default | everything else (`/me`, `/me/manager`, people, …) | global cap (4) |

Throttling inside a result (`inspectWorkIqResult`): an entry or body with
`statusCode` 429/503/504, or a Graph error code (`TooManyRequests`,
`activityLimitReached`, `serviceNotAvailable`, …) without one; an error
result whose only text says 429 / Too Many Requests. `Retry-After` is read
from the entry's `headers` (any case), `retryAfter`, `error.retryAfter`,
`error.innerError["retry-after"]`/`retryAfter`, or "retry after N" in the
message. Where Work IQ really puts it is not documented; all of these are
tried, and the fallback schedule applies when none is found.

## Work IQ wording

`WORKIQ_ERRORS` names the Work IQ app in admin consent, assignment and
app-disabled errors, adds an admin hint (Enterprise applications: consent,
assignment, Conditional Access) to every account-level failure, and words
licence, not-enabled and per-request policy denials for Work IQ.
`WORKIQ_WORDING` words the terms step.

## Exports

- The plugin module: `name`, `manifest`, `inject`, `Config`
  (`{ endpoint?, authority? }`, `{}` valid; both "advanced"; overrides must
  be `https:` on `workiq.svc.cloud.microsoft`, respectively
  `login.microsoftonline.com` / `login.microsoft.com`), `apply`.
- `createWorkIqPlugin(options)` — the same module with kit options
  (`endpoint`, `auth`, timeouts, …) for the bench and tests; production never
  reads env vars for them.
- Constants: `WORKIQ_MANIFEST`, `WORKIQ_CLIENT_ID`, `WORKIQ_SCOPES`,
  `DEFAULT_ENDPOINT`, `DEFAULT_AUTHORITY`, `REDIRECT_URI`, `TERMS_URL`.
- Throttling: `WORKIQ_THROTTLE`, `WORKIQ_LIMITS`, and the pieces
  (`workIqKind`, `workIqLane`, `inspectWorkIqResult`, `primaryPath`).

## Bench fixture (`./testing`)

`startFakeWorkIq(options)` starts the kit's fake MCP server seeded with
`WORKIQ_TOOLS` and `WORKIQ_RESULTS`: the 14 tools Claude Desktop showed for
Work IQ, grouped Read-only 6 / Write-delete 5 / Other 3 by annotations.
Twelve were captured; `search_paths` and `upload_blob` are synthetic
(`SYNTHETIC_TOOL_NAMES`), and description text past what the screenshots
showed is marked synthetic in `src/testing/tools.ts`. Results are canned and
clearly fake. `fakeAuth`, `BENCH_ACCOUNT` (bench@contoso.com) and the kit's
other fakes are re-exported:

```ts
const fake = startFakeWorkIq()
const plugin = createWorkIqPlugin({
  endpoint: fake.url,
  auth: fakeAuth({ account: BENCH_ACCOUNT }),
})
```

## Tests

`bun test test`: manifest and config, the fixture's grouping and inputs, the
fixture served end to end through the connector, the Work IQ wording, and
throttling (kind and lane tables, every `Retry-After` location, and
throttled `fetch` paths, writes, search and `ask` end to end against the
fixture on a virtual clock).
The generic behaviour is tested in the kit. No real network or Entra.
