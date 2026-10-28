# Maximal MCP broker

Isolated MCP transport process used by the Maximal sidecar.

## Commands

```text
maximal-mcp-broker serve --generation <id> --parent-pid <pid>
maximal-mcp-broker stdio-adapter --url http://127.0.0.1:<port>/mcp/<id>
maximal-mcp-broker --version
maximal-mcp-broker --help
```

Wrong arguments print the usage and exit with status 2.

`serve` reserves stdout for length-prefixed control IPC. It receives the resolved
endpoint configuration and a per-launch API key from the sidecar, starts external
stdio MCP commands, and exposes them through authenticated IPv4-loopback HTTP on
a kernel-selected port. Only the sidecar knows that port and key; clients use the
sidecar's stable `/mcp/<id>` route instead.

On Windows, `serve` first puts itself in a Job Object that kills every process
in it when its last handle closes, and keeps that handle open until it exits
(`src/windows-job.ts`). Everything it starts is in the job, so when the broker
exits or is terminated, Windows ends the MCP servers and their children too.
If Windows refuses, `serve` starts nothing, writes
`MCP_BROKER_CONTAINMENT_UNAVAILABLE` with the failed step to stderr, and exits
with status 78. `test/windows-containment.test.ts` checks this on Windows.

However `serve` stops (a `shutdown` frame, stdin closing, the `--parent-pid`
process gone, a signal, or an error), it exits at most 3 seconds after it began
closing its servers, even if an open session holds its HTTP server.

`stdio-adapter` connects a stdio MCP client to a loopback `/mcp/<id>` URL. It
sends `MAXIMAL_MCP_API_KEY` as a Bearer token when set. It never starts or
supervises `serve`. Because Claude Desktop starts its MCP servers only at
launch, the adapter keeps trying for up to 60 seconds while Maximal isn't
listening yet or answers 502/503 (broker down or still starting), and when the
broker restarts under it (its session answers 404) it replays the client's
`initialize` on a new session and resends the request. On stdin close or a
signal it still DELETEs its session. If it can't connect at all, it answers
each request the client already sent with a JSON-RPC error that says why,
writes `ADAPTER_CONNECT_FAILED` (with the HTTP status, if any) to stderr, and
exits with status 1. It never loads `bun:ffi`; only `serve` does, on Windows.

## Dependency patch

`mcp-proxy@6.7.19` accepts port `0`, but its public result does not expose the
address selected by the kernel. `patches/mcp-proxy@6.7.19.patch` adds the bound
TCP address to the source API and published JavaScript/type artifacts. The local
listener test prevents a reserve-close-rebind race from being introduced.

## Development

Use the package-local mise pins and pnpm lockfile:

```text
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm typecheck
mise exec -- pnpm test
mise exec -- pnpm build
```

Work IQ is not a dependency. It is one possible externally installed stdio MCP
command configured by Maximal.
