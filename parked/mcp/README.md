# Parked: MCP broker strategy

This directory holds Maximal's former generic MCP broker integration. It is
kept in git for reference and possible revival, and is **not part of the
build**: root typecheck, eslint, oxlint, knip, dependency-cruiser, `bun test`,
CodeQL, CI and every packaging channel ignore `parked/`. Nothing outside
`parked/` imports from it. Work IQ is now a built-in plugin
(`packages/plugin-workiq`); this code is not on its path.

## What it was

A strategy for exposing arbitrary stdio MCP servers to local clients through
Maximal:

- **Broker binary** (`broker/`): standalone Bun-compiled `maximal-mcp-broker`.
  `serve` spawns one upstream stdio server per MCP session behind an
  authenticated loopback HTTP listener (mcp-proxy), controlled over
  length-prefixed JSON IPC on stdin/stdout; `stdio-adapter` bridges a stdio
  client (Claude Desktop) to the HTTP endpoint. Includes the elicitation
  forwarding, resumable transport and Windows Job Object containment.
- **Supervisor and catalog** (`sidecar/src/lib/mcp-broker/`): spawns and
  restarts the broker, heartbeat/backoff/circuit breaker, wire-config
  resolution, server log, the known-server catalog, and pending-requests
  (elicitation) store.
- **Client sync** (`sidecar/src/lib/mcp-broker/client-sync.ts`,
  `sidecar/src/apps/claude-code/mcp.ts`, `sidecar/src/apps/claude-desktop/mcp.ts`):
  reconciles desired endpoints into Claude Code (`claude mcp add-json`) and
  Claude Desktop (`stdio-adapter` entries) configs.
- **Service layer, CLI and routes**: `sidecar/src/apps/mcp.ts`,
  `sidecar/src/apps/mcp-cli.ts` (`maximal mcp`), `sidecar/src/routes/mcp/`
  (public `/mcp/<id>` gateway), `sidecar/src/routes/settings/mcp.ts` and
  `requests.ts` (Settings API for endpoints and elicitation Requests).
- **Work IQ via CLI glue**: `sidecar/src/lib/system/workiq-cli.ts`,
  `sidecar/src/lib/mcp-broker/workiq.ts` (state machine and hold-back around
  Microsoft's `workiq` executable), plus `npm-login-config.ts` (npm prefix
  detection for the catalog).
- **Shell UI** (`shell/`): the Settings MCP section and the Requests panel.
- **Tests** (`tests/`) and `docs/` (the old Work IQ guides).

## Where each piece came from

| Parked path | Original path |
|---|---|
| `broker/` | `packages/mcp-broker/` |
| `sidecar/<path>` | `<path>` (same relative path in the repo root) |
| `shell/<path>` | `<path>` (shell UI under `shell/src/ui/...`) |
| `tests/<path>` | `<path>` (root `tests/`) |
| `docs/workiq.md`, `docs/linux-workiq.md`, `docs/pi-workiq.md` | same names under `docs/` |

`git log --follow` on any file reaches its history under the original path.

## Reviving it

The sidecar pieces import root `~/` modules (`~/lib/config`, `~/lib/auth`,
`~/lib/start/proxy-port`, `~/lib/system/*`, `~/lib/platform/*`) as they were
at the time of parking, and the shell and tests assume the removed wiring
(`/settings/api/mcp`, `/settings/api/requests`, `/status`
`subsystems.mcp_broker`, `src/lib/runtime-state` hooks, Tauri tray polling,
`externalBin`, installer/CI packaging of `maximal-mcp-broker`). Reviving needs
reconciling those with the current tree. The config key `mcpBroker` is still
accepted silently by the config schema (as `z.unknown()`).

Relative paths inside `broker/` (for example `.pnpmfile.cjs` requiring
`../../scripts/lockfile-shard-hosts.cjs`) assumed the old `packages/mcp-broker/`
location and need one more `../`. The extracted `mcpBroker` config schema is
`sidecar/src/lib/config/mcp-broker-schema.ts`, and the Settings wire types are
`sidecar/src/lib/config/mcp-settings-types.ts`.
