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
bun run app:sidecar  # build standalone proxy binary into shell/src-tauri/binaries/
bun run app:dev      # build sidecar + tauri dev (hot-reload)
bun run app:build    # build sidecar + tauri build --bundles app,dmg
```

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

### Tauri shell

`shell/` is a Tauri 2 menu-bar app that wraps the proxy for non-CLI users. `bun run app:sidecar` builds the standalone proxy binary into `shell/src-tauri/binaries/`, and Tauri launches it as a sidecar bound to `127.0.0.1:4142`. The Vite frontend in `shell/src/` talks to the local sidecar over HTTP. The proxy itself is unchanged — the shell is purely packaging plus a tray UI for auth/status.

### Token counting

`/v1/messages/count_tokens`: when `anthropicApiKey` is configured, forwards Claude model requests to Anthropic's free `/v1/messages/count_tokens` endpoint for exact counts. Otherwise falls back to GPT `o200k_base` tokenizer with 1.15x multiplier (`src/lib/tokenizer.ts`).

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
