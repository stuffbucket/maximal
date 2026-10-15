# Maximal MCP broker

Isolated MCP transport process used by the Maximal sidecar.

## Commands

```text
maximal-mcp-broker serve --generation <id> --parent-pid <pid>
maximal-mcp-broker stdio-adapter --url http://127.0.0.1:<port>/mcp/<id>
```

`serve` reserves stdout for length-prefixed control IPC. It receives the resolved
endpoint configuration and a per-launch API key from the sidecar, starts external
stdio MCP commands, and exposes them through authenticated IPv4-loopback HTTP on
a kernel-selected port. Only the sidecar knows that port and key; clients use the
sidecar's stable `/mcp/<id>` route instead.

`stdio-adapter` connects a stdio MCP client to a loopback `/mcp/<id>` URL. It
sends `MAXIMAL_MCP_API_KEY` as a Bearer token when set. It never starts or
supervises `serve`.

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
