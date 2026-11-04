# @stuffbucket/maximal-plugin-sdk

The maximal plugin contract. Plugins are trusted, in-process ESM modules run
under [cordis](https://www.npmjs.com/package/@deepseek-ai/cordis)
(`@deepseek-ai/cordis@4.0.2`, the same runtime monimal uses). Import cordis
types through this package so every plugin shares the host's runtime identity
and sees the `Context` augmentation for the host services.

| Entry | For | Imports cordis? |
|---|---|---|
| `@stuffbucket/maximal-plugin-sdk` | plugin authors: `PluginModule`, `PluginMeta`, tool/status types, `Context`, `PluginContractError` | yes |
| `@stuffbucket/maximal-plugin-sdk/testing` | plugin tests: `loadPlugin`, `createTestbed`, `waitFor` | yes |
| `@stuffbucket/maximal-plugin-sdk/gateway` | the app core (`src/`): `PluginGateway`, `PluginSnapshot`, `PluginSettings`, `PluginGatewayError` | **no** (no runtime imports at all) |
| `@stuffbucket/maximal-plugin-sdk/runtime` | plugin hosts and `/testing` only; plugins must not import it | yes |

## Writing a plugin

A plugin package exports, from its entry module:

```ts
import { z } from "zod"
import type { Context, PluginMeta } from "@stuffbucket/maximal-plugin-sdk"

export const name = "example"                 // /^[a-z][a-z0-9-]{1,31}$/ — id, MCP server name, storage dir
export const meta: PluginMeta = { displayName: "Example", description: "What it does." }
export const inject = ["tools", "surface", "storage", "host"] as const   // only what you use
export const Config = z.object({ endpoint: z.url().default("https://example.test/mcp") }) // `{}` must be valid
export type Config = z.output<typeof Config>

export function apply(ctx: Context, config: Config): void {
  const lifecycle = new AbortController()
  ctx.effect(() => () => lifecycle.abort(), "example lifecycle")   // cancel background work on unload
  ctx.surface.setStatus({ state: "ready", code: "ready", summary: "Connected" })
  ctx.tools.register({
    name: "search",
    description: "Search things.",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    async execute(input, call) {
      return { content: [{ type: "text", text: `results for ${String(input.q)}` }] }
    },
  })
}
```

Package conventions: ESM, `sideEffects: false`, `@deepseek-ai/cordis` and
this SDK as exact `peerDependencies` (one runtime identity), config schema in
any Standard Schema library (maximal uses zod 4). `apply` should return
quickly; long-running work (sign-in, upstream connections) runs in the
background, tied to the fiber with `ctx.effect` and reported through
`ctx.surface.setStatus`.

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
- **`ctx.storage`** — private `<app dir>/plugins/<id>/` (0700): `readText`,
  `writeText` (atomic, 0600), `delete`, `dir`. Names are single path
  segments (`/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/`).
- **`ctx.host`** — `openExternal(url)` (http/https only), `logger`
  (prefixed with the plugin id), `appVersion`.

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
  await loaded.runAction("sign-out")
  expect(loaded.testbed.storage.files("example")).toEqual({})
} finally {
  await loaded.dispose()   // contributions vanish; call signals abort
}
```

`createTestbed()` loads several plugins into one context; `testbed.events`
records every `tools` / `status` change and `testbed.host.opened` / `.logs`
record host calls.
