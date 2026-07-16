---
id: ADR-0018
title: OpenAPI is scoped to the maximal-specific product endpoints, not the translated completion surface
status: accepted
date: 2026-07-14
authors:
  - stuffbucket
supersedes: []
related_adrs:
  - docs/decisions/0016-copilot-provider-coupling-and-api-divergence.md
  - docs/decisions/0017-anthropic-beta-agentic-tree-unsupported.md
links:
  routing: src/server.ts
  messages_handler: src/routes/messages/handler.ts
  responses_handler: src/routes/responses/handler.ts
  embeddings_handler: src/routes/embeddings/route.ts
  chat_completions_handler: src/routes/chat-completions/handler.ts
  setup_status_route: src/routes/setup-status.ts
  token_usage_sse: src/routes/token-usage/route.ts
  settings_sse: src/routes/settings/events.ts
  shell_token_usage_ipc: shell/src/dashboard/main.ts:195
  wire_prds: docs/spec/wire/README.md
mechanism: "@hono/zod-openapi (v1.5.0; peer zod ^4.0.0; peer hono >=4.10.0)"
---

# OpenAPI is scoped to the maximal-specific product endpoints, not the translated completion surface

## Context

We want typed, drift-resistant clients for the endpoints the Tauri shell
(and future first-party tooling) calls, and we want a published contract
for the small set of endpoints that are genuinely **maximal's own
product** rather than a mirror of someone else's API. The obvious move is
"generate an OpenAPI spec for the proxy." The obvious move is wrong for
most of the proxy.

The proxy has two very different kinds of surface:

- **The translated / mirrored completion surface** — `/v1/messages`,
  `/chat/completions`, `/v1/responses`, `/v1/embeddings` (and their
  `/:provider/v1/*` variants). These re-expose the **upstream Anthropic
  and OpenAI wire contracts**. Per ADR-0016 the engine speaks *Copilot's*
  dialect of those contracts, and per ADR-0017 the proxy is a stateless
  translator that intentionally 404s whole branches it does not model.
- **The maximal-specific product endpoints** — `/status`,
  `/setup-status`, `/usage`, and the `/token-usage` snapshot. These are
  *ours*: they describe the proxy's own health, setup readiness, and usage
  accounting. Nobody else publishes a contract for them, and the shell is
  their primary consumer.

This ADR records where OpenAPI belongs (the second group), where it does
not (the first group), which mechanism generates it, and which two
workstreams the decision splits into. It records an **already-made
decision**; it does not open new policy.

## Decision

**Do not generate an OpenAPI spec for the translated / mirrored
completion surface.** Do add a **scoped, Hono-native, Zod-sourced
OpenAPI** for the maximal-specific product endpoints — `/status`,
`/setup-status`, `/usage`, and the `/token-usage` snapshot.

### Why not the completion surface

- **Clients read the upstream docs, not ours.** Claude Code, opencode,
  and Codex speak the **upstream Anthropic / OpenAI contracts** and read
  Anthropic's / OpenAI's published specs for them. A maximal-authored
  OpenAPI for `/v1/messages` et al. would be a second, lower-authority
  copy of a contract we do not own — guaranteed to lag upstream and add no
  value over the real thing.
- **The inbound bodies are cast, not validated.** Every completion
  handler reads its request with a bare `c.req.json<T>()` cast — see
  `src/routes/messages/handler.ts`, `src/routes/responses/handler.ts`,
  `src/routes/embeddings/route.ts`,
  `src/routes/chat-completions/handler.ts`. There is no runtime schema at
  the door to source a spec from, and (per the next workstream) there
  deliberately will not be a *fail-closed* one.
- **OpenAPI 3.x cannot express the streams that dominate this surface.**
  The completion surface is overwhelmingly SSE. OpenAPI 3.x has no way to
  describe an SSE event stream; a spec would document only the non-stream
  shell of an endpoint whose real payload is the stream.
- **A published contract would misrepresent the proxy.** Per ADR-0016 /
  ADR-0017 the proxy is a stateless translator that intentionally returns
  Hono's default 404 for whole unmodeled branches. A first-class,
  published OpenAPI contract implies a stable, fully-modeled API — exactly
  the impression these ADRs work to dispel.

### Chosen mechanism

**`@hono/zod-openapi`** (v1.5.0; peer `zod ^4.0.0` — Zod-4-native; peer
`hono >=4.10.0`).

