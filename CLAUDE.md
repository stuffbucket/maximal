# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
bun install          # Install dependencies
bun run dev          # Dev mode with watch
bun run build        # Build to dist/ (native Bun import attributes)
bun run start        # Production start (NODE_ENV=production)

# Lint / type / test
bun run lint         # ESLint with cache (auto-fixes staged files pre-commit)
bun run lint:all     # ESLint on entire project
bun run lint:fast    # oxlint — mechanical pass, ~10ms full repo
bun run typecheck    # tsc type check only (no emit)
bun test             # Run all tests
bun test tests/foo.test.ts  # Run a single test file

# Aggregates
bun run check:fast   # lint:fast + typecheck + lint:all (the per-edit inner loop)
bun run check:deep   # check:fast + bun test + knip (end-of-task gate)
bun run deps:check   # dependency-cruiser layer rules
bun run knip         # find unused exports/files

# Optional: meta-analysis stream
bun run analyze      # tails .claude/logs/checks.jsonl into a local Ollama model

# Mutation testing (manual only — not wired into check:deep)
bun run mutate       # Stryker; configure module under test in stryker.conf.*

# Release tooling
bun run release      # cut a release (publishes artifacts)

# Tauri app (menu-bar shell wrapping the proxy as a sidecar on :4142)
bun run app:setup    # one-time: install shell deps + force-build sidecar binary
bun run app:sidecar  # rebuild standalone proxy binary into shell/src-tauri/binaries/
                     # (no-op when binary is newer than src/; override with --force
                     # or MAXIMAL_FORCE_SIDECAR=1 — release pipelines must set it)
bun run app:dev      # build sidecar (if stale) + tauri dev (hot-reload)
bun run app:ui       # UI-only iteration: Vite alone at :1420. Run `bun run dev`
                     # in another terminal so the UI's API calls (which target
                     # :4142 in DEV mode) hit a live proxy. Far faster than
                     # spinning the whole Tauri shell for HTML/CSS tweaks.
bun run app:build    # force-rebuild sidecar + tauri build --bundles app,dmg
```

### Keep local tooling synced to the lockfile

The pre-commit hook runs `bun run lint --fix` on staged files using your
**locally installed** prettier/eslint, while CI's `lint:all` uses the
**lockfile-pinned** versions. If `node_modules` drifts from `bun.lock`
(common right after a `pull`/rebase that bumped a formatter), the hook
reformats lines one way and CI rejects them — surfacing as
`prettier/prettier` errors on lines you never hand-edited (often
`await import(...)` wrapping). After any pull that touches `bun.lock`,
run `bun install` before committing, and sanity-check with
`bunx prettier --version` against the `bun.lock` pin. If CI lint fails on
a formatter rule you didn't author, suspect version skew first: re-install,
`rm .eslintcache`, re-run `bun run lint:all`.

### Fast UI iteration

For HTML/CSS/TS changes under `shell/src/`, **do not** run `app:dev`. The
sidecar binary is a 66 MB Bun compile (~30–90s) and Vite already does
HMR for the UI. Instead:

```sh
# Terminal A — proxy with file watch, bound to :4142 (matches shell/src/api.ts DEV branch).
bun run dev -- start --port 4142

