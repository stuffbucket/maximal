---
id: ADR-0023
title: Control plane — stateless JSON-RPC 2.0 over HTTP+SSE (MCP-aligned); /v1 stays REST
status: accepted
date: 2026-08-05
authors:
  - stuffbucket
depends_on:
  - docs/decisions/0006-auth-status-discriminated-union.md
  - docs/decisions/0021-control-surface-hardening.md
links:
  learnings_brief: research_log/2026-08-04-codex-od-learnings-for-electron-client.md
  mcp_transport: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
  mcp_changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog
  a2a_spec: https://a2a-protocol.org/latest/specification/
  a2a_vs_mcp: https://a2a-protocol.org/latest/topics/a2a-and-mcp/
  contract_issue: https://github.com/stuffbucket/maximal-core/issues/4
  discover_issue: https://github.com/stuffbucket/maximal-core/issues/8
---

# Control plane — stateless JSON-RPC 2.0 over HTTP+SSE (MCP-aligned); /v1 stays REST

## Context

Post-excavation, the proxy engine lives in `@stuffbucket/maximal-core`; a new
Electron client at `maximal/client` spawns it as a sidecar (Tauri retired to
`platform/tauri`). The sidecar exposes **two wire surfaces**:

- **`/v1/*` — the proxy.** OpenAI/Anthropic-compatible endpoints. External
  clients (Codex, other tools) hardcode `http://127.0.0.1:4141/v1` in their own
  config; this surface is a fixed external standard we do not own.
- **The control plane** — what the desktop UI uses: auth, config, health,
  capability discovery, and a live event feed.

The open question was the **wire shape of the control plane**. Drivers:
MCP adoption is highly probable for us; a mobile client is possible; A2A is
possible later.

Prior art in this repo:

- **ADR-0006** models `AuthStatus` as a discriminated union
  (`unauthenticated | device_code_issued | polling | authenticated | error`).
- An earlier proposal chain (an SSE feed, then a **WebSocket** transport with a
  presence registry) targeted the now-retired Tauri browser-tab delivery — a
  sidecar managing browser tabs it opened, needing a client→server
  presence/visibility push and multi-tab fan-out that SSE can't carry. Those ADRs
  were removed with the Tauri shell (see git history); their reasoning is
  addressed below.
- **ADR-0021** hardened the control surface (Origin allowlist + mandatory
  `/settings/api` auth + narrowed CORS + a minted same-origin session token),
  with the invariant that **CLI/plugin/SDK clients send no `Origin` and hit
  `/v1/*`** and must stay reachable.

Live-spec research (2026-08, see the learnings brief) settled the direction:

- **MCP is JSON-RPC 2.0, reaffirmed** in spec **2026-07-28** — but that revision
  went **stateless**, *removing* the `initialize` handshake, `Mcp-Session-Id`
  sessions, the standalone GET/SSE endpoint, `Last-Event-ID` resumability, and
  server-initiated JSON-RPC requests, to make a server "a first-class HTTP
  workload with no session management."
- **A2A** reached stable **v1.0**, is deliberately transport-plural (JSON-RPC
  2.0 + gRPC + HTTP+JSON/REST), frames itself as **complementary** to MCP
  (agent-to-agent vs agent-to-tool), and — like MCP — now lives under the Linux
  Foundation.

The durable commitment across both is the **JSON-RPC envelope + stateless,
per-request semantics**; the streaming/session layer above it is what churns.

## Decision

1. **The control plane is JSON-RPC 2.0 over HTTP+SSE, stateless and
   per-request.** It carries auth, config, health, capability discovery, and the
   live feed.
2. **`/v1/*` stays OpenAI/Anthropic REST, untouched.** It is an external
   standard; the ADR-0021 no-`Origin`/`Bearer` CLI invariant is preserved.
