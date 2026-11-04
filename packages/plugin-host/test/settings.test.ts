import type {
  Context,
  PluginManifest,
  PluginModule,
  ToolDefinition,
} from "@stuffbucket/maximal-plugin-sdk"
import type { PluginGatewayError } from "@stuffbucket/maximal-plugin-sdk/gateway"

import { toolGroup } from "@stuffbucket/maximal-plugin-sdk"
import { waitFor } from "@stuffbucket/maximal-plugin-sdk/testing"
import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { z } from "zod"

import {
  buildHost,
  createHost,
  define,
  Empty,
  envelope,
  expectGatewayError,
  fakeHost,
  runCleanups,
  seedSettings,
  tempDir,
  tool,
} from "./helpers"
import { rejection } from "./rejection"

afterEach(runCleanups)

const Config = z.object({
  endpoint: z.url().default("https://up.test/mcp"),
  retries: z.number().int().default(3),
  online: z.boolean().default(true),
})
type Config = z.output<typeof Config>

const DEFAULTS: Config = {
  endpoint: "https://up.test/mcp",
  retries: 3,
  online: true,
}

const manifest = {
  id: "remote",
  kind: "connector",
  displayName: "Remote",
  description: "A remote MCP server.",
  settingsVersion: 1,
  configSchema: { type: "object", properties: {} },
  connector: {
    transport: "streamable-http",
    endpoint: "https://up.test/mcp",
    auth: { type: "none" },
    terms: { url: "https://up.test/terms" },
  },
} satisfies PluginManifest

/** A connector that records each activation's config. */
function connector(
  overrides: Partial<PluginModule<Config>> = {},
  apply: (ctx: Context, config: Config) => void = (ctx, config) => {
    if (config.online) ctx.tools.registerAll([tool("search")])
  },
) {
  const applied: Array<Config> = []
  const module: PluginModule<Config> = {
    name: "remote",
    manifest,
    inject: ["tools", "surface", "storage", "host"],
    Config,
    apply(ctx, config) {
      applied.push(config)
      apply(ctx, config)
    },
    ...overrides,
  }
  return { module, applied }
}

/** settingsVersion 2 renamed the v1 `host` key to `endpoint`. */
function versioned() {
  const migrations: Array<[number, unknown]> = []
  const { module, applied } = connector({
    manifest: { ...manifest, settingsVersion: 2 },
    migrateSettings(from, config) {
      migrations.push([from, config])
      const { host, ...rest } = (config ?? {}) as Record<string, unknown>
      return host === undefined ? rest : { ...rest, endpoint: host }
    },
  })
  return { module, applied, migrations }
}

function settingsPath(root: string, id = "remote"): string {
  return path.join(root, id, "settings.json")
}

function readSettings(root: string, id = "remote"): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath(root, id), "utf8")) as Record<
    string,
    unknown
  >
}

const call = () => ({ signal: new AbortController().signal })

describe("manifest validation", () => {
  test("rejects missing/mismatched manifests and bad optional exports", () => {
    const ok = define("alpha", Empty, () => {})
    expect(buildHost([{ ...ok, manifest: undefined }])).toThrow(
      /manifest: must be an object/,
    )
    expect(
      buildHost([{ ...ok, manifest: { ...ok.manifest, id: "beta" } }]),
    ).toThrow(/must equal the module name/)
    expect(
      buildHost([{ ...ok, manifest: { ...ok.manifest, kind: "connector" } }]),
    ).toThrow(/requires a connector section/)
    expect(
      buildHost([
        { ...ok, manifest: { ...ok.manifest, homepage: Symbol("x") } },
      ]),
    ).toThrow(/JSON-serialisable/)
    expect(buildHost([{ ...ok, migrateSettings: "nope" }])).toThrow(
      /migrateSettings must be a function/,
    )
  })

  test("snapshots expose kind, manifest (no extra keys) and settings metadata", async () => {
    const { module } = connector()
    const { gateway } = createHost([
      { ...module, manifest: { ...manifest, clientSecret: "x" } as never },
    ])
    await gateway.reconcile(undefined)
    expect(gateway.get("remote")).toMatchObject({
      kind: "connector",
      manifest,
      settingsVersion: 1,
      configSchema: { type: "object", properties: {} },
      config: DEFAULTS,
      toolsSource: "none",
    })
    expect(JSON.stringify(gateway.get("remote"))).not.toContain("clientSecret")
  })
})

