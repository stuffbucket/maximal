# @stuffbucket/maximal-plugin-host

The cordis-backed implementation of `PluginGateway`
(`@stuffbucket/maximal-plugin-sdk/gateway`). Only the composition root
(`src/lib/plugins/compose.ts`) imports this package; the rest of the app sees
the cordis-free gateway seam. Plugins are trusted in-process code: cordis
scopes their resources but does not sandbox them.

```ts
import { createPluginHost } from "@stuffbucket/maximal-plugin-host"
import * as workiq from "@stuffbucket/maximal-plugin-workiq"

const gateway = createPluginHost({
  plugins: [workiq],                                   // static first-party set
  services: { host: { openExternal, logger, appVersion, maximalPort }, storageRoot: path.join(appDir, "plugins") },
})
await gateway.importLegacyConfig("workiq", legacy)    // once, for a config.json `plugins.<id>.config`
await gateway.reconcile(config.plugins)               // start what is enabled
await gateway.addPlugin(externalModule, { type: "external", specifier: externalUrl })
await gateway.replacePlugin("external-id", nextModule, { type: "external", specifier: externalUrl })
await gateway.removePlugin("external-id")
// … on settings change: await gateway.reconcile(next.plugins)
// … on shutdown:        await gateway.dispose()
```

## Behaviour

- **Construction** validates every module (shape, `manifest` — id equals
  `name`, kind, connector section iff `kind: "connector"`, plain JSON —
  duplicate ids, `inject` ⊆ `tools`/`surface`/`storage`/`host`, optional
  `migrateSettings`/`defaultToolPermission` are functions) and throws
  `PluginContractError` on a bad list. Everything starts `disabled`; every
  plugin's settings file is read in the background straight away (queued
  ahead of the first `reconcile`).
- **Settings file** `<storageRoot>/<id>/settings.json` (format in the SDK
  README): host-owned, 0600, atomic temp+rename. Every `reconcile` re-reads
  it: envelope check → `migrateSettings` when the stored `version` is older →
  validate `config ?? {}` → write back only if migrated and valid. A file that
  cannot be read, is not JSON, has a foreign/newer envelope or version, or
  whose migration throws fails that plugin with a clear error and is never
  overwritten (every write rejects with `settings-unreadable`). Host writes
  are read-modify-write, so edits made on disk survive them.
- **`reconcile(settings)`** is serialised and takes only
  `{ enabled, clients }` per plugin. `enabled !== true` ⇒ stop (fiber
  disposed; tools, actions, status vanish). Enabled ⇒ invalid settings or
  config ⇒ `failed` with a path-qualified `error`
  (`workiq.endpoint: Invalid URL`); otherwise `starting` → `ctx.plugin()` →
  `active`, or `failed` if `apply` throws (partial contributions withdrawn).
  A changed stored config (key-sorted JSON) reloads the plugin; an unchanged
  one is left alone, even when `failed` — toggle `enabled` to retry.
  A legal Cordis `PENDING` fiber remains mounted as gateway lifecycle
  `waiting`, with `waitingForServices`/`waitingReason`; Cordis activates,
  unloads and reactivates it as declared providers appear or disappear.
  Failures never affect other plugins. Unknown ids are ignored.
- **`updateConfig(id, config)`**: validate (plain JSON + `Config`; failure ⇒
  `invalid-config` with `issues: [{ path, message }]`, file untouched) →
  write → reload if enabled and changed. **`importLegacyConfig(id, config)`**:
  one-shot move of a pre-settings-file config (treated as settings version 1
  and migrated); writes only when the file has no `config`, resolves whether
  it wrote; not validated, so a bad legacy value shows as a `failed` plugin.
- **Tools**: `listTools` (MCP) returns the live tools of an `active` plugin,
  each with its effective `permission` (blocked ones included); `callTool` on
  a blocked tool, or on an `ask` tool without `call.approved`, resolves to
  `isError` saying where to change it in Settings; the call signal also aborts
  when the plugin stops; a throwing tool resolves to
  `{ isError: true, content: [{ type: "text", text: message }] }`.
  `toolViews` (Settings) adds `group`, `permission`, `permissionSource`.
