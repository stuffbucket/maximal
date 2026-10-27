# Architecture

This is a local proxy that exposes the GitHub Copilot API as both an OpenAI-compatible and Anthropic-compatible HTTP service. It uses GitHub Copilot the same way Opencode's built-in Copilot provider does: authenticate with the user's own Copilot license, route requests to the Copilot endpoint, translate the response shape. The entry point is `src/main.ts` (CLI via `citty`), which dispatches to subcommands: `start`, `auth`, `setup`, `app`, `mcp`, `api`, `uninstall`, `check-usage`, `debug`.

## Request flow for `/v1/messages` (Anthropic path)

`src/routes/messages/handler.ts` is the core dispatch logic:

1. Rate limit check
2. Parse Anthropic payload
3. Detect subagent marker (`__SUBAGENT_MARKER__` in `<system-reminder>`, with opt-in `x-claude-code-request-class` / `x-claude-code-agent-type` hint headers as a fallback input) → sets `x-initiator: agent`
4. Detect compact requests (Claude Code context compaction via `x-claude-code-compaction` hint header or prompt heuristics)
5. Short-circuit Claude Code's tool-less startup "Warmup" request with a canned local reply — no upstream call (`src/routes/messages/warmup.ts`). Unrelated to the Claude Code *haiku tier*, which carries subagent tool calls and must stay tool-competent: see `src/lib/models/small-model.ts` `resolveSmallToolModel`
6. Merge mixed `tool_result` + text blocks to avoid fresh premium request
7. Normalize model ID → look up Copilot model
8. Route to one of three upstream flows:
   - `handleWithMessagesApi` — Copilot native `/v1/messages` (Claude models, preferred)
   - `handleWithResponsesApi` — Copilot `/responses` (GPT models)
   - `handleWithChatCompletions` — fallback for everything else

## Key directories

| Path | Purpose |
|---|---|
| `src/server.ts` | Hono app, middleware stack, route registration |
| `src/lib/` | Shared utilities: config, state, auth, tokens, rate-limit, models, tokenizer, trace |
| `src/routes/` | Route handlers grouped by endpoint family |
| `src/services/` | Upstream API clients (Copilot, GitHub, providers) |
| `tests/` | All test files (`*.test.ts`), Bun built-in runner |
| `shell/` | Tauri menu-bar app (Bun-bundled UI + `src-tauri/` Rust shell) wrapping the proxy as a sidecar |

## Middleware stack (in order)

