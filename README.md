# maximal

Local proxy that lets Anthropic-API and OpenAI-API clients (Claude Code,
Claude Desktop in Cowork mode, Codex, etc.) talk to GitHub Copilot's
backend, including GitHub Enterprise deployments. Originally forked from
[caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api),
extended with a server-side web-tools agent loop, model-id rewriting
for Claude Desktop's picker, and an Ollama Cloud–backed search/fetch
executor.

## What this gives you

Run the proxy locally, point your client at it, and Copilot serves the
model. Claude Code thinks it's talking to `api.anthropic.com`; Codex
thinks it's talking to `api.openai.com`; both are actually hitting GHC.
GHE is supported via `COPILOT_API_ENTERPRISE_URL`.

Server-side web tools (`web_search_20250305`, `web_fetch_20250910`)
that Copilot rejects natively are resolved by an internal agent loop:
the proxy strips the server-side declaration, substitutes a
client-side shim, drives the model through tool round-trips with
Copilot, and synthesizes the Anthropic-shaped result blocks back to
the client. Set `OLLAMA_API_KEY` to enable real search via ollama.com's
hosted endpoints; otherwise search returns `unavailable` and fetch
runs in-process.

## Layout

```
src/                       Proxy source (request handlers, web-tools agent,
                           id rewriter, executors, services).
tests/                     bun-test suites.
docs/admin/                MDM reference, Cowork client config notes.
docs/spec/                 Architecture specs (web-tools, tool-bridge).
scripts/                   Operator helpers (e.g. install-cowork-egress.sh).
contrib/                   Read-only reference (opencode-copilot auth pattern,
                           Ollama anthropic spike).
LICENSE                    MIT.
THIRD-PARTY-LICENSE        Upstream attribution (caozhiyuan/copilot-api,
                           ericc-ch/copilot-api lineage) and dependency
                           licenses.
NOTICE.md                  Fork lineage + how to pull from upstream.
```

## Run

```sh
bun install
bun run ./src/main.ts auth --verbose                       # one-time device flow
bun run ./src/main.ts start --account-type enterprise      # listen on :4141
```

Or via docker:

```sh
docker compose up -d proxy
docker compose run --rm claude    # Claude Code in a clean container
```

Then point Claude Code at the proxy:

```sh
ANTHROPIC_BASE_URL=http://localhost:4141 \
ANTHROPIC_AUTH_TOKEN=anything \
ANTHROPIC_MODEL=claude-sonnet-4-6-20260301 \
claude
```

## Configuration

Settings can be supplied through five sources. Higher in the list
wins:

| # | Source | Lifetime | Notes |
|---|---|---|---|
| 1 | **CLI flags** | per-invocation | `--port`, `--account-type`, `--verbose`, etc. See `copilot-api start --help`. |
| 2 | **Environment variables** | shell scope | `OLLAMA_API_KEY`, `ANTHROPIC_API_KEY`, `COPILOT_API_HOME`, `COPILOT_API_ENTERPRISE_URL`, `COPILOT_API_OAUTH_APP`. Bun also auto-loads `.env`. |
| 3 | **Secrets files** | persistent, mode 0600 | `~/.local/share/maximal/secrets/<provider>` (Linux/macOS) or `%APPDATA%\maximal\secrets\<provider>` (Windows). Refused if mode is broader than 0600 (POSIX only; Windows relies on NTFS ACLs). |
| 4 | **Config file** | persistent | `~/.local/share/maximal/config.json` (Linux/macOS) or `%APPDATA%\maximal\config.json` (Windows). Schema-validated at boot; bad keys fail with a key path. Unknown keys warn but pass through. |
| 5 | **Built-in defaults** | always | `src/lib/config.ts`. |

### Knob reference

| Knob | CLI | Env | File | Default |
|---|---|---|---|---|
| Listen port | `--port` | — | — | `4141` |
| Account type | `--account-type` | — | — | `individual` |
| Verbose logging | `--verbose` | — | — | off |
| Manual approval | `--manual` | — | — | off |
| Rate limit (s) | `--rate-limit` | — | — | unset |
| Ollama API key | — | `OLLAMA_API_KEY` | `secrets/ollama` | unset |
| Anthropic API key | — | `ANTHROPIC_API_KEY` | `secrets/anthropic` | `config.anthropicApiKey` |
| GitHub token | `--github-token` | — | `app/github_token` | from `auth` flow |
| App home dir | — | `COPILOT_API_HOME` | — | `~/.local/share/maximal` (Linux/macOS), `%APPDATA%\maximal` (Windows) |
| Enterprise URL | — | `COPILOT_API_ENTERPRISE_URL` | — | unset |
| OAuth app ID | — | `COPILOT_API_OAUTH_APP` | — | upstream default |
| Use Messages API | — | — | `useMessagesApi` | `true` |
| Use Apply Patch | — | — | `useFunctionApplyPatch` | `true` |
| Small model alias | — | — | `smallModel` | `gpt-5-mini` |
| Log retention (days) | — | — | `logRetentionDays` | `7` (`0` = delete on cleanup tick) |

To inspect what the proxy actually thinks its config is:

```sh
copilot-api debug                    # human-readable
copilot-api debug --json             # machine-readable
curl http://localhost:4141/_debug/state | jq    # only when running with --verbose
```

Secrets are masked everywhere — the debug output reports `<env>` /
`<file>` / `<config>` / `<unset>`, never the value.

## Releasing

`docs/release-runbook.md` is the canonical checklist for cutting a
`v*` tag. The fast path: `bun run release` (tag + push + npm publish
via `bumpp`) → wait for CI → `bun run release:dmg` from a developer
Mac to add the polished `.dmg` to the release.

## Status

Pre-alpha. Functional end-to-end against x3-design enterprise. See
`docs/spec/web-tools.md` for the agent-loop spec,
`docs/admin/claude-desktop-mdm.md` for Cowork-side configuration, and
`docs/spec/internal-distribution.md` for the v1 distribution plan.
