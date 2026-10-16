# Work IQ elicitation spike — 2026-10-13

## Scope

This spike tested `@microsoft/workiq` 1.0.1 behind `mcp-proxy` 6.7.19 without integrating either into Maximal production code.

It used an authenticated `127.0.0.1` Streamable HTTP endpoint and a deterministic dual-era stdio fixture. No Microsoft 365 query was run, and no API key, token, tool argument/result, form value, or Microsoft content was recorded.

## Exact pins

| Dependency | Version |
|---|---:|
| Work IQ npm package | 1.0.1 |
| Work IQ binary | 1.0.1.47154 |
| `mcp-proxy` | 6.7.19 |
| MCP split packages | 2.3.1 |
| Bun | 1.3.14 |
| Node | 22.23.2 |
| pnpm | 12.3.4 |

## Deterministic fixture results

Thirteen integration tests passed.

### Stock proxy

- Accepted a correct dedicated `X-API-Key` and rejected missing or incorrect keys.
- Bound to IPv4 loopback rather than IPv6/all interfaces.
- Forwarded ordinary tool calls.
- Forwarded progress notifications; the client may coalesce adjacent notifications, so the assertion is delivery rather than an exact callback count.
- Did not forward modern 2026-07-28 `input_required`.
- Did not falsely route legacy server-pushed `elicitation/create` to a downstream client.

### Narrow modern forwarding experiment

Replacing only the `tools/call` handler and opting the upstream client into manual MRTR mode successfully preserved:

- One- and two-round `input_required` flows.
- Fresh JSON-RPC request IDs for each retry.
- Opaque `requestState` without rewriting it.
- Matching keyed `inputResponses`.
- Distinct accept, decline, and cancel outcomes.
- A caller-owned maximum round limit.
- Progress delivery.
- Downstream-observed cancellation and request timeout.
- Child-process and HTTP-listener cleanup.

The fixture writes a marker if its upstream request signal is aborted. No marker appeared within the bounded observation period after either downstream cancellation or timeout. The modern HTTP caller stops waiting, but the abort does not currently reach the stdio fixture. This is a precise production blocker; the narrow handler preserves the stock signal wiring but does not provide end-to-end cancellation parity.

For a legacy upstream, the proxy disables the modern HTTP leg and rejects a second simultaneous downstream session, including a request carrying spoofed modern headers. This prevents ambiguous ownership of server-pushed legacy requests; it is not multiplexed legacy elicitation support.

The test run completed with:

```text
13 pass
0 fail
35 expect() calls
```

`mcp-proxy` attempts to maintain an upstream `subscriptions/listen` stream for modern traffic. The minimal fixture does not implement that stream, so cleanup can emit a bounded reopen diagnostic. It did not affect the tested request/response behavior or leave the process running.

## Pinned Work IQ observations

The installed CLI confirms:

```text
workiq mcp  Start MCP stdio server for agent communication
```

Work IQ was started behind the stock loopback proxy and inspected without calling a tool. Observed sanitized initialization data:

```json
{
  "advertisedCapabilities": {
    "completions": false,
    "logging": true,
    "prompts": false,
    "resources": false,
    "tools": true
  },
  "negotiatedProtocol": "2025-11-25",
  "protocolEra": "legacy",
  "requestedProtocol": "legacy",
  "toolCount": 14
}
```

Forcing modern negotiation failed as expected:

```text
Version negotiation failed: the server did not offer pinned protocol version 2026-07-28 via server/discover (no fallback in pin mode)
```

Therefore Work IQ 1.0.1 is a 2025-era MCP server. The narrow modern `input_required` forwarding experiment does not change Work IQ 1.0.1 behavior.

No Work IQ tool was invoked, so the run did not trigger or claim to characterize a real interactive operation. The package README places form elicitation for `get_debug_link` under **Unreleased**, not 1.0.1. If this pinned version emits any MCP elicitation, its negotiated era means it must use the legacy server-to-client request model rather than modern `input_required`.

Work IQ startup took longer than the original 10-second client timeout. The spike now allows 30 seconds for upstream initialization; the observed startup completed within that bound.

## Claude Desktop status

Claude Desktop was not modified or restarted during this run. Its actual negotiated era and elicitation capability remain unmeasured. A valid test requires a temporary local stdio-to-HTTP adapter because a hosted remote connector cannot reach `127.0.0.1`. The temporary entry must be removed afterward.

Do not infer modern MRTR support from the deterministic probe: the probe is an SDK v2 client, not Claude Desktop.

## Decision

### What works now

Maximal can broker Work IQ 1.0.1 from stdio to authenticated loopback HTTP for ordinary tools. Work IQ retains ownership of EULA state, tenant consent, Microsoft authentication, account selection, and token storage.

### What does not work now

A shared Work IQ 1.0.1 upstream cannot safely forward legacy elicitation through stock `mcp-proxy`. The modern forwarding experiment is valid and small, but it does not solve that legacy ownership problem.

### Production gate

- If the needed Work IQ operations remain non-interactive, a Work-IQ-specific stdio-to-HTTP broker is technically viable.
- If Work IQ begins using legacy elicitation, use one Work IQ process/upstream client per downstream session or terminate the interaction in Maximal. Do not multiplex server-pushed requests through one shared upstream.
- If a future Work IQ release negotiates 2026-07-28, first fix and verify end-to-end cancellation, then upstream the narrow `input_required` forwarding change to `mcp-proxy`; do not maintain duplicated proxy internals indefinitely.
- Do not advertise elicitation support on behalf of a downstream client that cannot render it.

## Maximal UI conclusion

If Maximal terminates elicitation, the notification is only an attention mechanism:

1. The sidecar owns durable pending-request state, expiry, correlation, and atomic response claiming.
2. A privacy-safe OS notification and tray badge indicate that input is waiting.
3. Nothing opens or steals focus automatically.
4. Explicit notification or tray activation focuses the existing Settings window at a **Requests** section.
5. Selecting a bounded request can open an in-app native dialog following the existing focus and cancel behavior.
6. Multiple requests queue in Requests rather than stacking dialogs. No separate Tauri window is needed for v1.

Messages and schemas are untrusted. The UI must validate size and type, distinguish accept/decline/cancel, reject credential/payment collection, and require explicit system-browser handoff for URL-mode requests.
