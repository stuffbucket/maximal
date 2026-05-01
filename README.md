# maximal

Local proxy that lets Anthropic-API and OpenAI-API clients (Claude Code,
Codex, etc.) talk to GitHub Copilot's backend, including GitHub Enterprise
deployments.

## What this gives you

Run the proxy locally, point your client at it, and Copilot serves the
model. Claude Code thinks it's talking to `api.anthropic.com`; Codex
thinks it's talking to `api.openai.com`; both are actually hitting GHC.

GHE is supported via `COPILOT_API_ENTERPRISE_URL`.

## Layout

```
vendor/copilot-api/   The proxy itself, vendored from caozhiyuan/copilot-api.
                      MIT, see vendor/copilot-api/LICENSE.
contrib/              Reference snapshots (ollama, opencode, ericc fork).
                      Not built or shipped. See contrib/README.md.
NOTICE.md             Vendoring provenance and refresh procedure.
```

## Status

Pre-alpha. Vendored sources unmodified; configuration and verification
against x3-design GHE pending.

## Run

See `vendor/copilot-api/README.md` for the upstream usage. Key env vars:

- `COPILOT_API_ENTERPRISE_URL` — set to your GHE host (e.g.
  `x3-design.ghe.com`) to route OAuth and Copilot calls to enterprise.
- `COPILOT_API_OAUTH_APP=opencode` — use opencode's OAuth client ID
  (User-Agent spoofing for legitimacy with Copilot's backend).

Then point Claude Code at the proxy:

```sh
ANTHROPIC_BASE_URL=http://localhost:4141 \
ANTHROPIC_AUTH_TOKEN=anything \
claude
```
