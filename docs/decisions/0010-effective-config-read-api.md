---
id: ADR-0010
title: Unified effective-config read API
status: proposed
date: 2026-06-14
authors:
  - stuffbucket
supersedes: []
links:
  config: src/lib/config.ts
  config_schema: src/lib/config-schema.ts
  github_token_store: src/lib/github-token-store.ts
  secrets: src/lib/secrets.ts
  debug_cli: src/debug.ts
  diagnostics_route: src/routes/settings/route.ts
---

# Unified effective-config read API

## Context

Configuration values come from at least four sources:

1. `~/.local/share/copilot-api/config.json` (zod-loose-validated,
   `src/lib/config.ts` + `src/lib/config-schema.ts`)
2. `~/.local/share/copilot-api/accounts.json` (multi-account
   registry v2 with migration from a legacy single-record file —
   `src/lib/github-token-store.ts`)
3. `~/.local/share/copilot-api/secrets/<name>` (per-key files,
   mode 0600 — `src/lib/secrets.ts`)
4. Environment variables (env wins, file fills in unset)

Plus the `COPILOT_API_HOME` override that relocates all of the above.

There is **no single function** that returns the effective merged
view of "what would this proxy use right now, and where did each
value come from." Instead:

- `src/debug.ts` reconstructs it for the `maximal debug` command.
- `/settings/api/diagnostics` reconstructs it again for the UI.
- Individual route handlers reconstruct slices ("read the secret for
  this provider," "read the active account") inline.
- `GET /_debug/state` reads from `state` (in-memory cache) which may
  lag the disk.

Three concrete symptoms:

- Adding a new config field requires touching schema + defaults +
  diagnostics + debug + UI + tests independently and missing one
  is silent.
- "Why is this value `X`?" is hard to answer because the source
  isn't surfaced. The user has had to reason through env vs config
  vs secrets-file precedence by reading code.
- A bug in any reconstruction path (e.g. precedence differs between
  `debug` and the live proxy) is visible only on diff.

## Decision

Add `src/lib/effective-config.ts` exporting a single function:

```ts
export interface EffectiveValue<T> {
  value: T
  source: "env" | "config" | "secrets-file" | "accounts" | "default"
  /** Path / env name where the value came from; redacted for secrets. */
  origin: string
}

export interface EffectiveConfig {
  endpoint: { baseUrl: EffectiveValue<string>; port: EffectiveValue<number> }
  auth: {
    activeAccount: EffectiveValue<{ login: string; host: string } | null>
    knownAccounts: Array<{ key: string; login: string; host: string }>
  }
  providers: Record<string, { apiKey: EffectiveValue<string | null> }>
  features: {
    useMessagesApi: EffectiveValue<boolean>
    verbose: EffectiveValue<boolean>
    // …one entry per feature flag
  }
  apps: Record<AppId, { enabled: EffectiveValue<boolean> }>
  paths: { home: string; config: string; accounts: string; logs: string }
}

export async function getEffectiveConfig(): Promise<EffectiveConfig>
```

Rules:

1. **One precedence chain, declared in this file.** Env → secrets
   file → config.json → schema default. Documented at top.
2. **`value` is never `undefined`.** A field that isn't set anywhere
   carries the schema default with `source: "default"`.
3. **Secrets are never returned as cleartext.** The value field is
   a boolean/length/last-4 (decided per field); raw secrets stay in
   the in-memory `state` and the file system. `EffectiveConfig` is
   safe to log.
4. **All read paths consume this.** Replace:
   - `src/debug.ts` reconstructions
   - `/settings/api/diagnostics` reconstructions
   - `GET /_debug/state`'s config slice
   - Any inline `process.env.X ?? readConfig().y` reads in routes

## Alternatives considered

- **Layered Config object (Lo-fi DI).** Pass a single `Config` to
  every handler. Works but doesn't surface *source*; the "why is
  this value X" problem persists.
- **Reactive config (rxjs / signals).** Overkill; config changes
  infrequently and we'd publish the deltas via ADR-0007 events.
- **Status quo + lint rule forbidding direct `process.env` reads.**
  Half-measure; doesn't unify precedence.

## Consequences

- Adding a config field becomes a four-line change to
  `effective-config.ts` plus a schema entry. Diagnostics, debug,
  and UI pick it up automatically.
- `/settings/api/diagnostics` ships value + source to the UI, so
  the Diagnostics section can render "endpoint baseUrl: http://…
  *(from env COPILOT_ENDPOINT)*" instead of just the value.
- The "secret file vs env" precedence becomes testable in one place.
- The active account from `github-token-store.ts` joins the same
  surface as other config, so the shell's reboot-on-account-switch
  flow has one observable to subscribe to (ADR-0007).

## Migration

1. Implement `effective-config.ts` with the precedence chain
   documented in a comment header. Cover with tests that exercise
   each source path per field.
2. Re-point `src/debug.ts` at it. Snapshot the JSON output;
   confirm parity with the prior reconstruction.
3. Re-point `/settings/api/diagnostics` at it. Update
   `DiagnosticsResponse` (ADR-0005) to include the `source` per
   field.
4. Re-point `GET /_debug/state` at it for the config slice.
5. Audit remaining inline reads with `rg "process\.env\."`; either
   leave them (for env vars genuinely scoped to startup) or route
   them through the helper.

## Out of scope

- Mutation API for config. Writes already exist per concern
  (config.json writer, accounts registry mutators, secrets-file
  writer). They keep their narrow interfaces; this ADR is read-only.
- Config schema redesign. `config-schema.ts` stays as-is; this is
  a read aggregator on top of it.

## Open questions

- For secrets, what's the safest non-leaking representation?
  Recommendation: `{ present: boolean, length: number, last4?: string }`
  per provider. Never return the raw value. Document the contract.
- Should `EffectiveValue.origin` be a typed union (per source) or a
  free string? Typed union — surfaces invalid combinations at
  compile time.
