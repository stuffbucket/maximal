# maximal

Local proxy that lets Anthropic-API and OpenAI-API clients (Claude Code,
Claude Desktop in Cowork mode, Codex, etc.) talk to GitHub Copilot's
backend, including GitHub Enterprise deployments. It adds a server-side
web-tools agent loop, model-id rewriting for Claude Desktop's picker,
and an Ollama Cloud–backed search/fetch executor.

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
                           id rewriter, executors, client-app integrations).
tests/                     bun-test suites.
shell/                     Tauri desktop app (menu-bar shell + settings and
                           dashboard UIs) that runs the proxy as a sidecar.
packages/mcp-broker/       Isolated MCP broker process.
packages/storybook/        Component sandbox for the shell UI.
site/                      Marketing and download site (mxml.sh).
build/                     Packaging inputs (Homebrew formula, Windows
                           installer, app icon).
docs/                      Architecture, commands, design system, wire
                           contracts, dev and admin notes.
scripts/                   Build, release, and operator helpers.
LICENSE                    MIT.
THIRD-PARTY-LICENSE        Bundled-dependency license pointer (npm SBOM)
                           and vendored-asset attributions.
```

## Install

### Desktop app (macOS, Windows)

Download the macOS `.dmg` or the Windows installer from
[mxml.sh](https://mxml.sh) or the
[latest release](https://github.com/stuffbucket/maximal/releases/latest).
The app runs the proxy for you and manages sign-in, client apps, and
API keys from its settings window.

### Homebrew (macOS, Apple Silicon)

```sh
brew install stuffbucket/tap/maximal
```

This taps `stuffbucket/tap` automatically and installs the `maximal`
command. Authenticate once, then run it in the foreground:

```sh
maximal auth --verbose                       # one-time device flow
maximal start --account-type enterprise      # listen on :4141
```

Or run it as a login-persistent background service (logs to
`$(brew --prefix)/var/log/maximal.log`):

```sh
brew services start maximal
```

Upgrade later with:

```sh
brew update && brew upgrade maximal
```

> The formula is Apple-Silicon-only — there is no Intel (`darwin-x64`)
> build. On other platforms, run from source (below) or download a
> binary from the
> [latest release](https://github.com/stuffbucket/maximal/releases/latest).

### Work IQ

See [the Work IQ guide](docs/workiq.md) for signing in from Settings, where
Maximal writes Claude Desktop's config, logs, and admin approval. Linux needs
extra setup: see [the Linux Work IQ guide](docs/linux-workiq.md). Optional Pi
setup is documented [separately](docs/pi-workiq.md).

## Run

From source (for development), substitute `maximal` with `bun run ./src/main.ts`:

```sh
bun install
bun run ./src/main.ts auth --verbose                       # one-time device flow
bun run ./src/main.ts start --account-type enterprise      # listen on :4141
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
| 1 | **CLI flags** | per-invocation | `--port`, `--account-type`, `--verbose`, etc. See `maximal start --help`. |
| 2 | **Environment variables** | shell scope | `OLLAMA_API_KEY`, `ANTHROPIC_API_KEY`, `COPILOT_API_HOME`, `COPILOT_API_ENTERPRISE_URL`, `COPILOT_API_OAUTH_APP`. Bun also auto-loads `.env`. |
| 3 | **Secrets files** | persistent, mode 0600 | `<app dir>/secrets/<provider>` (e.g. `secrets/ollama`). Refused if mode is broader than 0600. |
| 4 | **Config file** | persistent | `<app dir>/config.json`. Schema-validated at boot; bad keys fail with a key path. Unknown keys warn but pass through. |
| 5 | **Built-in defaults** | always | `src/lib/config/config.ts`. |

The app dir is `~/.local/share/maximal` on macOS/Linux and
`%APPDATA%\maximal` on Windows, unless `COPILOT_API_HOME` is set.

### Knob reference

| Knob | CLI | Env | File | Default |
|---|---|---|---|---|
| Listen port | `--port` | — | — | `4141` |
| Listen address | — | `HOST` | — | `127.0.0.1` |
| Account type | `--account-type` | — | — | `individual` |
| Verbose logging | `--verbose` | — | — | off |
| Manual approval | `--manual` | — | — | off |
| Rate limit (s) | `--rate-limit` | — | — | unset |
| Ollama API key | — | `OLLAMA_API_KEY` | `secrets/ollama` | unset |
| Anthropic API key | — | `ANTHROPIC_API_KEY` | `secrets/anthropic` | `config.anthropicApiKey` |
| GitHub token | `--github-token` | — | `app/github_token` | from `auth` flow |
| App home dir | — | `COPILOT_API_HOME` | — | see above |
| Enterprise URL | — | `COPILOT_API_ENTERPRISE_URL` | — | unset |
| OAuth app ID | — | `COPILOT_API_OAUTH_APP` | — | upstream default |
| Use Messages API | — | — | `useMessagesApi` | `true` |
| Use Apply Patch | — | — | `useFunctionApplyPatch` | `true` |
| Web-search broker model (preferred `/responses` model for `web_search`) | — | — | `smallModel` | `gpt-5-mini` |
| Log retention (days) | — | — | `logRetentionDays` | `7` (`0` = delete on cleanup tick) |

Maximal listens on `127.0.0.1` by default, so only this computer can reach it.
To let other machines use it (a LAN or a container host), set `HOST` to the
address to listen on, for example `HOST=0.0.0.0 maximal start` for every
interface (`HOST=::` for IPv6). Anyone who can reach that address can use your
Copilot access, so expose it only on a network you trust.

To inspect what the proxy actually thinks its config is:

```sh
maximal debug                    # human-readable
maximal debug --json             # machine-readable
curl http://localhost:4141/_debug/state | jq    # only when running with --verbose
```

Secrets are masked everywhere — the debug output reports `<env>` /
`<file>` / `<config>` / `<unset>`, never the value.

## Releasing

`docs/release-runbook.md` is the canonical checklist. Merge the generated
release PR, wait for the gated release workflow to publish, then merge the
protected updates-manifest PR. `bun run release:manual` is an emergency local
fallback; Maximal is not published to npm.

## Status

Pre-1.0. Functional end-to-end against GitHub Copilot. The web-tools
agent loop lives in `src/routes/messages/web-tools/`; see
`docs/admin/claude-desktop-mdm.md` for Cowork-side configuration.
