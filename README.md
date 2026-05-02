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
docs/upstream/             Snapshots of caozhiyuan's README/CLAUDE.md/AGENTS.md
                           for context when reading the inherited code.
scripts/                   Operator helpers (e.g. install-cowork-egress.sh).
contrib/                   Read-only reference (opencode-copilot auth pattern,
                           Ollama anthropic spike).
LICENSE                    MIT, original copyright Erick Christian Purwanto,
                           Cao Zhiyuan, and contributors. Our additions are
                           under the same license.
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

Key env vars (full list in `src/lib/api-config.ts` and the upstream
README under `docs/upstream/`):

| Var | Purpose |
|---|---|
| `OLLAMA_API_KEY` | Enable hosted search + fetch via ollama.com |
| `COPILOT_API_ENTERPRISE_URL` | Route OAuth + Copilot calls to a GHE host |
| `COPILOT_API_OAUTH_APP=opencode` | Use opencode's OAuth client ID |

Then point Claude Code at the proxy:

```sh
ANTHROPIC_BASE_URL=http://localhost:4141 \
ANTHROPIC_AUTH_TOKEN=anything \
ANTHROPIC_MODEL=claude-sonnet-4-6-20260301 \
claude
```

## Status

Pre-alpha. Functional end-to-end against x3-design enterprise. See
`docs/spec/web-tools.md` for the agent-loop spec and
`docs/admin/claude-desktop-mdm.md` for Cowork-side configuration.