`createRoute` binds the emitted spec to the **live route definition**:
the same object that registers the handler is the source of the spec, so
the spec **cannot silently drift** from the route. That structurally
satisfies the anti-rot requirement ADR-0016 §7 argues for — the guard is
in the type system and the route wiring, not in a human remembering to
update a hand-written document.

The runner-up, **`hono-openapi`** (standard-schema based), is noted as the
fallback if the `createRoute` rewrite of these routes proves too heavy.
Both are Hono-native; the tiebreaker is the route-binding guarantee above.

### Transport split

OpenAPI is one of three typing mechanisms, matched to transport. It is not
the answer for every client boundary.

| Transport | Endpoints | Typing mechanism |
|---|---|---|
| HTTP JSON (product endpoints) | `/status`, `/setup-status`, `/usage`, `/token-usage` snapshot | **OpenAPI** + Hono `hc` typed client |
| Tauri IPC (invoke / channel) | e.g. `subscribe_token_usage` (`shell/src/dashboard/main.ts:195`) | **Tauri IPC typing (tauri-specta)** — *not* OpenAPI |
| HTTP SSE | `/settings/events` (shell channel; served at `src/routes/settings/events.ts`) | **Standalone JSON Schema** — out of the OpenAPI `paths` |

The point of the table: OpenAPI covers only the HTTP-JSON product
endpoints. IPC is typed at the Tauri boundary, and SSE is described by a
standalone JSON Schema (OpenAPI 3.x cannot carry the stream), so neither
belongs in the OpenAPI `paths`.

### Two separate workstreams

The decision splits into two workstreams that must **not** be conflated:

- **(A) Warn-only request validation on the completion surface.** Add
  `zod.safeParse` over the four completion request bodies purely as
  **internal diagnostics**. This is **explicitly not fail-closed**: it
  logs/warns on shape mismatch and never rejects the request. It must
  tolerate the arbitrary tool-schema traffic ADR-0017 says the proxy
  accepts — rejecting it would break real clients. This workstream emits
  **no spec**; it is observability, not a contract.
- **(B) The scoped product-endpoint OpenAPI.** The `@hono/zod-openapi`
  spec for `/status`, `/setup-status`, `/usage`, and the `/token-usage`
  snapshot, plus the generated `hc` client for shell consumption.

## Consequences

- **The spec stays route-bound and drift-tested.** Because `createRoute`
  ties the spec to the live route, the guardrail is structural; a drift
  test over the generated spec keeps it honest and reds the build if the
  route and spec diverge. This is the ADR-0016 anti-rot posture applied to
  our own endpoints.
- **Publishing implies obligations.** Once external consumers depend on
  these product endpoints, they acquire **stability and versioning
  obligations**: a `v1`-stable contract for the product endpoints, kept
  distinct from the explicitly-**unstable** debug surface. Advertising an
  endpoint in a spec is a promise; scope the spec so we only promise what
  we intend to keep.
- **Exclusions from the spec (explicit):**
  - `/_debug/state` — a free-form diagnostic dump, intentionally
    unstable, must never appear in the published `paths`.
  - `/token` — excluded.
  - **All completion and SSE endpoints** — per the "why not the completion
    surface" reasoning and the transport split above.
- **A proof-of-shape PR scaffolds `/setup-status`** as the first
  `createRoute`-defined product endpoint, to validate the
  `@hono/zod-openapi` shape and the `hc` client ergonomics before the
  remaining product endpoints are migrated.

## Sources

- Provider coupling / anti-rot posture this decision rests on: ADR-0016
  (esp. §7, hardcoded-contract silent rot).
- Stateless-translator / intentional-404 posture: ADR-0017.
- Cast-not-validated completion inbound: `src/routes/messages/handler.ts`,
  `src/routes/responses/handler.ts`, `src/routes/embeddings/route.ts`,
  `src/routes/chat-completions/handler.ts` (bare `c.req.json<T>()`).
- Product endpoints and SSE channels: `src/server.ts`,
  `src/routes/setup-status.ts`, `src/routes/token-usage/route.ts`,
  `src/routes/settings/events.ts`.
- Tauri IPC consumer: `shell/src/dashboard/main.ts:195`
  (`subscribe_token_usage`).
- Wire-surface vocabulary: `docs/spec/wire/README.md`.
- Mechanism: `@hono/zod-openapi` v1.5.0 (Zod-4-native; `hono >=4.10.0`);
  runner-up `hono-openapi` (standard-schema).
