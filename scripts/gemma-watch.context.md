# Project conventions for gemma-watch's meta-analysis

This file is read once on startup by `scripts/gemma-watch.ts` and prepended
to every meta-analysis prompt sent to the local Ollama model. Keep it
short — every byte goes into every prompt. Update when conventions shift.

## What maximal is

A local HTTP proxy that exposes GitHub Copilot as OpenAI- and
Anthropic-compatible endpoints. Bun + TypeScript + Hono. CLI entry
`src/main.ts` (citty), single-binary distribution via `bun --compile`.

## Layering (violations are a smell)

- `src/routes/` — HTTP handlers. Catch errors via `forwardError(c, err)`.
- `src/services/` — Upstream API clients (Copilot, GitHub, providers).
  Routes call services, services don't call routes.
- `src/lib/` — Shared utilities. No HTTP / no upstream calls.
- Tests under `tests/` use Bun's runner.

## Common code-style mistakes to flag

- `any` is forbidden. `unknown` + a type guard is the move.
- Don't write `// removed: …` or "added for X feature" comments — they rot.
- Use `~/` import alias for `src/` paths.
- Floating promises (no await, no `void`) and non-exhaustive switches
  are bugs, not stylistic noise.
- `JSON.parse` returns `unknown`; widening to `any` via implicit cast is
  silently hiding a bug.

## Architectural quirks worth knowing

- Token-prefix detection (`gho_` vs `ghu_`) gates Copilot exchange path
  in `src/lib/token.ts`. New token-handling code that ignores prefix is
  almost always wrong.
- `state` (singleton in `src/lib/state.ts`) is mutable on purpose;
  tests should pass in deps rather than mutating it.
- Filesystem-touching code should accept paths as parameters; reading
  `process.env.COPILOT_API_HOME` at module load makes tests painful.

## What "thrashing" looks like in this repo

- Same eslint rule firing on three different files in a row → agent
  doesn't understand the rule, not three coincidental violations.
- tsc errors disappearing only because of `// @ts-expect-error` →
  symptom-patching.
- Repeated near-duplicate functions across `src/lib/` files →
  reimplementing existing helpers.
- `any` introductions paired with disappearing tsc errors → giving up
  on the type system.