describe("settings file", () => {
  test("updateConfig validates, writes the envelope (0600) and reloads", async () => {
    const { module, applied } = connector()
    const { gateway, events, storageRoot } = createHost([module])
    await gateway.reconcile({ remote: { enabled: true } })
    expect(applied).toEqual([DEFAULTS])

    events.length = 0
    await gateway.updateConfig("remote", {
      endpoint: "https://other.test/mcp",
    })
    expect(applied.at(-1)).toEqual({
      ...DEFAULTS,
      endpoint: "https://other.test/mcp",
    })
    expect(gateway.get("remote")?.config).toEqual(applied.at(-1))
    expect(events).toContainEqual({ type: "settings", pluginId: "remote" })
    expect(events).toContainEqual({ type: "lifecycle", pluginId: "remote" })
    await waitFor(() => gateway.get("remote")?.catalogUpdatedAt !== undefined)
    expect(readSettings(storageRoot)).toMatchObject({
      $schema: "maximal-plugin-settings/1",
      plugin: "remote",
      version: 1,
      config: { endpoint: "https://other.test/mcp" },
    })
    if (process.platform !== "win32") {
      expect(statSync(settingsPath(storageRoot)).mode & 0o777).toBe(0o600)
      expect(statSync(path.join(storageRoot, "remote")).mode & 0o777).toBe(
        0o700,
      )
    }

    // Equal config: written, but no reload.
    await gateway.updateConfig("remote", {
      endpoint: "https://other.test/mcp",
    })
    expect(applied).toHaveLength(2)
  })

  test("updateConfig rejects invalid config with issues and leaves everything as is", async () => {
    const { module, applied } = connector()
    const root = tempDir()
    const file = seedSettings(
      root,
      "remote",
      envelope("remote", { retries: 5 }),
    )
    const { gateway } = createHost([module], fakeHost(), root)
    await gateway.reconcile({ remote: { enabled: true } })
    const before = readFileSync(file, "utf8")

    const error = (await rejection(
      gateway.updateConfig("remote", { endpoint: "nope", retries: 1.5 }),
    )) as PluginGatewayError
    expect(error.code).toBe("invalid-config")
    expect(error.issues?.map((issue) => issue.path)).toEqual([
      "endpoint",
      "retries",
    ])
    expect(error.message).toMatch(/^remote\.endpoint: /m)

    const nonJson = (await rejection(
      gateway.updateConfig("remote", { endpoint: new Date() }),
    )) as PluginGatewayError
    expect(nonJson.code).toBe("invalid-config")
    expect(nonJson.issues).toEqual([
      { path: "endpoint", message: "not a JSON value" },
    ])

    expect(readFileSync(file, "utf8")).toBe(before)
    expect(applied).toEqual([{ ...DEFAULTS, retries: 5 }])
    expect(gateway.get("remote")?.lifecycle).toBe("active")
    await expectGatewayError(
      gateway.updateConfig("ghost", {}),
      "unknown-plugin",
    )
  })

  test("updateConfig on a disabled plugin only writes; enabling uses it", async () => {
    const { module, applied } = connector()
    const { gateway, storageRoot } = createHost([module])
    await gateway.updateConfig("remote", { retries: 7 })
    expect(applied).toEqual([])
    expect(gateway.get("remote")).toMatchObject({
      lifecycle: "disabled",
      config: { ...DEFAULTS, retries: 7 },
    })
    expect(readSettings(storageRoot).config).toEqual({ retries: 7 })
    await gateway.reconcile({ remote: { enabled: true } })
    expect(applied).toEqual([{ ...DEFAULTS, retries: 7 }])
  })

  test("a file edited on disk survives host writes and is applied by the next reconcile", async () => {
    const { module, applied } = connector()
    const root = tempDir()
    const { gateway, events } = createHost([module], fakeHost(), root)
    await gateway.reconcile({ remote: { enabled: true } })
    await waitFor(() => gateway.get("remote")?.catalogUpdatedAt !== undefined)

    seedSettings(root, "remote", envelope("remote", { retries: 9 }))
    events.length = 0
    await gateway.reconcile({ remote: { enabled: true } })
    expect(applied.at(-1)).toEqual({ ...DEFAULTS, retries: 9 })
    expect(gateway.get("remote")?.config).toEqual({ ...DEFAULTS, retries: 9 })
    await waitFor(() => readSettings(root).tools !== undefined)

    // Host writes are read-modify-write: an edit made on disk survives them.
    seedSettings(root, "remote", envelope("remote", { retries: 4 }))
    await gateway.setToolPermissions("remote", { search: "block" })
    expect(readSettings(root)).toEqual({
      ...envelope("remote", { retries: 4 }),
      tools: { permissions: { search: "block" } },
    })
    expect(gateway.get("remote")?.config).toEqual({ ...DEFAULTS, retries: 4 })
    await gateway.reconcile({ remote: { enabled: true } })
    expect(applied.at(-1)).toEqual({ ...DEFAULTS, retries: 4 })
    expect(events).toContainEqual({ type: "settings", pluginId: "remote" })
  })
})

