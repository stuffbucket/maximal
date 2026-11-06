# Code Style

- **Imports:** Use `~/` alias for `src/` (e.g., `import { foo } from '~/lib/foo'`)
- **TypeScript:** Strict mode — no `any`, `noUnusedLocals`, `noUnusedParameters`
- **Modules:** ESNext only, no CommonJS
- **Naming:** `camelCase` for functions/variables, `PascalCase` for types/interfaces
- **Error handling:** Inference route modules (`/v1/messages`, `/:provider/v1/messages`, `/chat/completions`, `/responses`) register `proxyErrorHandler(wire)` as their Hono `onError` and let errors propagate; the reply is built in `src/lib/errors/proxy-errors.ts` and changed only by the ordered rewrites in `proxy-error-rewrites.ts` (Anthropic's typed envelope on the Anthropic wire, so Claude Code can retry and auto-compact). Other routes catch and call `forwardError(c, error)`. Throw `HTTPError` (`src/lib/errors/http-errors.ts`) for an upstream error response
- **Streaming:** All three API flows support both streaming (SSE via `streamSSE`) and non-streaming, switching on `payload.stream`
