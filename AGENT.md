# AGENT.md

Project-context file for opencode (https://opencode.ai). Loaded
automatically when opencode runs in this repo. Mirrors the content of
`CLAUDE.md` (used by Claude Code) so both agents share one source of
truth on conventions; opencode-specific notes are at the end.

## Commands

```sh
bun install          # Install dependencies
bun run dev          # Dev mode with watch
bun run build        # Build to dist/ via tsdown
bun run start        # Production start (NODE_ENV=production)
bun run lint         # ESLint with cache (auto-fixes staged files pre-commit)
bun run lint:all     # ESLint on entire project
bun run typecheck    # tsc type check only (no emit)
bun test             # Run all tests
bun test tests/foo.test.ts  # Run a single test file
```

## Architecture

Local proxy that exposes the GitHub Copilot API as both an
OpenAI-compatible and Anthropic-compatible HTTP service. Authenticates
against the user's own Copilot license, routes to Copilot's endpoint,
translates response shape. CLI entry: `src/main.ts` (citty), dispatches
to `start`, `auth`, `setup`, `configure-claude-desktop`, `uninstall`,
`check-usage`, `debug`. The shipped binary is named `maximal`; older
docs may still say `copilot-api`.

### Request flow for `/v1/messages` (Anthropic path)

`src/routes/messages/handler.ts`:

1. Rate limit check
2. Parse Anthropic payload
3. Detect subagent marker (`__SUBAGENT_MARKER__` in `<system-reminder>`)
   → sets `x-initiator: agent`
4. Detect compact requests (Claude Code / opencode context compaction)
5. Force `smallModel` for tool-less warmup/probe requests
6. Merge mixed `tool_result` + text blocks (avoid fresh premium request)
7. Normalize model ID → look up Copilot model
8. Route to one of three upstream flows:
   - `handleWithMessagesApi` — Copilot native `/v1/messages` (Claude
     models, preferred)
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
| `docs/spec/phase-*.md` | Roadmap PRDs for ongoing work |

### Middleware stack (in order)

`traceIdMiddleware` → `logger()` → `cors()` → `createAuthMiddleware`
(API key validation via `x-api-key` or `Authorization: Bearer`;
unauthenticated paths: `/`, `/usage-viewer`).

### Model routing

`src/lib/models.ts` normalizes Claude model IDs via 5 regex patterns
(handles variants like `claude-opus-4-6`, `claude-opus-4.6`). The
`useMessagesApi` config flag (default `true`) controls whether
Claude-family models use the native Messages API or fall back to Chat
Completions.

### Config and state

- `src/lib/config.ts` — `AppConfig` shape, disk read/write from
  `~/.local/share/copilot-api/config.json` (Linux/macOS) or
  `%USERPROFILE%\.local\share\copilot-api\config.json` (Windows). Also
  respects `COPILOT_API_HOME` env var. The config-dir name remains
  `copilot-api` even after the binary rename to `maximal` (intentional
  — internal-only path, no migration needed).
- `src/lib/config-schema.ts` — zod runtime validation. Bad config →
  exit non-zero with key path. Unknown keys → warning, kept via
  `.loose()`.
- `src/lib/state.ts` — singleton mutable state: tokens, accountType,
  rate-limit, models cache.
- `src/lib/secrets.ts` — file-based provider keys at
  `~/.local/share/copilot-api/secrets/<name>` (mode 0600). Env wins;
  file fills in unset values.
- `src/lib/cache.ts` — `Cache<K,V>` LRU wrapper with hit/miss/eviction
  metrics. Wrapped instances register globally for `/_debug/state`.

### Auth

- Device-code flow against `Iv1.b507a08c87ecfe98` ("GitHub Copilot
  Chat") — the same App Cursor / opencode / copilot.vim use. Auth
  identity is shared with other Copilot tools.
- Tokens at `~/.local/share/copilot-api/<oauth-app>/github_token` as
  schema-versioned JSON (`src/lib/github-token-store.ts`); legacy bare
  strings auto-upgrade on first read.
- Token-prefix detection in `setupCopilotToken`: `gho_` (OAuth-App)
  used directly as Copilot bearer; `ghu_` (GitHub-App) goes through
  `/copilot_internal/v2/token` exchange + 25-min refresh loop.
- `maximal setup` auto-opens `https://github.com/login/device` and
  copies the `user_code` to clipboard. `--no-browser` opts out for
  SSH/headless.

### Diagnostic surfaces

- **`maximal debug`** (and `--json`) — effective config, executor
  selection (which `Executor` `selectExecutor()` would pick), secret
  sources (env/file/config/unset, never values), paths.
- **`GET /_debug/state`** — live equivalent on a running proxy. 404 by
  default; gated on `state.verbose`. Useful when restart isn't an
  option.
- **Daily log** at `~/.local/share/copilot-api/logs/messages-handler-<date>.log`
  — request payloads, translated SSE events, web-tools agent traces.
  7-day retention.

### Parallel-agent convention

The working tree can collide if multiple agents touch it concurrently
(lint-staged stash + concurrent merge has bitten us). For parallel work:

- **Spawned subagents:** isolate via worktree.
- **Sessions:** `git worktree add ../maximal-<task> -b agent/<task>`,
  clean up with `git worktree remove ../maximal-<task>` after merging.

### Token counting

`/v1/messages/count_tokens`: when `anthropicApiKey` is configured,
forwards Claude model requests to Anthropic's free
`/v1/messages/count_tokens` endpoint for exact counts. Otherwise falls
back to GPT `o200k_base` tokenizer with 1.15x multiplier
(`src/lib/tokenizer.ts`).

## Code Style

- **Imports:** Use `~/` alias for `src/` (e.g., `import { foo } from '~/lib/foo'`)
- **TypeScript:** Strict mode — no `any`, `noUnusedLocals`, `noUnusedParameters`
- **Modules:** ESNext only, no CommonJS
- **Naming:** `camelCase` for functions/variables, `PascalCase` for types/interfaces
- **Error handling:** Route handlers catch and call `forwardError(c, error)`; use `HTTPError` from `src/lib/error.ts`
- **Streaming:** All three API flows support both streaming (SSE via `streamSSE`) and non-streaming, switching on `payload.stream`
- **Tests:** Use Bun's built-in test runner. Path-parameterise filesystem-touching code rather than relying on env-time path capture so tests can use tmpdirs.

## Workflow expectations

- Land changes via PRs to `main` or via direct commits when the change
  is small and safe. The release pipeline auto-triggers on tag push
  (`git tag vX.Y.Z && git push origin vX.Y.Z`).
- Ongoing roadmap is captured in `docs/spec/phase-*.md`. When picking up
  a phase, claim it in commits with the phase number; update the PRD if
  scope changes.
- Don't add backwards-compat shims unless explicitly requested. The
  user prefers clean breaks; migration helpers are a separate code
  review thread when needed.
- Don't write trailing summaries in code comments ("added for X
  feature"); they rot. Comments should explain *why*, not *what*.
- Avoid `--no-verify`, `--force-with-lease` to main, or any
  workflow-skipping flags unless explicitly authorized. The pre-commit
  hook is intentional.

## opencode-specific notes

- The repo's `.opencode/plugins/subagent-marker.js` injects
  `__SUBAGENT_MARKER__` so this proxy can detect opencode-launched
  subagent sessions and tag them with `x-initiator: agent`. Copy to
  `~/.config/opencode/plugins/` (or whatever opencode's plugin path
  is in your version) to enable.
- opencode users often hit Copilot through this proxy with `gho_`
  tokens. The proxy auto-detects and skips the refresh loop. There's
  ongoing work in `docs/spec/phase-7-opencode-client.md` to remove the
  remaining env-var requirements.
- When iterating on the proxy and using opencode as your assistant on
  the same machine, point opencode at `http://127.0.0.1:4141` to
  dogfood the proxy. The Anthropic-compatible endpoint is `/v1/messages`,
  the OpenAI-compatible is `/v1/chat/completions`.
- For Claude Code parity: see `CLAUDE.md` in the repo root.
