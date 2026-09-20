> **Status:** archived 2026-05 — work has shipped or been superseded.

# Phase 3 — macOS test parity via platform adapter

## 30-second context

Public-repo policy bans macOS GitHub-hosted runners, so platform-specific
code paths (`launchctl`, `defaults`, `/Applications/maximal.app`,
`~/Library/...`) currently aren't covered in CI. Refactor those seams behind
a `PlatformOps` interface, add golden-file tests for the rendered artifacts,
and recover most of the missing coverage without needing macOS hardware.

## Goals

1. All decision logic in `src/setup.ts`, `src/configure-claude-desktop.ts`,
   `src/uninstall.ts` becomes testable on Linux.
2. Snapshot tests for the three SSE translation flows (most fragile,
   highest-blast-radius code in the repo).
3. Golden-file tests for the rendered launchd plist, `defaults` invocation
   transcripts, `Info.plist`, and `claude_desktop_config.json` payloads.

## Non-goals

- A self-hosted macOS runner. Out of scope; revisit only if Phase 3 still
  leaves gaps that bite us.
- A full E2E test against a real Claude Desktop install. Manual checklist
  remains the gate for that.

## Design

### 3.1 `PlatformOps` interface

```ts
// src/lib/platform-ops.ts
export interface PlatformOps {
  // launchd / scheduled task / systemd
  installService(spec: ServiceSpec): Promise<void>
  uninstallService(label: string): Promise<void>
  serviceStatus(label: string): Promise<"running" | "stopped" | "absent">

  // macOS defaults / Windows registry
  readManagedPref(domain: string, key: string): Promise<unknown>
  writeManagedPref(domain: string, key: string, value: unknown): Promise<void>
  deleteManagedPref(domain: string, key: string): Promise<void>

  // FS shorthands with platform-correct paths
  binaryInstallPath(): string                // ~/.local/bin/maximal | %LocalAppData%\Programs\maximal\maximal.exe
  appBundlePath(): string | null             // /Applications/maximal.app or null
  configPath(name: string): string           // claude_desktop_config.json etc.
}
```

Implementations: `src/lib/platform-ops/{darwin,win32,linux,fake}.ts`. The
`fake` impl backs every method with an in-memory record of calls — golden
tests assert the expected sequence of operations.

### 3.2 Refactor call sites

`src/setup.ts`, `src/uninstall.ts`, `src/configure-claude-desktop.ts` accept
a `PlatformOps` parameter (default = `realPlatformOps()`). Every direct
`spawnSync('defaults', ...)` and `spawnSync('launchctl', ...)` moves into the
darwin impl. The existing `mock.module` patterns for these tests get deleted
in favor of passing a `fake` instance.

This also addresses the `mock.module` leakage problem from Phase 1 of the
research synthesis — fewer module mocks, more dependency injection.

### 3.3 Golden tests

For each rendered artifact, a fixture under `tests/fixtures/golden/`:

- `launchd-co.stuffbucket.maximal.plist`
- `claude-desktop-config.json` (apply + revert)
- `Info.plist` after `__VERSION__` substitution

Test loads input, runs the renderer, snapshot-compares to fixture. CI on
Linux exercises every code path that matters; humans review snapshot diffs
in PRs as documentation of intentional changes.

### 3.4 SSE translation snapshot tests

`responses-stream-translation.test.ts`,
`web-tools-stream.test.ts`,
`messages-handler.test.ts`:

Replace hand-asserted event-sequence checks with `toMatchInlineSnapshot()`
of the full SSE event array. ~1 day to convert; ongoing cost is reviewing
snapshot diffs in PRs (which is the same review you'd do for a hand-written
assertion change anyway).

## Acceptance

- Running `bun test` on Linux/macOS/Windows covers every code path in
  `setup.ts`, `uninstall.ts`, `configure-claude-desktop.ts`. Coverage report
  shows ≥90% line coverage for those files.
- A change to the launchd plist sentinel-replacement logic produces a
  reviewable golden-file diff in the PR.
- The three SSE translation tests have at least one `toMatchInlineSnapshot`
  block each.
- `mock.module` count in `tests/` drops by at least 50% (currently ~12, target
  ≤6).

## Estimate

2-3 days. Largest item: the platform-ops refactor of three command files.
Snapshot conversion is mechanical.

## Open questions

1. Does the refactor compose with Phase 4's loopback-OAuth changes (which
   also touch `setup.ts`)? Sequence: do Phase 3 first, OAuth on top of the
   adapter.
2. Linux platform-ops impl — do we ship one in this PRD or stub it out?
   Recommend stubbing (throws "linux not yet supported") since we don't
   distribute Linux installers; revisit when we do.
