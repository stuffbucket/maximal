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

- `src/lib/config/config.ts` — `AppConfig` shape, disk read/write of `config.json` in the app directory: `~/.local/share/maximal/` (Linux/macOS) or `%APPDATA%\maximal\` (Windows), resolved by `src/lib/platform/paths.ts`. `COPILOT_API_HOME` overrides it. A leading UTF-8 byte order mark (Notepad, PowerShell 5's `Set-Content -Encoding utf8`) is ignored, here and in the Claude Code and Claude Desktop files Maximal reads (`src/lib/platform/json-text.ts`). A `config.json` that isn't valid JSON leaves Maximal on the defaults, and `writeConfig` then refuses with `ConfigUnreadableError` rather than write over the file, until a read succeeds.
- `src/lib/config/config-schema.ts` — zod runtime validation. Bad config → exit non-zero with key path. Unknown keys → warning, kept via `.loose()`.
- `src/lib/runtime-state/state.ts` — singleton mutable state: tokens, accountType, rate-limit, models cache.
- `src/lib/auth/github-token-store.ts` — the GitHub identity store. Multi-account registry (schema v2) at `accounts.json` beside the legacy `github_token`: `{ activeKey, accounts: Record<"login@host", AccountRecord> }`, atomic temp+rename writes. Boot reads the active account; the legacy single-record file is migrated in once (gated, offline→`unknown@host`) and kept as a rollback fallback. The three sign-in producers (device-code, CLI, gh-reuse) all persist a typed `AccountRecord`; switch/remove + the `/settings/api/accounts` routes drive quick-switch (set active → reboot the sidecar into it). Sign-out forgets the active account; Remove forgets a specific one; both touch only maximal's own copy — never `gh`. RMW takes no lock (safe on the single Bun sidecar; see the comment above `addAccountToDefaultRegistry`).
- `src/lib/auth/secrets.ts` — file-based provider keys at `~/.local/share/maximal/secrets/<name>` (mode 0600). Env wins; file fills in unset values.
- `src/lib/runtime-state/cache.ts` — `Cache<K,V>` LRU wrapper with hit/miss/eviction metrics. Wrapped instances register globally for `/_debug/state`.

## Diagnostic surfaces

- **`maximal debug`** (and `--json`) — effective config, executor selection (which `Executor` `selectExecutor()` would pick), secret sources (env/file/config/unset, never values), paths.
- **`GET /_debug/state`** — live equivalent on a running proxy. 404 by default; gated on `state.verbose`. Useful when restart isn't an option.
- **Daily log** at `~/.local/share/maximal/logs/messages-handler-<date>.log` — request payloads, translated SSE events, web-tools agent traces. 7-day retention.
- **MCP server log** at `~/.local/share/maximal/logs/mcp-broker-<date>.log` — the broker's own codes and each MCP server's stderr, prefixed with the endpoint id (`src/lib/mcp-broker/server-log.ts`). Rate-limited; same retention.

## Token-usage sessions

The Dashboard's live flow graph, compact metrics and session table read `GET /token-usage/sessions` (`src/routes/token-usage/route.ts`). The response shape is the zod schema in `src/lib/token-usage/sessions-schema.ts`, which the route parses before serving and the Dashboard parses on reading. It covers the last 24 hours of recorded requests whatever period the summary shows, plus the requests in flight now. Nothing is stored per session: `buildSessionsView` (`sessions.ts`) groups the stored rows by `session_id` on every call. Requests with no session id fold into one `other:<client>` group per client; they have no graph position or context meter.

**Stored per request.** Each `token_usage_events` row also records the client (`claude-code`, `claude-desktop`, `codex` or `other`, from the provisioned API key label, else the user agent: `client.ts`), the cache lifetime and whether the client asked for it (`cache_ttl_s`, `cache_ttl_requested`), whether it was a compaction, the context window numbers with their source, and when the request started (`request_started_at_ms`, the request context's `startTime`; `created_at_ms` is when its usage was recorded, at the end of the response). Migration step 2 adds these columns; the store also adds any of them missing on every open, so a database that ran step 2 before a column joined it catches up. Older rows read as client `other`, no cache, unknown window and no start time. The handlers fill them through `setRequestUsage` (`src/lib/http/request-context.ts`), using the helpers in `request-meta.ts`.

**Session id.** The affinity header wins, then the client's own id, then a fallback: `prompt_cache_key` for Responses (a Codex conversation stays one row), none for chat completions (no row per prompt).

**Several models in one session.** Claude Code sends subagent and side requests (often Haiku, often with no cache marker) under the parent's session id. So a session's cache and context come from each model's latest request, not from the latest request overall. The main model is the one with the most tokens in the session; the session shows its model and its context. The cache shown is the one that lasts longest among the models' latest requests.

**States.** A session is `streaming` while any request with its id is in flight, `warm` while `now < expires_at_ms`, and `cold` otherwise. Warm ends exactly at the expiry: a session at its boundary is cold. `expires_at_ms` is that cache's request completion time plus its lifetime. The Dashboard re-evaluates `warm` against its own clock every second, so a row goes cold without waiting for a poll.

**Client label.** `client_label` is the API key's label when the user named it. The labels the integrations provision (`claude-code`, `claude-desktop`, `codex`) only repeat the client's name, so they come back as null (`customKeyLabel` in `client.ts`).

**In-flight tracker** (`in-flight.ts`). `trackInFlight` is mounted in `src/server.ts` on the inference routes (`/chat/completions`, `/responses`, `/v1/chat/completions`, `/v1/responses`, `/v1/messages` and `/:provider/v1/messages`), after auth. It registers the request until its response body ends, errors or is cancelled, counting the delta text it passes through (`DeltaTextCounter`: the `text`, `thinking`, `partial_json`, `delta`, `content` and `arguments` strings of `data:` lines that carry a `delta` field, so neither SSE framing nor the events that repeat finished text count). Session id and model are read from the request context at list time, because handlers set them after the middleware runs. Entries older than 10 minutes are dropped as leaked, both when a request registers and when the list is read. Streamed characters divided by `STREAM_CHARS_PER_TOKEN` (4) estimate the tokens so far, which add to `flow_per_min`: the whole system's input, output and cache-creation tokens in the trailing 60 s. Cache reads are left out, so a turn that resends a large cached context doesn't read as flow. An entry with no session id counts as flow only. An entry whose session has no stored rows yet shows as a minimal streaming session until its first reply is recorded.

**Rate and live flow.** `rate_per_min` is the mean of the last 5 one-minute buckets; `rates` splits that window into input, output, cache-read and cache-write rates, and `model_rates` preserves the models used inside one session (including subagents). `minutes` holds the last 15 total-token buckets (`minutes.ts`), the same ones the summary uses. The Dashboard turns those rates into an OffscreenCanvas particle graph in a dedicated Web Worker. Endpoints sit on an inner rendezvous ellipse while their measured, center-anchored label blocks target the same angles on a separate outer ellipse. D3-force only nudges labels when their measured bounds collide with another label or a fixed endpoint/center obstacle; the rings and connections stay implicit, as in the American Time Use reference. Particle motion remains the worker's lightweight custom simulation inside the label ring. WebFetch/WebSearch positions remain opt-in illustrative data because tool activity is not persisted.

**Cache lifetime** (`request-meta.ts`). Claude requests on the native Messages API: 5 minutes for any `cache_control` marker, 1 hour when any marker has `ttl: "1h"`, 0 when there is none. Responses requests: 5 minutes, or 24 hours when `prompt_cache_retention` is `"24h"`. A `/v1/messages` request served by a non-Claude upstream model (web tools, GPT) follows the Responses rule, because the upstream model decides what a marker does. Chat completions use 5 minutes.

**Cache confidence** (`CacheObservations` in `sessions.ts`, in memory, one instance for the route). A countdown is `estimated` for an automatic cache or a lifetime nobody asked for, `requested` when the client asked for the lifetime, and `observed` once a resume proved it. A resume is a request on the same model that started more than 5 minutes after the previous one completed, and within the lifetime it asked for. The gap runs to the resuming request's start, so a request that reached a 4-minute-old cache and then ran for two minutes proves nothing. A request with no recorded start makes no resume. A resume that reads back at least half of the previous request's context (input plus cache read plus cache creation) is a hit; anything less is a miss, because a shared prefix (tools, system prompt) can stay cached when the conversation's own cache is gone. After 2 consecutive misses for a model, a lifetime over 5 minutes is cut to 300 s, `cache.downgraded` is true, `cache.downgraded_from_s` holds the lifetime that failed, and confidence is `estimated`; one miss can be an ordinary eviction. A later hit restores the model. Each resume is counted once, by the pair of rows it came from, so repeated polls over the same rows don't recount it. The Dashboard prefixes any countdown that isn't `observed` with "about".

**Context window** (`resolveContextWindow` in `request-meta.ts`). The ceiling is always Copilot's `max_prompt_tokens`. The window depends on the client: Codex uses its catalog entry's `context_window` (and its compaction limit, or Maximal's own threshold when Maximal compacts), falling back to the model listing when the model has no entry; Claude Code with the `context-1m` beta uses 1,000,000; everyone else uses the listed window (`max_context_window_tokens`, else `max_prompt_tokens`, the value `/v1/models` serves). Each row says which in `window_source`. Used tokens are the main model's latest request's input plus cache-read plus cache-creation tokens. The table's meter fills against the limit, the smaller of the window and the ceiling, so its fill, percent and warning steps agree. When the ceiling is the lower one, the tooltip names both: "{used} of {ceiling}, Copilot's limit ({window} is {source})". A compaction point below the limit gets a tick on the meter and a tooltip line of its own.

**Polling.** `shell/src/dashboard/live/controller.ts` polls every 2 s while the page is visible and gives up a read after 10 s, so a hung request can't stop the polling. A failed or invalid read keeps what is on screen and shows the error in the graph. It also ticks once a second for countdowns. The metrics, graph and table render into fixed hosts that the page's string renders never touch, so selection, hover and the open "Chat and completions" section survive polls and re-renders.

**Table** (`table.ts`, `rows.ts`). Columns: client, session (model, start time, short id), state (streaming, warm with a countdown, or cold with the time its cache ran out; a downgraded model names the lifetime that didn't hold), tokens/min, context (a meter plus percent, the quota meter's 75% warning and 90% error steps, and when it last compacted), last request, total. Countdowns read m:ss under 10 minutes, whole minutes under an hour, then whole hours. Times from a day other than today carry a short day name. Streaming and warm sessions come first, busiest first, then a "Cache cold" divider and the 20 most recent cold ones, with a "Show N more" button for the rest. A row is refilled only when its session or locale changed, or when it shows something that reads the clock (a warm countdown every second; "compacted N min ago" and day names every minute).

## Never block the event loop

The proxy is one Bun process with one event loop. A synchronous child process (`execSync`, `execFileSync`, `spawnSync`, `Bun.spawnSync`) holds every in-flight request until the child exits, streaming `/v1/messages` responses included. Settings once ran `npm prefix -g`, `claude --version`, and several `claude mcp add-json` calls this way, inside request handlers, which stalled live traffic for seconds per MCP toggle.

- **Run programs with `runFile()`** (`src/lib/system/run-file.ts`). It never rejects: exit code, output, and `notFound` come back in the result. The `blockingSpawnGuard` lint rule (`eslint.config.js`) bans the synchronous forms in `src/`, except three files that run only before the server listens or in a CLI command.
- **Cache what detection learns.** `npmGlobalPrefix()` shares one spawn across concurrent callers and keeps the answer (a miss is retried after a minute). Synchronous detection (the MCP catalog's `locate()`) reads `cachedNpmGlobalPrefix()` and `cachedNpmLoginConfig()` and never spawns; await `warmNpmDetection()` once before calling it. `readClaudeVersion()` caches by binary path and modification time. Settings polls these lists, so a repeat call must be file probes and cache hits.
- **Async work that used to be serialized by blocking still needs serializing.** `syncMcpClient()` queues passes per client, so two toggles can't interleave `claude mcp remove`/`add-json` for one entry. Each pass reads config when it starts, so it sees what the pass before it recorded.
- **Shutdown is the one synchronous exception.** The `exit` safety net can't await, so `releaseMcpClientOffline()` removes Maximal's client entries by editing files only (`McpClientConfigurator.releaseOffline`).
- **Synchronous file reads can block too.** With endpoint security that scans on open (e.g. Microsoft Defender), the first read of a recently written file can take hundreds of milliseconds. The request hot path is clear (config is cached, logs use streams); Settings code still reads client configs synchronously.

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
    `mock.module(m, () => real)` "restores" the stub (so does
    `() => ({ ...real })`, and `import * as real` is the same object). Capture
    `{ ...(await import(m)) }` before mocking. The `local/mock-module-snapshot`
    rule (`eslint-rules/mock-module-snapshot.js`, wired into
    `mockModuleLeakGuard`) errors when a `mock.module` factory reads a live
    namespace. A leaked no-op `sleep` from
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
- **What a release ships.** `release.yml` attaches the raw binaries (macOS,
  Windows, Linux x64/arm64), the Windows installers, the macOS DMG and
  updater bundle, and the Debian packages (`maximal_*` and
  `maximal-desktop_*`, amd64/arm64, smoke-tested on Debian 13 and Ubuntu
  24.04/26.04), then publishes. Merging the updates-manifest PR redeploys
  mxml.sh, which also rebuilds the signed apt repository from the tags the
  manifest names. Checklist: [`release-runbook.md`](release-runbook.md).

## Tauri shell

`shell/` is a Tauri 2 menu-bar app that wraps the proxy for non-CLI users. `bun run app:sidecar` builds the UI (`bun run build:ui`), regenerates the embed manifest, and compiles both the standalone proxy and isolated MCP broker into `shell/src-tauri/binaries/`. Tauri launches only the proxy as a sidecar bound to `127.0.0.1:4141` (the proxy's default listen address, set by `HOST` and defaulted in `src/lib/start/listen-host.ts`; `HOST=0.0.0.0` exposes it to other machines); the proxy supervises the packaged broker. The settings (React, Bun-bundled) and dashboard (vanilla) UIs live in `shell/ui/{settings,dashboard}` and are **embedded in the sidecar binary**, served by the proxy at `/ui/settings` and `/ui/dashboard` (`src/routes/ui/route.ts`) — from `shell/dist` on disk in dev, from `$bunfs` in the compiled binary. The webview windows point at those `/ui/*` URLs; legacy `/settings` and `/usage-viewer` 301-redirect to them. No Vite — Bun is the bundler.

- **New settings sections are React islands:** `shell/src/ui/islands/<name>-island.tsx` mounting `shell/src/ui/features/<name>/`; hash-nav section routing stays in `shell/src/main.ts`.
- **Updates.** The sidecar decides whether to offer one (`src/lib/update/update-check.ts` reads `https://mxml.sh/updates/manifest.json`; never github.com), which shows the topbar "Update to X.Y.Z" button and the tray item. On Windows and macOS both install in place (`IN_PLACE_UPDATE` in `shell/src-tauri/src/lib.rs`): the shell checks `https://mxml.sh/updates/desktop/<channel>.json` with `tauri-plugin-updater` (the channel comes from the app's version: `X.Y.Z` is `stable`, `X.Y.Z-rc.N` is `rc`), asks the user with a native confirm naming the version, downloads the update and verifies its signature against `plugins.updater.pubkey` and the signed version, then installs and relaunches. On Windows it stops the sidecar first, ends every `maximal-mcp-broker.exe` (the broker, and Claude Desktop's stdio adapters, which run the same file), and runs the NSIS installer, which relaunches Maximal. The NSIS installer and uninstaller end them again first (`shell/src-tauri/windows/hooks.nsh`), as the MSI and `install.ps1` do. On macOS the plugin swaps the `.app` bundle (asking for an administrator password if its folder isn't writable), then the shell stops the sidecar and relaunches. A macOS app that can't replace itself (run from the disk image, from App Translocation, or outside a bundle) skips straight to the fallback. Any failure says so in a native dialog and opens mxml.sh. Linux never installs in place: the Debian/Ubuntu packages update with apt. An apt install (`/usr/bin/maximal` with the package's `/usr/lib/maximal/installed-by-apt` marker; `src/lib/update/install-source.ts`) gets `update_command` in the update status, so the button and the tray item read "Update with apt" and open Settings → Diagnostics, which shows the command to copy; Maximal never runs apt. The shell's background poll shows its "update available" OS notification once per version, across restarts: the last version announced is written to `update-notified` beside the `locale` file (before the notification fires; a failed write is logged and the notification still shows), so launching again while still behind doesn't repeat it. **Check for updates.** The sidecar caches its check for 6 hours; the tray's "Check for updates" item and Settings → Diagnostics' "Check now" button ask for a fresh one with `GET /settings/api/update-status?force=1` (same response shape). The check rate-limits itself: at most one real fetch per 30 s (`FORCE_MIN_INTERVAL_MS` in `update-check.ts`), and a forced check inside that window returns the last result. A real fetch is still a conditional request (ETag), so it costs a 304 when nothing changed. The tray item (always shown beside "Update to X.Y.Z") runs the check through the shell's update-status path (`parse_update_status`), updates the tray item, tells the Settings window to re-read (`update:status` event), and shows a native dialog: "Maximal is up to date (X.Y.Z)", a plain failure message (an answer with `last_error` is a failure even if an older result is known), or that update checks are off. "Check now" calls the same URL from the page, then `refresh_update_status` has the shell re-read the cached result so the tray agrees. `maximal start` also logs one line when a newer version is out (with the apt command for an apt install), and `/status` reports the last check. Release signing, the manifests and the apt repository: [`release-runbook.md`](release-runbook.md), [`decisions/site-runtime-version-manifest.md`](decisions/site-runtime-version-manifest.md), [`linux.md`](linux.md).
- **Linux packages.** `maximal` installs the bun-compiled `maximal` and `maximal-mcp-broker` in `/usr/bin` plus a user systemd unit; `maximal-desktop` is the Tauri app built with `tauri.linux.conf.json` (binary `maximal-desktop`) and `bundle.externalBin: []`. The shell's `sidecar("maximal")` resolves to the file next to its own (canonicalized) executable, so the tray app runs the `maximal` package's `/usr/bin/maximal`, and `maximal-desktop` depends on exactly that version. On Linux the shell starts it with `HOST=127.0.0.1` (`sidecar_platform_env`), like the packaged service, so the proxy listens on loopback only. Packaging and the apt repository live in `build/linux/`.
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
records an absolute path to the native executable inside the npm package,
not a bare name, a mise shim, or an npm launcher that needs `node`. It
can't run npm or pnpm either, so it looks where they put global packages
without starting a process: mise installs, a PATH symlink, `npm prefix -g`,
npm's `prefix` from the environment or `~/.npmrc`, Homebrew and other fixed
prefixes, `~/.npm-global`, `%APPDATA%\npm`, every nvm, fnm, asdf, and
mise-managed Node, Volta's package image, and pnpm's global projects
(`global/5`, and `global/v11/*` behind hash symlinks, resolved into the
store). The install hint pins `@microsoft/workiq@1` (detection relies on
the package layout) and uses mise when it manages tools, else pnpm when it
has global installs and no npm is found, else npm. It also names the
registry host the command downloads from. A GUI-launched Maximal lacks
the terminal's environment, so npm itself is asked through the user's login
shell (`"$SHELL" -lic 'npm config get registry; …; npm prefix -g'`; interactive so a
registry exported from `~/.zshrc` is seen, cmd.exe
on Windows; `src/lib/system/npm-login-config.ts`; async, cached,
refreshed in the background every ten minutes). The order is:
`mcpBroker.catalog.npmRegistry` (it adds `--registry`, or `NPM_CONFIG_REGISTRY=`
for mise, to the command, so it is authoritative), npm's
`@microsoft:registry`, npm's `registry`, then npm's own order read from this
process's environment and npmrc files as a fallback. When none of them
confirms a registry the host is `null` and the card says "It downloads from
your npm registry." rather than naming npmjs.org. npm's reported global prefix
likewise takes precedence over the file-based prefix probes. On Windows,
the Arm build (`bin/win-arm64`) is chosen on an Arm PC even though x64
Maximal runs emulated there and `process.arch` says x64
(`windowsMachineArch` reads `PROCESSOR_ARCHITEW6432`, then
`PROCESSOR_ARCHITECTURE`), falling back to `win-x64`. And
npm's `workiq.cmd` launcher on PATH also leads to the package in the
`node_modules` folder beside it. When
several installs exist, the highest version wins. Adding asks the user to
confirm and writes the
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
config; on Windows the regular one is in `%APPDATA%\Claude`, or for the
Microsoft Store app in `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude`),
Maximal copies that entry's command, args, working directory, and
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
(`CONTROL_PROTOCOL_VERSION`, 4 since endpoint observations carry tool
names); a sidecar and broker from
different builds fail the first frame rather than half-work. The CLI, which has no broker, calls the
running server's loopback-only `POST /_internal/reload`, which re-reads
`config.json` and restarts the broker if needed, so no restart is required. External MCP commands,
including Work IQ when configured, remain separately installed programs;
Maximal does not redistribute them or own their authentication state.

When a broker generation stops or dies, it and everything it started end
with it. On POSIX, each broker generation is a detached process group.
Graceful shutdown is bounded and followed by exact-group `SIGKILL`, including
descendants. On Windows, `serve` first puts itself in a Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (kernel32 through `bun:ffi`,
`packages/mcp-broker/src/windows-job.ts`) and holds the only handle until it
exits. Breakaway isn't allowed, so the MCP servers it starts and their
children are in the job too, and when the broker exits or is terminated,
Windows ends all of them. The supervisor's bounded graceful stop is followed
by `TerminateProcess` on the broker. If Windows refuses any step, the broker
starts nothing and exits with `BROKER_CONTAINMENT_EXIT_CODE` (78); the
supervisor reports `unavailable` with the problem `containment-unavailable`
instead of restarting it, and Settings says the servers couldn't start. A
crashed sidecar is covered twice: the broker's stdin closes, and
`--parent-pid` has the broker check every second whether its parent is gone.
However `serve` stops (a `shutdown` frame, stdin closing, the parent gone, a
signal, or an error), the broker closes its servers and then exits, at most 3
seconds after it began closing, even if an open session holds its HTTP
server. A `serve` that fails exits as soon as it has written its error code. Stdio servers are started with
`cross-spawn` (inside the MCP SDK), which runs a `.cmd` or `.bat` command
through `cmd.exe /d /s /c` with its arguments escaped, rather than
refusing it the way Node does without a shell. The Windows behavior is
tested on a Windows runner by `packages/mcp-broker/test/windows-containment.test.ts`
(the CI `windows-broker` job). Public `/status` exposes only coarse broker
state and enabled-endpoint count.

The broker's startup probe records the tool names each endpoint lists and
reports them in its `ready` frame (`getBrokerEndpointTools`). Each server's
stderr, which the broker used to discard, goes up the broker's stderr as
`[endpoint:<id>] <line>`: control characters stripped, lines shortened, and
limited per endpoint per minute (`packages/mcp-broker/src/server-stderr.ts`).
The supervisor writes it to the MCP server log and keeps each endpoint's last
line that reads like a problem for Settings. Dependencies' own console output
still reaches stderr only as sanitized codes.

### Work IQ sign-in

For a Work IQ endpoint that is on, `GET /settings/api/mcp` adds a `workiq`
status (`src/lib/mcp-broker/workiq.ts`): `not-installed`, `eula-needed`,
`signin-needed`, `starting`, `ready`, or `consent-needed`. It comes from
`workiq config show` (`I-accept-EULA`, `defaultAccount`,
`disableBrokeredAuth`) and the tools the broker saw: Work IQ lists
`accept_eula`, `ask` and `list_agents` before a working sign-in and its
Microsoft 365 tools after, so signed in with only those three is
`consent-needed`. Routes under `/settings/api/mcp/:id/workiq` run, each only
when the user confirms that step: `accept-eula`; `sign-in` (optionally
`config set disableBrokeredAuth=true` first, then `auth login` in the
background, 5 minutes, cancellable with `DELETE`, then a broker restart so the
probe looks again). The commands are a closed set (`src/lib/system/workiq-cli.ts`)
and get the endpoint's environment allowlist, never Maximal's credentials.
User-facing guide: [`workiq.md`](workiq.md).

A Work IQ endpoint that is on isn't handed to the broker until its setup is
done: installed, `I-accept-EULA`, and `defaultAccount` set. On Windows,
`workiq mcp` opens Microsoft's sign-in window by itself as soon as it
starts, outside the card's steps. The server registers
`holdBackWorkIqUntilSetUp` with `setBrokerConfigFilter`, so every start,
reconfigure and restart gives the broker a copy with such an endpoint turned
off. Not read yet counts as not done. Each `workiq config show` (a status,
a step, or `reconfigureBrokerAfterSetupCheck`, which boot, turning an
endpoint on and `/_internal/reload` use) updates what is known, and the
Settings list reconfigures after reading the statuses, so a Work IQ set up
from Terminal starts on the next list. Turning one on that is held back
reports `broker: "setup-needed"` without waiting for the broker, and
`/mcp/<id>` answers it with 503 `MCP_ENDPOINT_SETUP_NEEDED`.

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
