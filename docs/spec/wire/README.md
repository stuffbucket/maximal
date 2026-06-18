# Wire-Protocol PRDs

This directory describes the proxy's behavior **from a wire-protocol
perspective** — what bytes cross each boundary, in both directions:

```
client  ──HTTP/SSE──▶  Maximal proxy (Hono)  ──HTTP/SSE──▶  GitHub Copilot upstream
        ◀──────────                          ◀──────────
```

Maximal is a local proxy that exposes the GitHub Copilot API as both an
OpenAI-compatible and an Anthropic-compatible HTTP service. Each PRD here
documents one **wire surface**: the public endpoints, the request fields
consumed, the translation applied, the exact upstream call made, the
streaming event mapping, and the error contract. They are descriptive
(they document what the code does today), not aspirational.

These complement, and sit alongside, the strategy/spec docs already in
`docs/spec/` (`model-protocol-strategy.md`, `tool-bridge.md`,
`observability.md`).

## The surfaces

| PRD | Public endpoints | Upstream |
|---|---|---|
| [`auth-transport-wire-prd.md`](auth-transport-wire-prd.md) | (all) — middleware, API-key + GitHub-token gating, CORS, loopback, the shared upstream Copilot transport & header injection, rate-limit & error mapping | — |
| [`messages-wire-prd.md`](messages-wire-prd.md) | `POST /v1/messages`, `/v1/messages/count_tokens`, `/:provider/v1/messages` | Copilot `/v1/messages`, `/responses`, `/chat/completions` |
| [`chat-completions-wire-prd.md`](chat-completions-wire-prd.md) | `POST /chat/completions`, `/v1/chat/completions` | Copilot `/chat/completions` |
| [`responses-wire-prd.md`](responses-wire-prd.md) | `POST /responses`, `/v1/responses` | Copilot `/responses` |
| [`embeddings-wire-prd.md`](embeddings-wire-prd.md) | `POST /embeddings`, `/v1/embeddings` | Copilot `/embeddings` |
| [`models-wire-prd.md`](models-wire-prd.md) | `GET /models`, `/v1/models`, `/:provider/v1/models` | Copilot `/models`; provider `/v1/models` |
| [`usage-status-wire-prd.md`](usage-status-wire-prd.md) | `/status`, `/setup-status`, `/usage`, `/token-usage(/events)`, `/token`, `/_internal/shutdown`, `/_debug/state` | GitHub usage API |

**Read `auth-transport-wire-prd.md` first.** Every other surface inherits
its middleware stack, its client-auth contract, and its upstream
header-injection and error-mapping rules; the per-surface PRDs reference
those sections rather than repeating them.

## Conventions in these docs

- **Client-facing** means between an API caller (Claude Code, Cursor, an
  SDK, `curl`) and the proxy. **Upstream** means between the proxy and
  GitHub Copilot (or a configured passthrough provider).
- Code references are `path:line` against the tree at time of writing.
  They will drift; treat them as starting points, not guarantees.
- "Translate" = reshape one protocol's JSON into another's. "Forward" /
  "pass-through" = relay bytes with only header/ID surgery, no body
  reshaping.
