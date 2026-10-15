# Work IQ elicitation spike

This isolated package tests whether `mcp-proxy` can expose a stdio MCP server over authenticated loopback Streamable HTTP while preserving interactive input.

It is not wired into Maximal. It does not add production routes, settings, lifecycle management, or UI.

## Result

The deterministic fixture establishes two different outcomes:

- Stock `mcp-proxy` 6.7.19 forwards ordinary tools and progress, but it does not forward legacy `elicitation/create` or modern 2026-07-28 `input_required`.
- The narrow `modern-forward` handler completes one- and two-round modern interactions while preserving opaque `requestState`, keyed input responses, fresh request IDs, and progress.
- Downstream callers observe cancellation and timeout, but the deterministic marker proves those aborts do not currently reach the stdio fixture through the modern HTTP path. This is a production blocker, not forwarding parity.
- Legacy elicitation remains intentionally unsupported on a shared upstream. A legacy upstream disables the modern HTTP leg and rejects a second simultaneous downstream session, including requests carrying spoofed modern headers.

The modern handler is an experiment, not a production fork. If it is needed, the preferred next step is an upstream contribution to `mcp-proxy`.

## Pinned environment

- Bun 1.3.14
- Node 22.23.2
- pnpm 12.3.4
- `@microsoft/workiq` 1.0.1
- `mcp-proxy` 6.7.19
- split MCP SDK packages 2.3.1

The package has its own lockfile and uses the user's `~/.npmrc`. Do not add a repository `.npmrc` or use the npm CLI.

## Install and verify

```sh
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm run typecheck
mise exec -- pnpm run test
```

The test file is intentionally named `spike.integration.ts`. The package script passes it as an explicit path so the repository's root `bun test` does not discover it before this isolated package is installed.

## Run the deterministic fixture

Create a dedicated random key without putting the value in shell history:

```sh
umask 077
openssl rand -hex 32 > /tmp/maximal-workiq-spike.key
export SPIKE_API_KEY="$(</tmp/maximal-workiq-spike.key)"
```

Start the patched proxy:

```sh
mise exec -- pnpm run proxy -- \
  --mode modern-forward \
  --upstream-protocol modern \
  -- bun run src/fixture.ts --era modern
```

In another shell with the same environment variable:

```sh
mise exec -- pnpm run probe -- \
  --proxy-mode modern-forward \
  --protocol modern \
  --scenario interactive_two \
  --outcome accept
```

Use `--mode stock` and `--proxy-mode stock` to reproduce the stock limitation. Valid outcomes are `accept`, `decline`, and `cancel`. The probe emits sanitized JSON and does not include the API key, endpoint, tool arguments or results, form values, or opaque request state.

## Inspect Work IQ without calling a tool

Confirm the pinned CLI shape first:

```sh
mise exec -- pnpm exec workiq --help
mise exec -- pnpm exec workiq mcp --help
```

Start Work IQ behind the stock proxy:

```sh
mise exec -- pnpm run proxy -- \
  --mode stock \
  --upstream-protocol legacy \
  -- ./node_modules/.bin/workiq mcp
```

Then inspect only initialization and tool count:

```sh
mise exec -- pnpm run inspect -- --protocol legacy
```

Work IQ owns its EULA, tenant consent, and Microsoft authentication. Do not automate `accept-eula`, capture Microsoft tokens, or delete its authentication state. A startup timeout before MCP initialization is a valid result when the required manual setup is incomplete.

## Claude Desktop

Claude Desktop cannot use this loopback endpoint as a hosted remote connector. Testing it requires a temporary local stdio-to-HTTP adapter. Record the actual negotiated protocol and advertised elicitation capability; do not represent a 2025-era stdio client as transparently supporting modern multi-round-trip results. Remove the temporary entry after testing.

## Security boundaries

- The HTTP listener binds only to `127.0.0.1`.
- Every request requires `X-API-Key` with a dedicated non-empty key.
- Never reuse Maximal shell/client keys, GitHub credentials, or Microsoft credentials.
- Keep credentials in environment variables, not command arguments.
- Logs and reports must not contain Microsoft 365 content, form values, tokens, API keys, tool arguments/results, or state-bearing URLs.
- Treat elicitation messages and schemas as untrusted.
- Never request passwords, API keys, access tokens, MFA codes, or payment credentials.
- URL-mode elicitation must display the full URL and host, require explicit consent, avoid prefetching, and use the system browser.

## UI implication for Maximal

If Maximal eventually terminates elicitation, an OS notification should only attract attention. It should not contain private request content or open a window automatically.

The sidecar should own durable pending-request state, expiration, correlation, and atomic response claiming. A notification or tray badge can focus the existing Settings window at a **Requests** section after explicit activation. Selecting a bounded request can open an in-app native dialog. Multiple requests should queue in Requests rather than stack dialogs. A separate Tauri window is not needed for v1.