- **Permissions**: `allow` | `ask` | `block`; explicit (file) > plugin
  `defaultToolPermission` > `allow` for read-only tools, else `ask`. `setToolPermissions(id, { name: perm | null })`
  persists to `tools.permissions` (`null` clears), keeps choices for tools
  that are gone, never reloads the plugin, and emits `tools` + `settings`.
- **Catalog cache**: whenever a plugin's registered tool set becomes
  non-empty, its public definitions are stored in `tools.catalog` with
  `updatedAt`. `toolsSource` is `live` when the plugin is active with tools,
  else `cache` when a catalog exists, else `none`; `toolViews` follows it.
- **Exclusive resources**: `apply` may return a `PluginResourceLifecycle` with
  an explicit singleton declaration. Candidate mode runs `prepare` but never
  binds; active mode acquires the shared parent lease before `commit`. Delayed
  Cordis activation runs the same lifecycle per dependency epoch and its Cordis
  disposer revokes that epoch before a later reactivation. A lease is released
  only after `revoke` resolves, so an ambiguously bound resource or failed stop
  keeps the lifecycle hooks, physical handle and lease quarantined for retry.
  Generation handoff is candidate `prepare` → old `revoke` → candidate `commit`;
  rollback revokes the candidate before `resume` recreates the old instance.
- **Mutable inventory**: constructor modules remain static built-ins by default.
  The host-private `PluginHostGateway` adds explicit `addPlugin`, `removePlugin`
  and `replacePlugin` operations. Added entries follow the last reconciled
  enable state; removal retains host-owned settings. A→B replacement validates
  B before touching A, then stops/revokes A before starting B. A failed or
  waiting B is normally stopped/revoked before the exact settings file and A
  are restored. If B cannot be physically revoked, A's inventory record is
  restored but remains inactive while B and its lease stay quarantined; a later
  reconcile retries B's cleanup before restarting A. In either case
  `replacement-not-ready` reports startup, cleanup and rollback failures.
  Settings mutations share the inventory queue, so a successful concurrent
  write runs wholly before replacement or after rollback.
- **Snapshots** carry `source` (`built-in` or an external `specifier`), `kind`,
  the normalised `manifest`, `settingsVersion`, `configSchema`, `config`
  (validated, defaults applied; as stored when invalid; `undefined` when
  unreadable), `toolsSource`, `catalogUpdatedAt`, and pending diagnostics.
- **Errors**: `PluginGatewayError` with `code` `unknown-plugin`,
  `plugin-inactive`, `unknown-tool`, `unknown-action`, `invalid-config`,
  `invalid-permissions`, `settings-unreadable`, or `replacement-not-ready`.
- **Events**: `subscribe` delivers
  `{ type: "lifecycle" | "status" | "tools" | "settings" | "notice" | "inventory", pluginId }`;
  listener exceptions are logged and contained.
- **Storage**: `<storageRoot>/<id>/` created 0700 on first write; files
  written to a temp file with mode 0600 and renamed into place.
- **Cordis adapter**: dependency scheduling stays entirely in Cordis 4.0.2.
  The host uses its documented `internal/status` event plus public `Fiber.state`,
  `Fiber.inject` and `Context.get(name, true)` to project lifecycle and missing
  services; it has no parallel dependency graph or scheduler.
- **Logging**: cordis-reported failures (apply, disposers), settings/config
  failures and failed catalog writes go to `services.host.logger`.
- **`dispose()`** stops every plugin and the root context and waits for
  pending settings writes; idempotent; later `reconcile` calls are no-ops.

## Testing (`./testing`)

`@stuffbucket/maximal-plugin-host/testing` builds a real host around the
plugins under test and records everything that crosses the plugin boundary
(`createLifecycleHarness`), and registers the generic contract checks every
plugin package runs (`runPluginConformance`, bun:test). It observes the
host's root cordis context, runtime and fibers through a module-private hook
(`pluginHostInternals`, not exported from the package root). Usage: SDK
README → *Testing plugins*.

Writing a plugin: see the SDK README.