`traceIdMiddleware` → `logger()` → `cors()` → `createAuthMiddleware` (API key validation via `x-api-key` or `Authorization: Bearer`; unauthenticated: `/`, `/status`, `/setup-status`, `/_debug/state`, the `/settings` and `/usage-viewer` redirects, and `/ui/*`; `/mcp/*` authenticates in its own route; `/settings/api/*` always requires a key; the dashboard's `/usage`, `/token-usage*` and `/_internal/*` endpoints trust loopback callers). The list lives in `src/server.ts`.

## Model routing

`src/lib/models/models.ts` normalizes Claude model IDs via 5 regex patterns (handles variants like `claude-opus-4-6`, `claude-opus-4.6`). The `useMessagesApi` config flag (default `true`) controls whether Claude-family models use the native Messages API or fall back to Chat Completions.

Root inference routes resolve the ordered, settings-driven `modelMappings` aliases after model-ID normalization and before live catalog lookup. See [`docs/dev/codex-integration.md`](dev/codex-integration.md) for exact/glob/regex semantics and the editable default alias.

## App integrations

`src/apps/` owns filesystem detection, narrowly scoped configuration, durable intent, and boot/shutdown reconciliation for supported local clients. A new client implements `ClientApp` (`src/apps/index.ts`) and registers in `src/apps/registry.ts`; routes, the CLI and the shell stay app-agnostic. The Codex CLI and Desktop share one conservative user-level provider integration; its exact ownership and recovery contract is documented in [`docs/dev/codex-integration.md`](dev/codex-integration.md).

Claude Code is routed by an ownership-guarded `ANTHROPIC_BASE_URL` plus `apiKeyHelper` in `~/.claude/settings.json` (`src/apps/claude-code/`), reverted on shutdown and on the process `exit` event (`src/lib/start/shutdown.ts`). Don't reintroduce a PATH shim for `claude`.

## Config and state

- `src/lib/config/config.ts` — `AppConfig` shape, disk read/write of `config.json` in the app directory: `~/.local/share/maximal/` (Linux/macOS) or `%APPDATA%\maximal\` (Windows), resolved by `src/lib/platform/paths.ts`. `COPILOT_API_HOME` overrides it.
- `src/lib/config/config-schema.ts` — zod runtime validation. Bad config → exit non-zero with key path. Unknown keys → warning, kept via `.loose()`.
- `src/lib/runtime-state/state.ts` — singleton mutable state: tokens, accountType, rate-limit, models cache.
- `src/lib/auth/github-token-store.ts` — the GitHub identity store. Multi-account registry (schema v2) at `accounts.json` beside the legacy `github_token`: `{ activeKey, accounts: Record<"login@host", AccountRecord> }`, atomic temp+rename writes. Boot reads the active account; the legacy single-record file is migrated in once (gated, offline→`unknown@host`) and kept as a rollback fallback. The three sign-in producers (device-code, CLI, gh-reuse) all persist a typed `AccountRecord`; switch/remove + the `/settings/api/accounts` routes drive quick-switch (set active → reboot the sidecar into it). Sign-out forgets the active account; Remove forgets a specific one; both touch only maximal's own copy — never `gh`. RMW takes no lock (safe on the single Bun sidecar; see the comment above `addAccountToDefaultRegistry`).
- `src/lib/auth/secrets.ts` — file-based provider keys at `~/.local/share/maximal/secrets/<name>` (mode 0600). Env wins; file fills in unset values.
- `src/lib/runtime-state/cache.ts` — `Cache<K,V>` LRU wrapper with hit/miss/eviction metrics. Wrapped instances register globally for `/_debug/state`.

## Diagnostic surfaces

- **`maximal debug`** (and `--json`) — effective config, executor selection (which `Executor` `selectExecutor()` would pick), secret sources (env/file/config/unset, never values), paths.
- **`GET /_debug/state`** — live equivalent on a running proxy. 404 by default; gated on `state.verbose`. Useful when restart isn't an option.
- **Daily log** at `~/.local/share/maximal/logs/messages-handler-<date>.log` — request payloads, translated SSE events, web-tools agent traces. 7-day retention.

## Parallel-agent convention

This repo can collide on a shared working tree (lint-staged stash + concurrent merge ate a turn already). For parallel agents:
- **Spawned subagents:** pass `isolation: "worktree"` to the Agent tool.
- **Sessions:** create a worktree with `git worktree add .claude/worktrees/<task> -b <type>/<task> origin/main` (`<type>` is the Conventional Commit type the work will land as); clean up with `git worktree remove .claude/worktrees/<task>` after merging back. `git worktree add` does **not** run `bun install`, so the gitignored `src/generated/ui-embed.ts` stub won't exist — the gates now self-heal it (`check:fast` and the test preload call `ensure:ui-embed`), but run `bun install` in the new tree anyway if you need its node_modules.
- **The primary checkout sits detached at `origin/main`; no worktree checks out `main`.** A branch can be checked out in only one tree, so a worktree holding `main` strands the primary checkout on whatever feature branch it last had, and that branch goes `[gone]` the moment its PR merges. Refresh with `git switch --detach origin/main`.
- **Tidy branches with `bun run git:tidy`, never `git branch -D`.** It never touches a branch checked out in any worktree, one with an open PR, or one committed to in the last 14 days; it deletes branches whose tip is already in `origin/main` and archives the rest (remote → pushed tag `archive/<branch>/<sha7>`, local → local-only `refs/archive/<branch>/<sha7>`) before removing them, so nothing is lost. Dry run by default; `--apply` to act.
- **Reusing a branch for a follow-up PR?** Land the first PR with a merge commit (see *Release & PR conventions*). A squash leaves the branch's commits outside `main`, so the next PR from that branch re-shows the old diff.
- **Never run `git stash pop` in a shared working tree.** It silently merges another in-flight worker's stash into your tree, and on conflict it leaves an inconsistent state that's easy to "clean up" by `rm`-ing files that aren't yours. We lost a session's worth of React-shell work to this exact path: a subagent ran `git stash pop` to bisect a test failure, hit a conflict, and `rm`'d untracked files it didn't recognize. If you need an isolated bisect, use a worktree (see above). If you must inspect a stash, use `git stash show -p stash@{N}` (read-only) and never `pop` / `apply` outside an isolated tree.
- **Stop after two follow-up commits for the same CI failure** and surface it instead of trying a third guess.
- **`check:deep` passing does not prove a UI change works** — render it (the `ui-layout-verification` skill) before calling it done.

## Testing gotchas

- **Tests run inside a cross-platform user sandbox.** The global preload
  overwrites POSIX, XDG, Windows app-data, Maximal, Claude, and temp-directory
  environment variables before application modules load. It also normalizes
  Bun's cached `os.homedir()` result and provides the same environment to child
  processes. Destructive functions must still accept explicit fixture paths;
  the sandbox is defense in depth. Desktop startup and uninstall never edit
  shell profiles or PATH registries, and package managers/installers own CLI
  exposure and removal. See [`dev/testing-strategy.md`](dev/testing-strategy.md)
  §4.
- **`mock.module` persists forward across files in a run — now lint-enforced.**
  Bun does not reset module mocks between test files, and CI orders files
  differently than local, so an unrestored mock leaks its stub into a
  *sibling* file that then reads stale state — the classic "green locally,
  red on CI" (or vice-versa) failure. This bit us **four times** (the last
  cost a long #229 debugging loop), so an ESLint rule (`mockModuleLeakGuard`
  in `eslint.config.js`, scoped to `tests/**`) now **bans the fire-and-forget
  forms**: `void mock.module(...)` and a bare `mock.module(...)` expression
  statement both error.
  - **Awaited is *not* automatically safe.** `await mock.module(...)` passes
    the lint rule, but an awaited `afterAll` *restore* does **not** reliably
    land before the next file's static imports on CI — so a module mock that
    intercepts a *shared* module still leaks across files even when restored.
    The rule catches the common footgun, not this one.
  - **Restore from a snapshot, not the live namespace.** `mock.module`
    patches the module's namespace object in place, so
    `const real = await import(m)` followed by
    `mock.module(m, () => real)` "restores" the stub. Capture
    `{ ...(await import(m)) }` before mocking. A leaked no-op `sleep` from
    `tests/poll-access-token.test.ts` once turned an orphaned device-code
    poller into an endless promise loop that hung CI. Per-test timeouts can't
    stop that, so `tests/helpers/starvation-watchdog.ts` kills the run after
    60s without an event-loop turn.
  - **The durable fix is to not mock a shared module across files at all.**
    Prefer the **real** module (the test preload redirects `COPILOT_API_HOME`
    to a temp dir, and `getClaudeCodeSettingsPath()` honors `CLAUDE_CONFIG_DIR`
    — so config/settings round-trips are already isolated), or **injectable
    function options**. Only stub a module with no env/injection seam, keep the
    wrapper behaviorally identical (spread `...actual`, forward `...rest`), and
    prove via a sequential-import repro that it can't break a later file.
- **Green tests can still test nothing.** Mutation testing (`bun run mutate`)
  caught classification tests that passed without exercising the branch
  they claimed to cover (the fixture hit a different code path that
  returned the same value). For security-critical or branchy logic, run
  Stryker and confirm the targeted mutants actually die — don't trust a
  passing assertion alone. Every surviving mutant must land in exactly one of
  three buckets — **killable** (write the test), **dead** (delete it / encode
  the impossibility in types), or **proven-equivalent** (written proof + reason
  to keep). See [`dev/testing-strategy.md`](dev/testing-strategy.md) §6 for the
  disposition rule and the hot-path modules that warrant periodic sweeps.

## Release & PR conventions

- **Release is driven by Conventional Commit *types*.** release-please
  scans commits since the last tag; only `feat:` (minor) and `fix:`
  (patch) cut a release. `test:`/`chore:`/`ci:`/`docs:`/`refactor:` are
  release-silent. If release-please "isn't doing anything," it almost
  certainly found no `feat`/`fix` commit — check the `release-pr` step
  log for `No user facing commits found ... skipping` before assuming
  it's broken.
- **`main` accepts squash and merge commits; pick per PR.**
  - *Squash* (default for one-shot PRs): the PR **title** becomes the
    commit subject and the PR **body** its message (repo setting
    `PR_TITLE`/`PR_BODY`; it used to take a single-commit PR's commit
    subject instead, which is how the `chore:` PRs #481/#483 landed as
    `fix:`). The branch's own commits never reach `main`.
  - *Merge commit* (for a branch that keeps living, or whose commits
    each matter): every branch commit reaches `main` and release-please
    reads each one; the `Merge pull request …` subject itself is ignored.
    Afterwards the branch's tip is in `main`, so it can carry a follow-up
    PR and `git:tidy` deletes it losslessly.
- **Every subject release-please can see must be one valid Conventional
  Commit** (`fix: …`, not `test+fix: …` — that parses as one unrecognized
  token and release-please skips it, even if the diff holds a real fix).
  The `commit-msg` hook (`scripts/check-commit-msg.ts`, installed by
  `bun install`) checks each commit locally; CI's `test` job checks the
  PR title and every commit on the PR. CI reads the title when the PR is
  opened or pushed to, so after retitling, push or re-run CI.
- **Auto-merge is on; `main` does not require branches to be up to date.**
  Queue a PR with `gh pr merge --auto --squash` (or `--merge`) and move on.
  CI also runs on every push to `main`, which catches two PRs that pass
  alone but break together.

## Tauri shell

`shell/` is a Tauri 2 menu-bar app that wraps the proxy for non-CLI users. `bun run app:sidecar` builds the UI (`bun run build:ui`), regenerates the embed manifest, and compiles both the standalone proxy and isolated MCP broker into `shell/src-tauri/binaries/`. Tauri launches only the proxy as a sidecar bound to `127.0.0.1:4141`; the proxy supervises the packaged broker. The settings (React, Bun-bundled) and dashboard (vanilla) UIs live in `shell/ui/{settings,dashboard}` and are **embedded in the sidecar binary**, served by the proxy at `/ui/settings` and `/ui/dashboard` (`src/routes/ui/route.ts`) — from `shell/dist` on disk in dev, from `$bunfs` in the compiled binary. The webview windows point at those `/ui/*` URLs; legacy `/settings` and `/usage-viewer` 301-redirect to them. No Vite — Bun is the bundler.

- **New settings sections are React islands:** `shell/src/ui/islands/<name>-island.tsx` mounting `shell/src/ui/features/<name>/`; hash-nav section routing stays in `shell/src/main.ts`.
- **Shell-visible wire types live in `src/lib/config/settings-types.ts`** (zod) and the shell imports them (`shell/src/proxy/client.ts`). Don't hand-copy types into the shell.

## Isolated MCP broker

The optional MCP broker is a separate compiled process under
`packages/mcp-broker/`. The Bun/Hono sidecar remains the only supervisor; Tauri
continues to supervise only the sidecar. `runServer` starts the broker supervisor
after the ordinary HTTP listener is bound and never awaits broker readiness, so
broker startup failure, restart backoff, malformed IPC, and heartbeat timeout do
not gate or terminate normal Maximal service.

The sidecar and broker use versioned 4-byte big-endian length-prefixed JSON over
the broker's stdin/stdout. Frames, UTF-8, JSON, operations, generations, and
sequences are bounded and validated. A ready generation listens on a private
kernel-selected `127.0.0.1` port and requires a random per-generation key that
it receives over IPC. The key is never put on a command line or written to
disk; the sidecar keeps the port and key in memory and withdraws them before
restart or shutdown.

Clients use the stable main-port address `http://127.0.0.1:<port>/mcp/<id>`
(`src/routes/mcp/route.ts`). The route accepts loopback peers only, rejects a
foreign `Origin`, and authenticates with the endpoint's own `apiKey` when one is
configured, otherwise with the normal main-port rules (`auth.enforce`,
`auth.apiKeys`, `auth.apiKeyEntries`). It then streams the request to the
broker with the internal key. Every MCP session runs its own instance of the
endpoint's server (spawned on `initialize`, stopped when the session ends), so
parallel clients behave as if each ran it themselves; `limits.sessions`
(default 8) caps them. At the cap, a new session closes the least recently
used session with no request in flight (a client that exits without a DELETE
leaves one behind, and under Bun the broker never sees its event stream go
away); only when every session is busy does it get a 503 that says so. A
missing or restarting broker returns 503; an unreachable one 502. Concurrency and declared body size are bounded, and only
the wait for response headers is timed, so SSE streams stay open.

`maximal-mcp-broker stdio-adapter --url http://127.0.0.1:<port>/mcp/<id>` lets a
local stdio MCP client reach one endpoint; it reads an optional key from
`MAXIMAL_MCP_API_KEY`.

Endpoints are added, toggled, and removed from Settings → MCP servers or
`maximal mcp <id> --add/--enable/--disable/--remove` (`src/apps/mcp.ts`).

Known servers come from a small catalog (`src/lib/mcp-broker/catalog.ts`;
Work IQ first). Each entry finds the server's own executable and offers it
under "Available to add", or shows its install command when it isn't
found. A GUI-launched sidecar has launchd's minimal PATH, so detection
records an absolute path to the native executable inside the npm package
(mise install, PATH symlink, or npm global prefix), not a bare name, a mise
shim, or an npm launcher that needs `node`. When several installs exist,
the highest version wins. Adding asks the user to confirm and writes the
endpoint off, with `catalog` set. The path contains the package version and
package managers keep old versions after an upgrade, so Maximal re-reads
where the newest install is before every request that opens a session (no
`mcp-session-id`) on a catalog endpoint, as well as at boot, on every
Settings list, and on every `maximal mcp` run. The next instance (say, after
an idle session was closed) therefore runs the upgrade; an uninstalled
server keeps its last path. The CLI can also add any stdio
server given after `--`, as an absolute path. Removing deletes the
endpoint from `config.json` first and then syncs clients: the desired
entries come from `servers`, while what Maximal owns stays recorded per
app, so exactly Maximal's entries come out. Turning one on asks which client apps
should get it; the choice is kept in `mcpBroker.servers[].clients` even while
the endpoint is off, so turning it back on pre-selects it. Each Claude
integration exposes an MCP configurator on its `ClientApp` (`mcp`), and the
shared sync (`src/lib/mcp-broker/client-sync.ts`) decides what each client
should have: endpoints that are on, chose that client, while Maximal's
integration for it is on. What Maximal actually wrote is recorded in
`apps.<client>.mcpServers`, so every change reverts exactly:

- endpoint off → removed from every client;
- client integration off → its MCP entries removed; back on → restored;
- a same-name entry the user already had is never touched (reported as
  skipped), and an owned entry the user edited is forgotten, not deleted.

Entries are generated by Maximal, not copied from the MCP server:

- **Claude Desktop** (`src/apps/claude-desktop/mcp.ts`): a stdio adapter entry
  in the Claude-3p `claude_desktop_config.json`, key in `env`.
- **Claude Code** (`src/apps/claude-code/mcp.ts`): a user-scope HTTP entry to
  `/mcp/<id>`. Added and removed with the `claude` CLI so Claude Code writes its
  own `~/.claude.json`; the CLI only ever sees a SHA-256 placeholder header, and
  Maximal then swaps in the real key with one verified atomic edit of that
  header. Keys stay out of process arguments; the client files hold them under
  normal filesystem protection, like their other credentials.

Entry URLs use the port the proxy is listening on (`src/lib/start/proxy-port.ts`):
the server records it at boot, in-process and in its session sentinel, so the
CLI addresses the same instance. Ownership matches Maximal's `/mcp/<id>` URL on
any loopback port, so after a port change the entry is rewritten rather than
mistaken for the user's; `/_internal/reload` also re-syncs entries from the
server.

Claude Code's Maximal-written entries exist only while Maximal runs: each
session reads `~/.claude.json` when it starts, so shutdown (and the `exit`
safety net) removes them with direct file edits, since spawning `claude`
doesn't fit the 2.5s shutdown budget, and boot re-adds them from the recorded
choices. Claude Desktop's entries stay across shutdown
(`McpClientConfigurator.removeOnShutdown`): Desktop reads its config only at
launch, like its routing profile, so removing them would only make its next
launch come up without the server. Boot sync runs when `config.json` has an
`mcpBroker` section, after the broker is ready (`waitForBrokerReady`, bounded
at 45s and detached from the HTTP listener), so an app that connects right
away isn't turned away with 503 while the broker probes its servers. Turning
an endpoint on in Settings waits the same way before updating the apps, and
reports the broker's state (`ready` / `starting` / `failed`) in the response.

When an endpoint is turned on and an app already has its own stdio entry with
that id (Claude Code user scope, or Claude Desktop's Claude-3p or regular
config), Maximal copies that entry's command, args, working directory, and
non-secret environment into the endpoint once, so the broker runs the same
server. The app's own entry stays untouched; secret-looking environment names
are not copied and are reported. Maximal's own adapter is never adopted.

Config changes reach the in-process broker one of three ways
(`reconfigureBroker`): nothing, when only endpoints that are off or the
apps an endpoint goes to changed; a live `update` control message, when
only how a new session's instance starts changed (command, args, working
directory, environment, timeouts, session cap), which new sessions pick up
while running ones keep their instance; otherwise a restart. The broker
re-checks an `update` and answers `RESTART_REQUIRED` if the endpoints or
how they're served (protocol, interaction, ownership, body limit) differ,
and the supervisor then restarts it. The control protocol is versioned
(`CONTROL_PROTOCOL_VERSION`, 3 since `elicit`); a sidecar and broker from
different builds fail the first frame rather than half-work. The CLI, which has no broker, calls the
running server's loopback-only `POST /_internal/reload`, which re-reads
`config.json` and restarts the broker if needed, so no restart is required. External MCP commands,
including Work IQ when configured, remain separately installed programs;
Maximal does not redistribute them or own their authentication state.

On POSIX, each broker generation is a detached process group. Graceful shutdown
is bounded and followed by exact-group `SIGKILL`, including descendants. Windows
currently fails closed because kill-on-close Job Object containment is not
implemented. Public `/status` exposes only coarse broker state and
enabled-endpoint count.

### Requests for user input (elicitation)

An MCP server can ask the user for input: a form to fill in, or a URL to
open. The broker advertises that it can take these and routes each one by
the endpoint's `elicitation` policy (`packages/mcp-broker/src/elicitation.ts`):

- `passthrough` (the default): the session's own client, if its `initialize`
  said it can show that kind of request; otherwise Maximal. Claude Desktop
  advertises none, so its requests always come to Maximal.
- `maximal`: always Maximal.
- `deny`: decline without asking.

Rules (first match wins) narrow this by tool, mechanism, mode, field types,
URL host and form size. Forms asking for credentials or payment details are
declined, as are requests too large for Maximal to show. An unanswered
request is cancelled after the policy's timeout (5 minutes by default), and
the tool call waiting on it gets that time on top of its own.

To ask Maximal, the broker sends `elicit` on the control channel; the
sidecar's `elicitResult` answers it, and the broker's `elicitWithdrawn` takes
it back (timeout, server cancel, session closed). The sidecar keeps waiting
requests in memory only (`src/lib/mcp-broker/pending-requests.ts`): each
belongs to a live session inside the broker, its child, so none can outlive
a restart, and a generation's requests are dropped when it ends. Forms are
normalized to the field kinds Maximal can show and answers are validated
before they reach the server; only the first answer counts. Settings reads
them from `/settings/api/requests` (also pushed as `requests.changed` on the
events stream), and the shell polls `/settings/api/requests/summary` to
notice new ones. None of this is on the public `/status`, since requests
carry server text.

## Token counting

`/v1/messages/count_tokens`: when `anthropicApiKey` is configured, forwards Claude model requests to Anthropic's free `/v1/messages/count_tokens` endpoint for exact counts. Otherwise falls back to GPT `o200k_base` tokenizer with 1.15x multiplier (`src/lib/models/tokenizer.ts`).