describe("settings migration", () => {
  test("migrates an older file once, writes it back, and keeps host sections and unknown keys", async () => {
    const { module, applied, migrations } = versioned()
    const root = tempDir()
    seedSettings(root, "remote", {
      ...envelope("remote", { host: "https://legacy.test/mcp" }),
      tools: { permissions: { search: "block" } },
      future: 1,
    })
    const { gateway } = createHost([module], fakeHost(), root)
    await gateway.reconcile({ remote: { enabled: true } })
    expect(migrations).toEqual([[1, { host: "https://legacy.test/mcp" }]])
    expect(applied).toEqual([
      { ...DEFAULTS, endpoint: "https://legacy.test/mcp" },
    ])
    expect(readSettings(root)).toMatchObject({
      version: 2,
      config: { endpoint: "https://legacy.test/mcp" },
      tools: { permissions: { search: "block" } },
      future: 1,
    })
    await gateway.reconcile({ remote: { enabled: true } })
    expect(migrations).toHaveLength(1)
    expect(applied).toHaveLength(1)
  })

  test("a migration that yields invalid config fails the plugin and leaves the file untouched", async () => {
    const { module } = versioned()
    const root = tempDir()
    const file = seedSettings(
      root,
      "remote",
      envelope("remote", { host: "not a url" }),
    )
    const before = readFileSync(file, "utf8")
    const { gateway } = createHost([module], fakeHost(), root)
    await gateway.reconcile({ remote: { enabled: true } })
    expect(gateway.get("remote")).toMatchObject({ lifecycle: "failed" })
    expect(gateway.get("remote")?.error).toMatch(/^remote\.endpoint: /)
    expect(readFileSync(file, "utf8")).toBe(before)
  })

  test("a file from a newer plugin version fails the plugin and is left untouched", async () => {
    const { module } = connector()
    const root = tempDir()
    const file = seedSettings(root, "remote", envelope("remote", {}, 4))
    const before = readFileSync(file, "utf8")
    const { gateway } = createHost([module], fakeHost(), root)
    await gateway.reconcile({ remote: { enabled: true } })
    expect(gateway.get("remote")?.error).toMatch(/version 4, newer/)
    expect(readFileSync(file, "utf8")).toBe(before)
  })
})

