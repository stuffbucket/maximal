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
  services: { host: { openExternal, logger, appVersion }, storageRoot: path.join(appDir, "plugins") },
})
await gateway.importLegacyConfig("workiq", legacy)    // once, for a config.json `plugins.<id>.config`
await gateway.reconcile(config.plugins)               // start what is enabled
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
  Failures never affect other plugins. Unknown ids are ignored.
- **`updateConfig(id, config)`**: validate (plain JSON + `Config`; failure ⇒
  `invalid-config` with `issues: [{ path, message }]`, file untouched) →
  write → reload if enabled and changed. **`importLegacyConfig(id, config)`**:
  one-shot move of a pre-settings-file config (treated as settings version 1
  and migrated); writes only when the file has no `config`, resolves whether
  it wrote; not validated, so a bad legacy value shows as a `failed` plugin.
- **Tools**: `listTools` (MCP) returns the live tools of an `active` plugin
  minus blocked ones; `callTool` on a blocked tool resolves to `isError`
  "This tool is blocked in Maximal settings."; the call signal also aborts
  when the plugin stops; a throwing tool resolves to
  `{ isError: true, content: [{ type: "text", text: message }] }`.
  `toolViews` (Settings) adds `group`, `permission`, `permissionSource`.
- **Permissions**: `allow` | `block`; explicit (file) > plugin
  `defaultToolPermission` > `allow`. `setToolPermissions(id, { name: perm | null })`
  persists to `tools.permissions` (`null` clears), keeps choices for tools
  that are gone, never reloads the plugin, and emits `tools` + `settings`.
- **Catalog cache**: whenever a plugin's registered tool set becomes
  non-empty, its public definitions are stored in `tools.catalog` with
  `updatedAt`. `toolsSource` is `live` when the plugin is active with tools,
  else `cache` when a catalog exists, else `none`; `toolViews` follows it.
- **Snapshots** carry `kind`, the normalised `manifest`, `settingsVersion`,
  `configSchema`, `config` (validated, defaults applied; as stored when
  invalid; `undefined` when unreadable), `toolsSource`, `catalogUpdatedAt`.
- **Errors**: `PluginGatewayError` with `code` `unknown-plugin`,
  `plugin-inactive`, `unknown-tool`, `unknown-action`, `invalid-config`,
  `invalid-permissions`, or `settings-unreadable`.
- **Events**: `subscribe` delivers
  `{ type: "lifecycle" | "status" | "tools" | "settings", pluginId }`;
  listener exceptions are logged and contained.
- **Storage**: `<storageRoot>/<id>/` created 0700 on first write; files
  written to a temp file with mode 0600 and renamed into place.
- **Logging**: cordis-reported failures (apply, disposers), settings/config
  failures and failed catalog writes go to `services.host.logger`.
- **`dispose()`** stops every plugin and the root context and waits for
  pending settings writes; idempotent; later `reconcile` calls are no-ops.

Writing a plugin: see the SDK README.
