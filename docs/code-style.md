# Code Style

Scoped to the root proxy (`src/`). `client/` (the Electron app) is a
separate TypeScript project — same strict-mode discipline, but its own
`tsconfig.json` with no `~/` alias and its own npm-run lint/test scripts;
see `client/package.json`.

- **Imports:** Use `~/` alias for `src/` (e.g., `import { foo } from '~/lib/foo'`)
- **TypeScript:** Strict mode — no `any`, `noUnusedLocals`, `noUnusedParameters`
- **Modules:** ESNext only, no CommonJS
- **Naming:** `camelCase` for functions/variables, `PascalCase` for types/interfaces
- **Error handling:** Route handlers catch and call `forwardError(c, error)`; use `HTTPError` from `src/lib/errors/error.ts`
- **Streaming:** All three API flows support both streaming (SSE via `streamSSE`) and non-streaming, switching on `payload.stream`