describe("unreadable settings", () => {
  test("isolate the plugin, refuse every write, and recover once fixed", async () => {
    const { module } = connector()
    const beta = define(
      "beta",
      Empty,
      (ctx) => void ctx.tools.register(tool("b")),
    )
    const root = tempDir()
    const file = seedSettings(root, "remote", "{ not json")
    const { gateway } = createHost([module, beta], fakeHost(), root)
    await gateway.reconcile({
      remote: { enabled: true },
      beta: { enabled: true },
    })
    expect(gateway.get("remote")?.lifecycle).toBe("failed")
    expect(gateway.get("remote")?.error).toMatch(
      /settings\.json is not valid JSON.*will not overwrite/,
    )
    expect(gateway.get("remote")?.config).toBeUndefined()
    expect(gateway.get("beta")?.lifecycle).toBe("active")

    await expectGatewayError(
      gateway.setToolPermissions("remote", { search: "block" }),
      "settings-unreadable",
    )
    await expectGatewayError(
      gateway.updateConfig("remote", {}),
      "settings-unreadable",
    )
    await expectGatewayError(
      gateway.importLegacyConfig("remote", { retries: 1 }),
      "settings-unreadable",
    )
    expect(readFileSync(file, "utf8")).toBe("{ not json")

    seedSettings(root, "remote", envelope("remote"))
    await gateway.reconcile({
      remote: { enabled: true },
      beta: { enabled: true },
    })
    expect(gateway.get("remote")?.lifecycle).toBe("active")
  })
})

function permissioned() {
  let ctxRef: Context | undefined
  const result = connector(
    {
      defaultToolPermission: (definition) =>
        toolGroup(definition) === "write-delete" ? "block" : undefined,
    },
    (ctx) => {
      ctxRef = ctx
      ctx.tools.registerAll([
        { ...tool("read"), annotations: { readOnlyHint: true } },
        { ...tool("del"), annotations: { destructiveHint: true } },
        { ...tool("misc"), annotations: {} },
      ])
    },
  )
  return { ...result, ctx: () => ctxRef as Context }
}

