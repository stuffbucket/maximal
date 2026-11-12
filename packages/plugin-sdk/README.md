# @stuffbucket/maximal-plugin-sdk

The maximal plugin contract. Plugins are trusted, in-process ESM modules run
under [cordis](https://www.npmjs.com/package/@deepseek-ai/cordis)
(`@deepseek-ai/cordis@4.0.2`, the same runtime monimal uses). Import cordis
types through this package so every plugin shares the host's runtime identity
and sees the `Context` augmentation for the host services.

| Entry | For | Imports cordis? |
|---|---|---|
| `@stuffbucket/maximal-plugin-sdk` | plugin authors: `PluginModule`, `PluginManifest`, tool/status/permission types, `toolGroup`, `Context`, `PluginContractError` | yes |
| `@stuffbucket/maximal-plugin-sdk/testing` | plugin tests: `loadPlugin`, `createTestbed`, `waitFor` | yes |
| `@stuffbucket/maximal-plugin-sdk/gateway` | the app core (`src/`): `PluginGateway`, `PluginSnapshot`, `PluginToolView`, `PluginSettings`, `PluginGatewayError` | **no** (no runtime imports at all) |
| `@stuffbucket/maximal-plugin-sdk/runtime` | plugin hosts and `/testing` only; plugins must not import it | yes |

## Writing a plugin

A plugin package exports, from its entry module:

```ts
import { z } from "zod"
import type { Context, PluginManifest } from "@stuffbucket/maximal-plugin-sdk"

export const name = "example"                 // /^[a-z][a-z0-9-]{1,31}$/ — id, MCP server name, storage dir
export const Config = z.object({ endpoint: z.url().default("https://example.test/mcp") }) // `{}` must be valid
export type Config = z.output<typeof Config>
export const manifest = {
  id: "example",                              // must equal `name`
  kind: "connector",                          // or "extension" or "model"
  displayName: "Example",
  description: "What it does.",
  settingsVersion: 1,
  configSchema: z.toJSONSchema(Config) as PluginManifest["configSchema"],
  connector: {                                // required iff kind === "connector"
    transport: "streamable-http",
    endpoint: "https://example.test/mcp",
    auth: { type: "none" },                   // | { type: "entra", clientId, authority, scopes, redirectUri } | { type: "mcp-oauth", clientId?, scopes? }
    terms: { url: "https://example.test/terms" },
    limits: { maxConcurrency: 4 },            // optional rate-limiting numbers (connector kit: lanes, queue, retry); validated, kept
  },
} satisfies PluginManifest
export const inject = ["tools", "surface", "storage", "host"] as const   // only what you use
// If this plugin provides a Cordis service to other plugins:
// export const provides = ["example-catalog"] as const

export function apply(ctx: Context, config: Config): void {
  const lifecycle = new AbortController()
  ctx.effect(() => () => lifecycle.abort(), "example lifecycle")   // cancel background work on unload
  ctx.surface.setStatus({ state: "ready", code: "ready", summary: "Connected" })
  ctx.tools.register({
    name: "search",
    description: "Search things.",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    annotations: { readOnlyHint: true },
    async execute(input, call) {
      return { content: [{ type: "text", text: `results for ${String(input.q)}` }] }
    },
  })
}

// Optional:
export function migrateSettings(fromVersion: number, config: unknown): unknown { … }
export function defaultToolPermission(tool: ToolDefinitionPublic): ToolPermission | undefined { … }
```

Package conventions: ESM, `sideEffects: false`, `@deepseek-ai/cordis` and
this SDK as exact `peerDependencies` (one runtime identity), config schema in
any Standard Schema library (maximal uses zod 4). `apply` should return
quickly; long-running work (sign-in, upstream connections) runs in the
background, tied to the fiber with `ctx.effect` and reported through
`ctx.surface.setStatus`.

A plugin service is an explicit module contract: list its lower-case Cordis
name in `provides`, then register it with `ctx.provide(name, value)` inside
`apply`. `provides` is planning and validation metadata, not an automatic
registration. Consumers list the name in `inject`; the host rejects undeclared
names, while Cordis keeps a legal consumer fiber pending whenever its declared
provider is absent or inactive.

### Exclusive resources

A plugin is overlap-safe unless `apply` returns a `PluginResourceLifecycle`.
Use that return value for a process-independent singleton such as a listener:
declare `{ mode: "exclusive", resources: ["example-listener:4150"] }`, stage
without acquiring it in `prepare`, bind it in `commit`, stop it in `revoke`, and
recreate the old instance in `resume`. Hooks are serialized, bounded and must
honor their `PluginLifecycleContext.signal`. Handoff and recovery `commit` calls
resolve only after the resource is ready. Initial activation may deliberately
retain the logical reservation while exposing a recoverable error and retry
action (FigJam does this when its port is occupied). `revoke` resolves only after
the resource is physically gone. The host acquires the parent lease before
`commit` and retains it through an acknowledged
`revoke` or process reap. Generation replacement is ordered candidate
`prepare` → old `revoke` → candidate `commit`; failure before the durable point
revokes the candidate before resuming the old generation. Keep the handle until
`revoke` succeeds: an ambiguous failure stays fenced for retry instead of
making the singleton appear free.

### Manifest

`manifest` is static, plain JSON (no functions, dates, `NaN`, …); the host
validates it up front and keeps only the known fields, so it never carries
secrets — an `entra`/`mcp-oauth` `clientId` is a public identifier.
`homepage`, `connector.endpoint`, `auth.authority`, `auth.redirectUri` and
`terms.url` must be http(s) URLs; `connector.allowedHosts` (optional) is a
list of lower-case hosts (`host` or `host:port`) a config override of the
endpoint may name; `settingsVersion` is a positive integer.
`configSchema` (JSON Schema, `type: "object"`) drives the Settings form.

### Settings negotiation

The host owns `<app dir>/plugins/<id>/settings.json` (0600, atomic writes,
same directory as `ctx.storage`, which refuses the name `settings.json` in
any case):

```jsonc
{
  "$schema": "maximal-plugin-settings/1",   // host envelope version
  "plugin": "example",
  "version": 1,                              // settings version `config` is shaped for
  "config": { "endpoint": "https://…" },     // yours; absent ⇒ {}
  "tools": {                                 // host-owned
    "permissions": { "delete_item": "block" },             // explicit choices only
    "catalog": { "updatedAt": "<iso>", "tools": [ … ] }    // last non-empty tool set
  }
}
```

On start the host reads the file, checks the envelope, migrates, validates
`config` against `Config`, and writes the file back only when it migrated
and the result is valid. When the file's `version` is lower than
`manifest.settingsVersion` the host calls `migrateSettings(fromVersion,
config)` once (`config` is the raw stored value, possibly `undefined`; may
return a promise; must return plain JSON). Without that export the config is
carried over unchanged. A newer `version`, invalid JSON, a foreign envelope,
a throwing migration, or invalid config fails only this plugin (path-qualified
error such as `example.endpoint: Invalid URL`) and the file is left
untouched. Settings edits arrive through the host (`updateConfig`), which
validates, writes and reloads your fiber; you never write this file.

### Tool permissions

Each tool is `allow` (runs), `ask` (each call needs the person's approval)
or `block` (turned off). Effective permission: the user's explicit choice >
your `defaultToolPermission(tool)` > the host default: `allow` for read-only
tools, `ask` for the rest. Return `undefined` to defer; a throwing default is
ignored. Blocked tools stay in MCP `tools/list` with a description saying
they're turned off and where to turn them on; calls to them return `isError`
with the same words. Your tool handler only runs for an `ask` tool once the
host has the approval (`ToolCallContext.approved`). Permission changes never
reload the plugin. Settings groups
tools with `toolGroup(tool)`: `readOnlyHint` ⇒ `read-only`, else
`destructiveHint` ⇒ `write-delete`, else `other` — so annotate honestly.

## Services on `ctx`

Every registration is bound to the **calling** plugin's fiber: when the
plugin is disabled, reloaded, or fails, its tools, actions and status vanish
without explicit cleanup. Call services as methods (`ctx.tools.register(…)`),
never destructured.

- **`ctx.tools`** — `register(def)` → disposer; `registerAll(defs)` atomically
  replaces the plugin's whole tool set (use it to mirror an upstream tool
  list); `list()`. Names match `/^[a-zA-Z0-9_-]{1,64}$/` and are unique per
  plugin (tools are namespaced by plugin id). A duplicate or invalid
  definition throws `PluginContractError` and changes nothing. A tool that
  throws becomes an MCP `isError` result. `call.signal` aborts when the
  client cancels or the plugin stops; `call.progress` / `call.elicit` exist
  only when the client supports them.
- **`ctx.surface`** — `setStatus({ state, code, summary, detail?, facts?, actions? })`
  drives the Settings card; `registerAction(id, handler)` backs the buttons
  listed in `status.actions`. Report action failures through status.
  `notify({ code, message, params? })` raises a one-off message that the
  desktop app shows as a native notification (worded by `code` when the app
  knows it, else `message`): for changes worth interrupting for, not for
  status. Best effort; nothing shows it outside the desktop app. `code` is
  `a-z0-9-`, `message` non-empty English text. A status may also carry
  `attention: { summary, actions }` while the plugin needs the person now:
  the menu-bar tray lists each action (so they can be taken without opening
  Settings). Use stable action ids, and clear it when nothing is waiting.
- **`ctx.storage`** — private `<app dir>/plugins/<id>/` (0700): `readText`,
  `writeText` (atomic, 0600), `delete`, `dir`. Names are single path
  segments (`/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/`); `settings.json` is
  reserved for the host.
- **`ctx.host`** — `openExternal(url)` (http/https only), `logger`
  (prefixed with the plugin id), `appVersion`, `maximalPort()` (the port
  Maximal serves on, for handing to something else).
- **`ctx.serverTools`** (inject `serverTools`; provided by Maximal's composition
  root, not by every host) — `register({ name, description, input_schema,
  render, offer, clients?, execute(input, call) })` → disposer. A server tool is
  one the model calls and Maximal runs inside the `/v1/messages` loop. `name`
  matches `/^[a-z][a-z0-9_]{0,63}$/` and must be unique across plugins;
  `description` is part of the prompt-cache prefix, so keep it fixed. `render:
  "hidden"` keeps the call and its result from the client; `offer: "always"`
  offers it on every agent turn of the `clients` (default `["claude-code"]`).
  `call` has `signal`, `sessionId?`, `model`, `client`, `budget?` (the
  `{ plugin, tool }` scope the host checks the budget limits under before
  `execute` runs; a refusal is the tool's result and `execute` never runs) and
  `nextProviderCall(operation, upstreamModel)` and `reportSpend?(spend)`. A
  billed tool declares `estimate?(input)` → `{ operation, provider?, body }`
  (the model operation the call would make and the body to price it from; the
  app core holds that operation's estimate, so the tool carries no price list).
  Before each upstream request it calls `nextProviderCall`, passes the returned
  `{ invocationId, providerCallId, sequence, operation, model }` to
  `provider.postJson`, then reports that same identity with the provider,
  served model and operation result through `reportSpend`. `invocationId`
  identifies the admitted tool execution; each provider request has a distinct
  `providerCallId` and increasing sequence, so several calls settle separately
  without double-counting. `callBoundModel` implements this handshake for the
  built-in capability plugins. A free tool does neither.
  Server tools are not MCP tools and have no tool permissions.
  `decision-tools.ts` has the shared pieces of a capability plugin that offers
  its model this way: `serverToolWhileAvailable` (register only while a binding's
  provider is signed in and offers the model), `callBoundModel`, `textResult`,
  `errorResult`.

## Testing a plugin

Run it under a real cordis `Context` with the host's own `tools`/`surface`
implementation, in-memory storage and a recording host — no `mock.module`:

```ts
import { loadPlugin, waitFor } from "@stuffbucket/maximal-plugin-sdk/testing"
import * as plugin from "../src/index"

const loaded = await loadPlugin(plugin, { endpoint: upstream.url }, {
  openExternal: async (url) => { /* drive the loopback redirect */ },
  storage: { example: { "terms.json": "{\"accepted\":true}" } },
})
try {
  await waitFor(() => loaded.status()?.state === "ready")
  expect(loaded.tools().map((t) => t.name)).toEqual(["search"])
  expect(await loaded.callTool("search", { q: "x" })).toMatchObject({ content: [{ type: "text" }] })
  expect((await loaded.toolViews()).map((v) => v.permission)).toEqual(["allow"])
  await loaded.runAction("sign-out")
  expect(loaded.testbed.storage.files("example")).toEqual({})
} finally {
  await loaded.dispose()   // contributions vanish; call signals abort
}
```

With an explicit config, `load` validates and uses it. Without one, it
negotiates settings like the host: seed a file with
`testbed.writeSettings(plugin, { version: 1, config, permissions })`, load,
then inspect the migrated result with `testbed.readSettings(id)`. Pass
`{ storageDir: tempDir }` to back storage with real files (same backend,
modes and layout as the host). `loaded.toolViews(permissions?)` resolves
groups and effective permissions (file, or the given map > your
`defaultToolPermission` > the host default); the testbed's `callTool` does not enforce
permissions — the host does.

`createTestbed()` loads several plugins into one context; `testbed.events`
records every `tools` / `status` change and `testbed.host.opened` / `.logs`
record host calls.

## Testing plugins (lifecycle harness and conformance suite)

`@stuffbucket/maximal-plugin-host/testing` runs plugins under the real host
(`createPluginHost`, real settings files in a temp dir) and records what
crosses the plugin boundary. Every plugin package runs the conformance suite:

```ts
import { runPluginConformance } from "@stuffbucket/maximal-plugin-host/testing"
import * as plugin from "../src/index"

runPluginConformance(plugin, {
  changedConfig: { greeting: "hello" },   // a second valid config (reload check)
  // storage: { "terms.json": "…" },       // files seeded before start
  // settled: (h, id) => h.snapshot(id).status?.code === "ready",
  // expectTools: true,
  // leakProbes: [() => (fake.sessionCount === 0 ? [] : ["session open"])],
  // migration: { fromVersion: 1, config: { old: 1 }, expected: { new: 1 } },
})
```

Pass a factory (`() => createMyPlugin({ endpoint: fake.url })`) when the
module needs fakes started in `beforeAll`. The checks: the manifest is valid
plain JSON and `manifest.id === name`; `Config` accepts `{}`;
`manifest.configSchema` matches `Config` (field names and defaults, and the
schema's own JSON Schema when it emits one); `apply` returns within
`applyBudgetMs` (250 ms) and the plugin becomes `active`; a changed config
reloads it (fiber #1 disposed, #2 active) and re-saving the same one does not;
disable and shutdown withdraw every tool, action and status, dispose every
fiber, restore the host's root effects, and leave no intervals, timeouts of
1 s or more, or listening servers created meanwhile (plus your
`leakProbes`); an older settings version (or a legacy `config.json` value) is
migrated; an unreadable or newer settings file fails only this plugin and is
never overwritten; `settings.json` is only ever written by the host.

For your own lifecycle tests, `createLifecycleHarness({ plugins, secrets? })`
gives the gateway, stepping (`enable`, `disable`, `setConfig`,
`setPermissions`, `runAction`, `importLegacyConfig`, `seedSettings`),
cordis-style settling (`flush()` — host queues, settings I/O and each
plugin's `fiber.await()` — plus `waitFor`, `waitForStatus`, `waitForEntry`),
inspection (`snapshot`, `contributions`, `fibers`, `effects`, `rootEffects`,
`settings`, `files`, `opened`, `settingsTamperedWith`) and an ordered
transcript: `fiber` transitions (cordis `internal/status`), gateway `event`s,
`lifecycle`, `status`, `tools` (registered / withdrawn), `visible-tools`
(permission changes), `settings` (settings.json writes as path diffs, catalog
tools by name), `storage` (write / delete, names only), `open-external` and
`log`. `transcript({ since, kinds })` is normalised (`Normalizer`: ports,
random UUIDs, ISO times, durations, `secrets` → `<secret>`); `formatEntry`
renders one line per entry for snapshots; `secretsSeen()` scans the raw
transcript. `trackHandles()` is the leak tracker on its own
(`process.getActiveResourcesInfo()` is always empty in Bun).