3. **Contract-first.** Control ops are defined once in a pure, validator-only
   contract package (maximal-core#4), transport-agnostic. **HTTP is the only
   transport now**; a stdio/JSONL transport is added *only* when a concrete
   driver lands (container-as-subprocess, zero-network sandbox), projecting the
   *same* ops — never a divergent second vocabulary.
4. **MCP alignment = the stateless shape, not the removed mechanics:**
   - Capability discovery is a stateless **`server/discover` RPC**
     (`{ protocolVersion, capabilities, identity }`), callable anytime — **not an
     `initialize` handshake** (maximal-core#8).
   - Per-request `protocolVersion` mirrored to an `MCP-Protocol-Version`-style
     header; **no session**.
   - The feed is **stateless SSE**: snapshot-on-connect (re-read via
     `server/discover`/`status`), then subscribe; **no `Last-Event-ID`
     resumability**. A dropped feed reconnects fresh.
   - **Push = JSON-RPC notification** (no `id`, stream stays open); **close =
     response** (`id` + `result`/`error`, terminal for that request). **No
     server-initiated requests** — core→client needs are client-driven
     (`input_required` result, or an error `code` the client reacts to).
5. **Auth status carries ADR-0006's discriminated union** as the `auth/status`
   result — *not* a new `AUTH_*` code vocabulary. Genuine protocol/transport
   failures use **JSON-RPC error objects** (numeric `code` + `data` carrying a
   string discriminant). Device-flow state lives in the **core-owned token
   store** (resource state, polled per request), not a connection session.
6. **ADR-0021 hardening carries forward:** Origin allowlist + mandatory auth on
   control routes + narrowed CORS + a minted same-origin **session token
   authenticating the SSE/JSON-RPC connection** (taking over 0019's WS-token
   role). `/v1` keeps the enforce/API-key model.
7. **A2A is deferred to a future outward-facing surface.** Its JSON-RPC 2.0
   binding rides the same substrate, so adoption = add an **Agent Card** at a
   well-known URI advertising **only** the JSON-RPC binding (skip gRPC/REST); no
   wire change.

**Why HTTP+SSE, not WebSocket.** The earlier WebSocket proposal (removed with the
Tauri shell) was driven entirely by Tauri browser-tab delivery — a sidecar managing
browser tabs it opened, needing client→server presence push and multi-tab fan-out.
The **Electron client owns native windows**, eliminating both drivers: renderer
visibility/focus is a normal POST; MCP's push model is one-way notifications; and
multiple read-only diagnostics pages each open an **independent stateless SSE**. So
the go-forward control plane uses HTTP+SSE.

## Alternatives considered

- **A WebSocket transport** (the removed pre-Electron proposal). Bidirectional, but
  the control plane needs no client→server socket push (POSTs suffice) and MCP
  deliberately uses HTTP+SSE, not WS. A proxy control plane has no high-frequency
  bidirectional traffic to justify it. Rejected for the go-forward line.
- **Bespoke REST control plane.** Would force a *second* message model when MCP
  (JSON-RPC) lands, then a bridge between them — the exact drift trap. Rejected.
- **gRPC.** HTTP/2-only, binary, browser-hostile (needs gRPC-Web), off-ecosystem
  for MCP. A2A offers it as one binding, but we'd only ever serve JSON-RPC.
  Rejected for this plane.
- **tRPC.** TypeScript-only; a mobile/MCP/Python consumer can't consume TS type
  inference, so it can't be the contract. Rejected.
- **Stateful MCP (`initialize` + `Mcp-Session-Id` + resumable SSE).** The shape
  originally proposed for this work; MCP *removed* it in 2026-07-28. Adopting it
  would fight the ecosystem and add re-init-on-respawn fragility. Rejected.

## Consequences

- **Positive.** An MCP surface becomes a projection of the same dispatcher (no
  separate stack); a future A2A-JSON-RPC or mobile client is just another
  consumer of one contract; statelessness gives crash-restart, renderer-reload,
  and transport-swap resilience; `/v1` untouched keeps every external client
  working.
- **Client↔sidecar design rules (binding on the client + core work):**
  1. **Readiness lives at the process layer** — the stdout ready-line
     (maximal-core#3) + `/health` — not a protocol handshake.
  2. **Auth/flow state lives in the resource** — the core-owned token store
     (maximal-core#5), polled per request — not a session.
  3. **The event feed is snapshot-reconstructable** — re-read state on reconnect;
     never assume the server remembers your position.
  4. **Push = notification; close = response; no server-initiated requests;** an
     in-flight-request failure is a terminal error → retry = new POST.
  5. **The per-request `protocolVersion` header cross-checks** the running
     sidecar against the version we spawned — complements the freshness/digest
     guards (maximal#411).
- **Negative / costs.** Some REST ergonomics lost on the control plane (single
  POST endpoint; no per-resource GET/caching). MCP churns ~quarterly with
  date-stamped revisions and a formal Active/Deprecated/Removed lifecycle — pin
  to a dated revision (start **2026-07-28**) and budget periodic migration. Keep
  the feed loosely coupled (a generic SSE-over-JSON-RPC feed survives revisions;
  a feed hard-wired to an exact MCP streaming envelope may not).
- **Artifacts updated in lockstep:** maximal-core#4 (contract → JSON-RPC + error
  objects + the ADR-0006 union), maximal-core#8 (→ stateless `server/discover`),
  and the learnings brief §2 (Last-Event-ID scoped to `/v1`).

## Out of scope

- The **public 4141 port policy** (prefer-4141 → linear fallback → probe-and-
  identify → attach-as-upstream / fall back / fail-loud, and the older-maximal-
  on-4141 dogfooding chain) — a separate concern, tracked outside this ADR.
- **Which MCP role** we expose (server exposing maximal as a tool / consuming MCP
  servers / both) — decides the first method set, not this transport decision.
- The **gRPC/REST A2A bindings** — only the JSON-RPC binding is ever in scope.

## Open questions

- MCP role (expose / consume / both) — decides the first method set.
- Whether the ADR-0021 minted session-token model needs revision for the Electron
  native-window origin vs a served read-only diagnostics page.
- If a non-idempotent long control operation ever appears, it needs
  application-level checkpointing + an idempotency key (retry resumes the *work*,
  not the stream) — none scoped today.