describe("tool permissions", () => {
  test("resolution, enforcement, events, persistence, and no reload", async () => {
    const { module, applied } = permissioned()
    const { gateway, events, storageRoot } = createHost([module])
    await gateway.reconcile({ remote: { enabled: true } })

    const views = () =>
      gateway
        .toolViews("remote")
        .map(
          (v) => `${v.name}:${v.group}:${v.permission}:${v.permissionSource}`,
        )
    expect(views()).toEqual([
      "read:read-only:allow:default",
      "del:write-delete:block:plugin",
      "misc:other:allow:default",
    ])
    expect(gateway.listTools("remote").map((t) => t.name)).toEqual([
      "read",
      "misc",
    ])
    expect(await gateway.callTool("remote", "del", {}, call())).toEqual({
      isError: true,
      content: [
        { type: "text", text: "This tool is blocked in Maximal settings." },
      ],
    })

    events.length = 0
    await gateway.setToolPermissions("remote", { del: "allow", read: "block" })
    expect(events).toEqual([
      { type: "tools", pluginId: "remote" },
      { type: "settings", pluginId: "remote" },
    ])
    expect(applied).toHaveLength(1)
    expect(gateway.listTools("remote").map((t) => t.name)).toEqual([
      "del",
      "misc",
    ])
    expect((await gateway.callTool("remote", "del", {}, call())).isError).toBe(
      undefined,
    )
    expect((await gateway.callTool("remote", "read", {}, call())).isError).toBe(
      true,
    )
    expect(
      (readSettings(storageRoot).tools as Record<string, unknown>).permissions,
    ).toEqual({ del: "allow", read: "block" })

    events.length = 0
    await gateway.setToolPermissions("remote", { del: "allow" })
    expect(events).toEqual([])

    await gateway.setToolPermissions("remote", { del: null })
    expect(views()[1]).toBe("del:write-delete:block:plugin")
    await expectGatewayError(
      gateway.callTool("remote", "nope", {}, call()),
      "unknown-tool",
    )
  })

  test("choices survive a tool disappearing and re-apply when it returns", async () => {
    const { module, ctx } = permissioned()
    const { gateway } = createHost([module])
    await gateway.reconcile({ remote: { enabled: true } })
    await gateway.setToolPermissions("remote", { read: "block" })
    ctx().tools.registerAll([tool("misc")])
    expect(gateway.toolViews("remote").map((v) => v.name)).toEqual(["misc"])
    ctx().tools.registerAll([tool("read"), tool("misc")])
    expect(gateway.listTools("remote").map((t) => t.name)).toEqual(["misc"])
    expect(gateway.toolViews("remote")[0]).toMatchObject({
      name: "read",
      permission: "block",
      permissionSource: "user",
    })
  })

  test("invalid changes are rejected; permissions can be set while disabled", async () => {
    const { module, applied } = permissioned()
    const { gateway, storageRoot } = createHost([module])
    await expectGatewayError(
      gateway.setToolPermissions("remote", { read: "ask" as never }),
      "invalid-permissions",
    )
    await expectGatewayError(
      gateway.setToolPermissions("remote", { "bad name": "allow" }),
      "invalid-permissions",
    )
    await expectGatewayError(
      gateway.setToolPermissions("ghost", {}),
      "unknown-plugin",
    )
    await gateway.setToolPermissions("remote", { read: "block" })
    expect(applied).toEqual([])
    expect(readSettings(storageRoot)).toEqual({
      $schema: "maximal-plugin-settings/1",
      plugin: "remote",
      version: 1,
      tools: { permissions: { read: "block" } },
    })
  })
})

describe("tool catalog cache", () => {
  test("live while active, cached otherwise, persisted across hosts", async () => {
    const { module } = connector()
    const root = tempDir()
    const first = createHost([module], fakeHost(), root)
    await first.gateway.reconcile(undefined)
    expect(first.gateway.get("remote")?.toolsSource).toBe("none")
    expect(first.gateway.toolViews("remote")).toEqual([])

    await first.gateway.reconcile({ remote: { enabled: true } })
    expect(first.gateway.get("remote")?.toolsSource).toBe("live")
    await waitFor(
      () => first.gateway.get("remote")?.catalogUpdatedAt !== undefined,
    )
    const catalog = (readSettings(root).tools as Record<string, unknown>)
      .catalog as { updatedAt: string; tools: Array<unknown> }
    expect(Number.isNaN(Date.parse(catalog.updatedAt))).toBe(false)
    expect(catalog.tools).toEqual([
      {
        name: "search",
        description: "search tool",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        annotations: { readOnlyHint: true },
      },
    ])

    await first.gateway.reconcile({ remote: { enabled: false } })
    expect(first.gateway.get("remote")?.toolsSource).toBe("cache")
    expect(first.gateway.listTools("remote")).toEqual([])
    expect(first.gateway.toolViews("remote")).toEqual([
      {
        ...(catalog.tools[0] as object),
        group: "read-only",
        permission: "allow",
        permissionSource: "default",
      } as never,
    ])
    await first.gateway.dispose()

    const second = createHost([module], fakeHost(), root)
    await second.gateway.reconcile(undefined)
    expect(second.gateway.get("remote")).toMatchObject({
      toolsSource: "cache",
      catalogUpdatedAt: catalog.updatedAt,
    })
  })

  test("an active plugin with no tools shows the cache; an empty set never overwrites it", async () => {
    const { module } = connector()
    const { gateway, storageRoot } = createHost([module])
    await gateway.reconcile({ remote: { enabled: true } })
    await waitFor(() => gateway.get("remote")?.catalogUpdatedAt !== undefined)
    await gateway.updateConfig("remote", { online: false })
    expect(gateway.get("remote")).toMatchObject({
      lifecycle: "active",
      tools: [],
      toolsSource: "cache",
    })
    expect(gateway.toolViews("remote").map((v) => v.name)).toEqual(["search"])
    const tools = readSettings(storageRoot).tools as Record<string, unknown>
    expect((tools.catalog as { tools: Array<unknown> }).tools).toHaveLength(1)
  })
})

