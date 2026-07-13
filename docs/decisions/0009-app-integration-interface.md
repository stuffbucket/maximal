---
id: ADR-0009
title: Consolidate app integrations behind an AppIntegration interface
status: accepted
date: 2026-06-14
authors:
  - stuffbucket
supersedes: []
links:
  apps_route: src/routes/settings/apps.ts
  shell_feature: shell/src/features/apps/
related_files:
  src/configure-claude-code.ts: one-shot CLI configure
  src/configure-claude-desktop.ts: one-shot CLI configure
  src/lib/claude-code-reconcile.ts: reconciliation logic
  src/lib/claude-code-settings.ts: settings file read/write
  src/lib/claude-desktop-config.ts: config file read/write
  src/lib/claude-cli-detect.ts: detection + shim install
  src/lib/opencode.ts: opencode integration helpers
  shell/src/features/apps/AppCard.tsx: per-app UI
  shell/src/features/apps/useApps.ts: per-app data hook
---

# Consolidate app integrations behind an AppIntegration interface

## Context

Each supported third-party app (Claude Code, Claude Desktop,
Copilot CLI, future: opencode, Cursor, etc.) currently spans many
files with the same shape of logic re-implemented per app:

For **Claude Code** alone:

- `src/configure-claude-code.ts` — one-shot CLI subcommand
- `src/lib/claude-code-reconcile.ts` — desired-state reconciler
- `src/lib/claude-code-settings.ts` — settings file read/write
- `src/lib/claude-cli-detect.ts` — install detection + shim
- `src/routes/settings/apps.ts` — settings API for the shell
- `shell/src/features/apps/AppCard.tsx` — UI for one app
- `shell/src/features/apps/useApps.ts` — shared shell data hook

The `foreign-base-url` conflict shape is encoded twice (in the route
type and in the shell type — see ADR-0005), and the "what does this
app need from us" knowledge is scattered. Adding a fourth app means
touching ~5 layers and re-discovering the integration's invariants.

The user's explicit goal is to make terminal-tool configuration easy
for users who are new to the terminal — i.e. apps are the user-facing
surface where most onboarding effort lands. Today, that surface is
the most expensive thing to extend.

## Decision

Introduce an `AppIntegration` interface owned by `src/services/apps/`,
with one folder per supported app. The route handler and the shell UI
become app-agnostic, iterating over the registered integrations.

```ts
// src/services/apps/types.ts
export interface AppIntegration {
  id: AppId                                  // discriminator
  name: string                               // display name
  kind: AppKind

  detect(): Promise<AppInstall[]>            // installs found on disk
  installHint?(): AppInstallHint | null      // when not installed
  read(): Promise<AppConfigSnapshot>         // current on-disk config
  enable(state: AppState): Promise<EnableResult>
  disable(state: AppState): Promise<void>
  conflict(snapshot: AppConfigSnapshot): AppConflict | null
}

export interface EnableResult {
  ok: boolean
  conflict?: AppConflict
}
```

Layout:

```
src/services/apps/
  types.ts                    // the interface + shared shapes
  registry.ts                 // export const APPS: AppIntegration[]
  claude-code/
    index.ts                  // implements AppIntegration
    settings-file.ts          // file I/O, moved from src/lib/claude-code-settings.ts
    reconcile.ts              // moved from src/lib/claude-code-reconcile.ts
    detect.ts                 // moved from src/lib/claude-cli-detect.ts
  claude-desktop/
    index.ts
    config-file.ts            // moved from src/lib/claude-desktop-config.ts
  copilot-cli/
    index.ts
  opencode/                   // future
    index.ts
```

Then:

- `src/routes/settings/apps.ts` iterates `APPS` to build
  `AppsListResponse`. No `if (id === "claude-code")` branches.
- `src/configure-<app>.ts` becomes a thin CLI dispatcher that calls
  `APPS.find(a => a.id === id).enable(state)`.
- `shell/src/features/apps/AppCard.tsx` already iterates a list; it
  only renders shared fields. The app-specific copy (install hint
  text, conflict explanation) comes from the integration's
  serialized metadata in the response.