# Terminal B — Vite for the settings UI.
bun run app:ui
# Open http://localhost:1420/settings/
```

`shell/src/main.ts`'s `safeInvoke()` already swallows Tauri-only `invoke()`
calls when running in a plain browser, so the "Reveal in Finder" buttons
no-op gracefully — everything else works.

## Architecture

This is a local proxy that exposes the GitHub Copilot API as both an OpenAI-compatible and Anthropic-compatible HTTP service. It uses GitHub Copilot the same way Opencode's built-in Copilot provider does: authenticate with the user's own Copilot license, route requests to the Copilot endpoint, translate the response shape. The entry point is `src/main.ts` (CLI via `citty`), which dispatches to subcommands: `start`, `auth`, `check-usage`, `debug`.

### Request flow for `/v1/messages` (Anthropic path)

`src/routes/messages/handler.ts` is the core dispatch logic:

1. Rate limit check
2. Parse Anthropic payload
3. Detect subagent marker (`__SUBAGENT_MARKER__` in `<system-reminder>`) → sets `x-initiator: agent`
4. Detect compact requests (Claude Code context compaction)
5. Force `smallModel` for tool-less warmup/probe requests
6. Merge mixed `tool_result` + text blocks to avoid fresh premium request
7. Normalize model ID → look up Copilot model
8. Route to one of three upstream flows:
   - `handleWithMessagesApi` — Copilot native `/v1/messages` (Claude models, preferred)
   - `handleWithResponsesApi` — Copilot `/responses` (GPT models)
   - `handleWithChatCompletions` — fallback for everything else

### Key directories

| Path | Purpose |
|---|---|
| `src/server.ts` | Hono app, middleware stack, route registration |
| `src/lib/` | Shared utilities: config, state, auth, tokens, rate-limit, models, tokenizer, trace |
| `src/routes/` | Route handlers grouped by endpoint family |
| `src/services/` | Upstream API clients (Copilot, GitHub, providers) |
| `tests/` | All test files (`*.test.ts`), Bun built-in runner |
| `shell/` | Tauri menu-bar app (Vite frontend + `src-tauri/` Rust shell) wrapping the proxy as a sidecar |

### Middleware stack (in order)

`traceIdMiddleware` → `logger()` → `cors()` → `createAuthMiddleware` (API key validation via `x-api-key` or `Authorization: Bearer`; unauthenticated paths: `/`, `/usage-viewer`)

### Model routing

`src/lib/models.ts` normalizes Claude model IDs via 5 regex patterns (handles variants like `claude-opus-4-6`, `claude-opus-4.6`). The `useMessagesApi` config flag (default `true`) controls whether Claude-family models use the native Messages API or fall back to Chat Completions.

### Config and state

- `src/lib/config.ts` — `AppConfig` shape, disk read/write from `~/.local/share/copilot-api/config.json` (Linux/macOS) or `%USERPROFILE%\.local\share\copilot-api\config.json` (Windows). Also respects `COPILOT_API_HOME` env var.
- `src/lib/config-schema.ts` — zod runtime validation. Bad config → exit non-zero with key path. Unknown keys → warning, kept via `.loose()`.
- `src/lib/state.ts` — singleton mutable state: tokens, accountType, rate-limit, models cache.
- `src/lib/secrets.ts` — file-based provider keys at `~/.local/share/copilot-api/secrets/<name>` (mode 0600). Env wins; file fills in unset values.
- `src/lib/cache.ts` — `Cache<K,V>` LRU wrapper with hit/miss/eviction metrics. Wrapped instances register globally for `/_debug/state`.

### Diagnostic surfaces

- **`copilot-api debug`** (and `--json`) — effective config, executor selection (which `Executor` `selectExecutor()` would pick), secret sources (env/file/config/unset, never values), paths.
- **`GET /_debug/state`** — live equivalent on a running proxy. 404 by default; gated on `state.verbose`. Useful when restart isn't an option.
- **Daily log** at `~/.local/share/copilot-api/logs/messages-handler-<date>.log` — request payloads, translated SSE events, web-tools agent traces. 7-day retention.

### Parallel-agent convention

This repo can collide on a shared working tree (lint-staged stash + concurrent merge ate a turn already). For parallel agents:
- **Spawned subagents:** pass `isolation: "worktree"` to the Agent tool.
- **Sessions:** create a worktree manually with `git worktree add ../maximal-<task> -b agent/<task>`; clean up with `git worktree remove ../maximal-<task>` after merging back.
- **Never run `git stash pop` in a shared working tree.** It silently merges another in-flight worker's stash into your tree, and on conflict it leaves an inconsistent state that's easy to "clean up" by `rm`-ing files that aren't yours. We lost a session's worth of React-shell work to this exact path: a subagent ran `git stash pop` to bisect a test failure, hit a conflict, and `rm`'d untracked files it didn't recognize. If you need an isolated bisect, use a worktree (see above). If you must inspect a stash, use `git stash show -p stash@{N}` (read-only) and never `pop` / `apply` outside an isolated tree.

See also: `docs/codegen-feedback-loops-practices.md` → Dispatch and review loops.

### Tauri shell

`shell/` is a Tauri 2 menu-bar app that wraps the proxy for non-CLI users. `bun run app:sidecar` builds the standalone proxy binary into `shell/src-tauri/binaries/`, and Tauri launches it as a sidecar bound to `127.0.0.1:4142`. The Vite frontend in `shell/src/` talks to the local sidecar over HTTP. The proxy itself is unchanged — the shell is purely packaging plus a tray UI for auth/status.

### Token counting

`/v1/messages/count_tokens`: when `anthropicApiKey` is configured, forwards Claude model requests to Anthropic's free `/v1/messages/count_tokens` endpoint for exact counts. Otherwise falls back to GPT `o200k_base` tokenizer with 1.15x multiplier (`src/lib/tokenizer.ts`).

## Bun version policy

Pinned in `.bun-version` (read by `bun install` and Bun's own version
manager) AND in `.github/workflows/ci.yml`. Both must move together —
dev/CI drift is what got us a 22-test failure on a Bun `latest`
regression once, and the pin is the antidote.

Bump intentionally:

1. Pick the new Bun version (read its release notes — confirm no
   open regressions affecting our patterns: parallel test loading,
   module-export resolution, `with { type: "file" }` import
   attributes).
2. Run the whole suite locally on the new version: `bun test`,
   `bun run check:fast`, `bun run app:dev`.
3. If green, update **both** `.bun-version` and the `bun-version`
   field in `.github/workflows/ci.yml` in the same commit.
4. Watch the next CI run.

Don't float `latest`. Bun ships fast; a release in a single afternoon
can ship a regression that breaks our test loader, and the difference
between "we picked this Bun" and "CI happened to pull this Bun" is
the difference between a one-line fix and an hour of triage.

Cadence: rev every ~4-6 weeks for hygiene, or sooner when a needed
feature/fix lands upstream. Don't let the pin go stale enough to
miss security fixes.

## Code Style

- **Imports:** Use `~/` alias for `src/` (e.g., `import { foo } from '~/lib/foo'`)
- **TypeScript:** Strict mode — no `any`, `noUnusedLocals`, `noUnusedParameters`
- **Modules:** ESNext only, no CommonJS
- **Naming:** `camelCase` for functions/variables, `PascalCase` for types/interfaces
- **Error handling:** Route handlers catch and call `forwardError(c, error)`; use `HTTPError` from `src/lib/error.ts`
- **Streaming:** All three API flows support both streaming (SSE via `streamSSE`) and non-streaming, switching on `payload.stream`

## Plugin Integrations

- **Claude Code plugin:** Install from marketplace with `/plugin marketplace add https://github.com/caozhiyuan/copilot-api.git` then `/plugin install claude-plugin@copilot-api-marketplace`. Injects `__SUBAGENT_MARKER__` on subagent starts.
- **Opencode plugin:** Copy `.opencode/plugins/subagent-marker.js` to `~/.config/opencode/plugins/`.

## Design Context

UI work in this repo follows `.design-context.md` in the repo root. **Read it before touching any HTML/CSS/component code** for the Tauri windows or the proxy-served pages.

**Direction in brief:** humanist-powerful — dense with capability but never overwhelming. Dark-first with light + system override; user-themable accent and surface colors with contrast guardrails (warn at sub-WCAG-AA, never block). Sidebar nav for multi-section windows, scroll-only for single-section. Three surface levels, three elevation levels, fixed spacing scale.

**Five principles override all other guidance in conflicts:**
1. Speak to the person, not the file
2. Power lives in depth, not density
3. Color is the user's, contrast is ours
4. One humanist accent per window
5. Reduced motion is a contract, not a hint

The design-* skills (design-frontend, design-onboard, design-critique, design-check, design-typography-rules, etc.) consult this file. If output feels generic, the file needs sharpening — update it, don't override it inline.