const huge = (name: string): ToolDefinition => ({
  ...tool(name),
  description: "x".repeat(600 * 1024),
})

describe("tool catalog size", () => {
  test("a catalog that would push the settings file over 1 MiB is dropped, not written", async () => {
    const { module } = connector({}, (ctx) => {
      ctx.tools.registerAll([huge("one"), huge("two")])
    })
    const host = fakeHost()
    const { gateway, storageRoot } = createHost([module], host)
    await gateway.setToolPermissions("remote", { one: "block" })
    await gateway.reconcile({ remote: { enabled: true } })
    await waitFor(() => host.logs.some((line) => line.includes("not caching")))

    const file = settingsPath(storageRoot)
    expect(statSync(file).size).toBeLessThan(1024 * 1024)
    const tools = readSettings(storageRoot).tools as Record<string, unknown>
    expect(tools.catalog).toBeUndefined()
    expect(tools.permissions).toEqual({ one: "block" })

    // The file is still loadable by the next start.
    const second = createHost([module], fakeHost(), storageRoot)
    await second.gateway.reconcile({ remote: { enabled: true } })
    expect(second.gateway.get("remote")?.lifecycle).toBe("active")
  })
})

describe("legacy config import", () => {
  test("writes once, only when the file has no config, and is idempotent", async () => {
    const { module, applied } = connector()
    const { gateway, events, storageRoot } = createHost([module])
    await gateway.setToolPermissions("remote", { search: "block" })
    await gateway.reconcile({ remote: { enabled: true } })
    expect(applied).toEqual([DEFAULTS])

    events.length = 0
    expect(await gateway.importLegacyConfig("remote", { retries: 1 })).toBe(
      true,
    )
    expect(events).toContainEqual({ type: "settings", pluginId: "remote" })
    expect(applied.at(-1)).toEqual({ ...DEFAULTS, retries: 1 })
    expect(await gateway.importLegacyConfig("remote", { retries: 2 })).toBe(
      false,
    )
    expect(await gateway.importLegacyConfig("remote", undefined)).toBe(false)
    expect(readSettings(storageRoot)).toMatchObject({
      config: { retries: 1 },
      tools: { permissions: { search: "block" } },
    })
    expect(applied).toHaveLength(2)
    await expectGatewayError(
      gateway.importLegacyConfig("ghost", {}),
      "unknown-plugin",
    )
  })

  test("legacy config is treated as settings version 1 and migrated", async () => {
    const { module, migrations } = versioned()
    const { gateway, storageRoot } = createHost([module])
    expect(
      await gateway.importLegacyConfig("remote", {
        host: "https://legacy.test/mcp",
      }),
    ).toBe(true)
    expect(migrations).toEqual([[1, { host: "https://legacy.test/mcp" }]])
    expect(readSettings(storageRoot)).toMatchObject({
      version: 2,
      config: { endpoint: "https://legacy.test/mcp" },
    })
  })

  test("an invalid legacy config is kept and surfaces as a failed plugin", async () => {
    const { module } = connector()
    const { gateway, storageRoot } = createHost([module])
    expect(
      await gateway.importLegacyConfig("remote", { endpoint: "nope" }),
    ).toBe(true)
    await gateway.reconcile({ remote: { enabled: true } })
    expect(gateway.get("remote")?.lifecycle).toBe("failed")
    expect(readSettings(storageRoot).config).toEqual({ endpoint: "nope" })
  })
})