## Alternatives considered

- **Plugin discovery from disk** (drop a folder in, get an app).
  Overkill; integrations bind to typed file formats and need code
  review anyway. In-tree registry is right.
- **Class hierarchy** (`abstract class AppIntegration`). Marginal
  vs. plain interface + factory; prefer the interface to keep
  testing straightforward.
- **Leave as-is.** The integration-cost curve has been linear in
  app count so far; the user's stated direction is more apps.

## Consequences

- Adding an app becomes: create `src/services/apps/<id>/`,
  implement the interface, append to `registry.ts`, add tests.
  Zero changes to the route handler or the shell UI.
- The `foreign-base-url` conflict (and any future conflict kinds)
  are owned by a single integration's `conflict()` and reported via
  the shared `AppConflict` type from `src/lib/settings-types.ts`
  (per ADR-0005). The shell only knows the union of conflict kinds.
- Tests reorganize per-app: `tests/apps/<id>/*.test.ts` rather than
  scattered `claude-code-*.test.ts` files at the top level.

## Migration

Land per app, not in a big-bang. Suggested order:

1. Define `AppIntegration` and `registry.ts`. Empty registry.
2. Move Claude Code into `src/services/apps/claude-code/`; switch
   `routes/settings/apps.ts` to read from `registry.ts` for that
   app only; existing routes for other apps keep working.
3. Repeat for Claude Desktop.
4. Repeat for Copilot CLI.
5. Delete the now-empty top-level `configure-*.ts` (replace with
   a single `src/configure-app.ts` that dispatches by id).
6. Move tests to `tests/apps/<id>/`.

## Out of scope

- A user-installable plugin system.
- Per-app authentication; today they all consume the proxy's API key.
- Background reconciliation daemons; on-demand only.

## Open questions

- Does opencode belong here? It has its own `src/lib/opencode.ts`
  helpers but isn't a configurable "app" in the same sense (it
  reads env vars rather than a config file). Probably yes once we
  define `EnvVarAppIntegration` as a subtype that documents env
  vars to set rather than files to write.
- Should `AppIntegration.detect()` be cached? Detection involves
  disk I/O; the shell pings it often. Cache for 5s inside the
  integration; invalidate on `enable`/`disable`. Document in the
  interface.

## Status update — implemented (2026-06)

Shipped under `src/apps/` (not the proposed `src/services/apps/`). The
interface is named **`ClientApp`** (`src/apps/index.ts`), collected by a
registry (`src/apps/registry.ts`: `getAllApps()`, `getApp(id)`);
per-app code lives under
`src/apps/{claude-code,claude-desktop,copilot-cli}/`. The `related_files`
in this ADR's frontmatter are the pre-migration paths — kept as the
historical record of where the logic moved *from*.

The shipped contract refined the proposal:

- `detect()` returns `boolean` ("is it installed?"), not `AppInstall[]`;
  the install list moved into `getDetails()`.
- `read()` / `conflict()` / `installHint()` were folded into a single
  `getDetails(conflict?): Promise<AppEntry>`; conflict now rides on the
  `enable()` result.
- `enable()` / `disable()` dropped the `AppState` parameter and return a
  small status object.
- Added `isEnabled()`, optional `onBoot()` / `onShutdown()` lifecycle
  hooks, an optional `cli` hook (`AppCli`) for apps needing extra flags or
  bespoke handling, and a `apiKeyLabel` used by `maximal api <client>`. The
  registry-driven `maximal app` / `maximal api` commands live in
  `src/apps/cli.ts`; coming-soon placeholders come from
  `src/apps/coming-soon.ts` (`defineComingSoonApp`).
- Added **`uninstall()`** to the contract, so `maximal uninstall` reverts
  each app's own (ownership-guarded) config through the registry rather
  than hard-coding per-app revert calls.

The open question about opencode is unresolved — there is no opencode app
in the registry yet, and no `EnvVarAppIntegration` subtype was introduced.
