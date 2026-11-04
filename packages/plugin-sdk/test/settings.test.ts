import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { z } from "zod"

import {
  PluginContractError,
  toolGroup,
  type Context,
  type PluginManifest,
  type PluginModule,
  type ToolDefinition,
  type ToolDefinitionPublic,
} from "../src/index"
import {
  applyPermissionChanges,
  newSettingsDocument,
  nonJsonPath,
  normalizeManifest,
  parseSettingsDocument,
  PLUGIN_SETTINGS_SCHEMA,
  resolveToolPermission,
  serializeSettingsDocument,
} from "../src/runtime/index"
import { createTestbed, loadPlugin } from "../src/testing/index"
import { rejection, rejectionMessage } from "./rejection"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plugin-sdk-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const connectorManifest = {
  id: "remote",
  kind: "connector",
  displayName: "Remote",
  description: "A remote MCP server.",
  homepage: "https://example.test/remote",
  settingsVersion: 2,
  configSchema: {
    type: "object",
    properties: { endpoint: { type: "string", format: "uri" } },
  },
  connector: {
    transport: "streamable-http",
    endpoint: "https://remote.example.test/mcp",
    auth: {
      type: "entra",
      clientId: "00000000-0000-0000-0000-000000000000",
      authority: "https://login.example.test/organizations",
      scopes: ["api://remote/.default"],
      redirectUri: "http://localhost:12798",
    },
    terms: { url: "https://example.test/terms" },
  },
} satisfies PluginManifest

function failure(id: string, value: unknown): string {
  try {
    normalizeManifest(id, value)
  } catch (error) {
    expect(error).toBeInstanceOf(PluginContractError)
    expect((error as PluginContractError).code).toBe("invalid-manifest")
    return (error as Error).message
  }
  throw new Error("expected an invalid manifest")
}

const withLimits = (value: unknown) => ({
  ...connectorManifest,
  connector: { ...connectorManifest.connector, limits: value },
})

describe("manifest validation", () => {
  test("a connector manifest is normalised, frozen, and unknown keys are dropped", () => {
    const manifest = normalizeManifest("remote", {
      ...connectorManifest,
      secretSauce: "nope",
    })
    expect(manifest).toEqual(connectorManifest)
    expect(Object.isFrozen(manifest)).toBe(true)
    expect(Object.isFrozen(manifest.connector?.auth)).toBe(true)
    expect(
      normalizeManifest("remote", {
        ...connectorManifest,
        connector: {
          ...connectorManifest.connector,
          auth: { type: "mcp-oauth", scopes: ["read"] },
        },
      }).connector?.auth,
    ).toEqual({ type: "mcp-oauth", scopes: ["read"] })
  })

  test("keeps connector limits and rejects malformed ones", () => {
    const limits = {
      maxConcurrency: 4,
      lanes: { teams: { maxConcurrency: 2, minIntervalMs: 500 } },
      retry: {
        attempts: 3,
        fallbackDelaysMs: [100, 200],
        retryWritesOn429: false,
      },
      fetchBatchSize: 0,
    }
    const manifest = normalizeManifest(
      "remote",
      withLimits({ ...limits, extra: 1 }),
    )
    expect(manifest.connector?.limits).toEqual(limits)
    expect(Object.isFrozen(manifest.connector?.limits?.lanes)).toBe(true)
    expect(failure("remote", withLimits({ maxQueue: -1 }))).toMatch(
      /connector\.limits\.maxQueue must be a non-negative number/,
    )
    expect(failure("remote", withLimits({ lanes: { teams: 2 } }))).toMatch(
      /connector\.limits\.lanes\.teams must be an object/,
    )
    expect(failure("remote", withLimits({ lanes: { "a b": {} } }))).toMatch(
      /invalid lane name/,
    )
    expect(
      failure("remote", withLimits({ retry: { fallbackDelaysMs: ["1"] } })),
    ).toMatch(/fallbackDelaysMs/)
    expect(
      failure("remote", withLimits({ retry: { retryWritesOn429: "yes" } })),
    ).toMatch(/retryWritesOn429 must be a boolean/)
  })

  test("rejects id mismatch, bad kind, connector rules, version and non-JSON values", () => {
    const base = connectorManifest
    expect(failure("other", base)).toMatch(/must equal the module name/)
    expect(failure("remote", { ...base, kind: "widget" })).toMatch(/kind/)
    expect(failure("remote", { ...base, connector: undefined })).toMatch(
      /requires a connector section/,
    )
    expect(failure("remote", { ...base, kind: "extension" })).toMatch(
      /only allowed when kind is "connector"/,
    )
    expect(failure("remote", { ...base, settingsVersion: 0 })).toMatch(
      /settingsVersion/,
    )
    expect(failure("remote", { ...base, settingsVersion: 1.5 })).toMatch(
      /settingsVersion/,
    )
    expect(
      failure("remote", {
        ...base,
        connector: { ...base.connector, transport: "stdio" },
      }),
    ).toMatch(/transport/)
    expect(
      failure("remote", {
        ...base,
        connector: { ...base.connector, auth: { type: "entra" } },
      }),
    ).toMatch(/clientId/)
    expect(
      failure("remote", {
        ...base,
        connector: { ...base.connector, terms: { url: "javascript:x" } },
      }),
    ).toMatch(/terms\.url/)
    expect(
      failure("remote", { ...base, configSchema: { type: "string" } }),
    ).toMatch(/configSchema/)
    expect(failure("remote", { ...base, displayName: () => "x" })).toMatch(
      /JSON-serialisable \(offending value at displayName\)/,
    )
    expect(
      failure("remote", {
        ...base,
        configSchema: { type: "object", default: new Date() },
      }),
    ).toMatch(/configSchema\.default/)
  })

  test("nonJsonPath finds the first non-JSON value", () => {
    expect(nonJsonPath({ a: [1, "x", null, { b: true }], c: undefined })).toBe(
      undefined,
    )
    expect(nonJsonPath({ a: [1, Number.NaN] })).toBe("a[1]")
    expect(nonJsonPath([undefined])).toBe("[0]")
    expect(nonJsonPath(1n)).toBe("(root)")
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(nonJsonPath(cyclic)).toBe("self")
  })
})

const text = (value: unknown) => JSON.stringify(value)

function reject(raw: string): string {
  try {
    parseSettingsDocument("remote", raw)
  } catch (error) {
    return (error as Error).message
  }
  throw new Error("expected rejection")
}

describe("settings document", () => {
  test("parses a valid envelope, keeps unknown keys, drops a malformed catalog", () => {
    const document = parseSettingsDocument(
      "remote",
      text({
        $schema: PLUGIN_SETTINGS_SCHEMA,
        plugin: "remote",
        version: 1,
        config: { a: 1 },
        future: true,
        tools: {
          permissions: { search: "allow", del: "ask" },
          catalog: { updatedAt: "x", tools: [{ name: "bad name" }] },
        },
      }),
    )
    expect(document).toEqual({
      $schema: PLUGIN_SETTINGS_SCHEMA,
      plugin: "remote",
      version: 1,
      config: { a: 1 },
      future: true,
      tools: { permissions: { search: "allow", del: "ask" } },
    })
    expect(JSON.parse(serializeSettingsDocument(document)) as unknown).toEqual(
      document,
    )
    expect(Object.keys(document)).toContain("future")
  })

  test("rejects files the host must not use or overwrite", () => {
    const ok = { $schema: PLUGIN_SETTINGS_SCHEMA, plugin: "remote", version: 1 }
    expect(reject("{ nope")).toMatch(/is not valid JSON.*will not overwrite/)
    expect(reject("[]")).toMatch(/not a JSON object/)
    expect(reject(text({ ...ok, $schema: "other" }))).toMatch(
      /not a Maximal plugin settings file/,
    )
    expect(
      reject(text({ ...ok, $schema: "maximal-plugin-settings/2" })),
    ).toMatch(/written by a newer Maximal/)
    expect(reject(text({ ...ok, plugin: "other" }))).toMatch(
      /belongs to plugin "other"/,
    )
    expect(reject(text({ ...ok, version: "1" }))).toMatch(/version/)
    expect(reject(text({ ...ok, tools: { permissions: { a: 1 } } }))).toMatch(
      /tools\.permissions/,
    )
    expect(reject('{"$schema":"x","__proto__":{"polluted":true}}')).toMatch(
      /unsafe key "__proto__"/,
    )
  })

  test("permission changes set, clear and tidy the tools section", () => {
    const document = newSettingsDocument({ id: "remote", settingsVersion: 1 })
    expect(applyPermissionChanges(document, { a: "block", b: "allow" })).toBe(
      true,
    )
    expect(document.tools).toEqual({ permissions: { a: "block", b: "allow" } })
    expect(applyPermissionChanges(document, { a: "block", c: null })).toBe(
      false,
    )
    expect(applyPermissionChanges(document, { a: null, b: null })).toBe(true)
    expect(document.tools).toBeUndefined()
  })
})

describe("tool permissions", () => {
  const read: ToolDefinitionPublic = {
    name: "read",
    description: "",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true, destructiveHint: true },
  }
  const del = { ...read, name: "del", annotations: { destructiveHint: true } }
  const misc = { ...read, name: "misc", annotations: undefined }

  test("groups follow readOnlyHint, then destructiveHint", () => {
    expect([read, del, misc].map((tool) => toolGroup(tool))).toEqual([
      "read-only",
      "write-delete",
      "other",
    ])
  })

  test("explicit > plugin default > allow; bad stored values and throwing defaults are ignored", () => {
    const module: Pick<PluginModule, "defaultToolPermission"> = {
      defaultToolPermission: (tool) => {
        if (tool.name === "misc") throw new Error("boom")
        return toolGroup(tool) === "write-delete" ? "block" : undefined
      },
    }
    const resolve = (
      tool: ToolDefinitionPublic,
      explicit: Record<string, string> = {},
    ) => resolveToolPermission(module, tool, explicit)
    expect(resolve(del)).toEqual({
      permission: "block",
      permissionSource: "plugin",
    })
    expect(resolve(del, { del: "allow" })).toEqual({
      permission: "allow",
      permissionSource: "user",
    })
    expect(resolve(del, { del: "ask" })).toEqual({
      permission: "block",
      permissionSource: "plugin",
    })
    expect(resolve(read)).toEqual({
      permission: "allow",
      permissionSource: "default",
    })
    expect(resolve(misc)).toEqual({
      permission: "allow",
      permissionSource: "default",
    })
    expect(resolve(read, { read: "block" }).permission).toBe("block")
  })
})

const Config = z.object({ endpoint: z.url().default("https://a.test/mcp") })

function tool(
  name: string,
  annotations?: ToolDefinition["annotations"],
): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object" },
    ...(annotations === undefined ? {} : { annotations }),
    execute: () => Promise.resolve({ content: [] }),
  }
}

/** settingsVersion 2 renamed `host` (v1) to `endpoint`. */
function versioned(
  apply: (ctx: Context, config: z.output<typeof Config>) => void = () => {},
): PluginModule<z.output<typeof Config>> {
  return {
    name: "remote",
    manifest: connectorManifest,
    inject: ["tools", "storage"],
    Config,
    apply,
    migrateSettings(from, config) {
      expect(from).toBe(1)
      const { host, ...rest } = (config ?? {}) as Record<string, unknown>
      return host === undefined ? rest : { ...rest, endpoint: host }
    },
    defaultToolPermission: (definition) =>
      toolGroup(definition) === "write-delete" ? "block" : undefined,
  }
}

describe("testbed settings negotiation", () => {
  test("load reads, migrates and writes back settings.json (temp dir)", async () => {
    const dir = tempDir()
    const testbed = createTestbed({ storageDir: dir })
    const module = versioned()
    await testbed.writeSettings(module, {
      version: 1,
      config: { host: "https://b.test/mcp" },
      permissions: { search: "block" },
    })
    const loaded = await testbed.load(module)
    expect(loaded.config).toEqual({ endpoint: "https://b.test/mcp" })
    expect(loaded.manifest).toEqual(connectorManifest)
    expect(await testbed.readSettings("remote")).toEqual({
      $schema: PLUGIN_SETTINGS_SCHEMA,
      plugin: "remote",
      version: 2,
      config: { endpoint: "https://b.test/mcp" },
      tools: { permissions: { search: "block" } },
    })
    const file = path.join(dir, "remote", "settings.json")
    if (process.platform !== "win32")
      expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(Object.keys(testbed.storage.files("remote"))).toEqual([
      "settings.json",
    ])
    await testbed.dispose()
  })

  test("toolViews resolves file permissions and the plugin default", async () => {
    const testbed = createTestbed()
    const module = versioned((ctx) => {
      ctx.tools.registerAll([
        tool("search", { readOnlyHint: true }),
        tool("del", { destructiveHint: true }),
        tool("misc"),
      ])
    })
    await testbed.writeSettings(module, { permissions: { search: "block" } })
    const loaded = await testbed.load(module)
    const summary = (views: Awaited<ReturnType<typeof loaded.toolViews>>) =>
      views.map((view) => [
        view.name,
        view.group,
        view.permission,
        view.permissionSource,
      ])
    expect(summary(await loaded.toolViews())).toEqual([
      ["search", "read-only", "block", "user"],
      ["del", "write-delete", "block", "plugin"],
      ["misc", "other", "allow", "default"],
    ])
    expect(summary(await loaded.toolViews({ del: "allow" }))[1]).toEqual([
      "del",
      "write-delete",
      "allow",
      "user",
    ])
    await testbed.dispose()
  })

  test("invalid, newer or unreadable settings reject load and are left untouched", async () => {
    const testbed = createTestbed()
    const module = versioned()
    await testbed.writeSettings(module, { config: { endpoint: "nope" } })
    const invalid = await rejection(testbed.load(module))
    expect((invalid as PluginContractError).code).toBe("invalid-config")
    expect((invalid as Error).message).toMatch(/^remote\.endpoint: /)

    await testbed.writeSettings(module, { version: 3 })
    const newer = await rejection(testbed.load(module))
    expect((newer as PluginContractError).code).toBe("invalid-settings")
    expect((newer as Error).message).toMatch(/version 3, newer/)

    testbed.storage.seed("remote", "settings.json", "{ broken")
    expect(await rejectionMessage(testbed.load(module))).toMatch(
      /not valid JSON/,
    )
    expect(testbed.storage.files("remote")["settings.json"]).toBe("{ broken")
    await testbed.dispose()
  })

  test("ctx.storage refuses the reserved settings file name (any case)", async () => {
    const codes: Array<string> = []
    const loaded = await loadPlugin({
      ...versioned(),
      async apply(ctx: Context) {
        for (const name of ["settings.json", "Settings.JSON"]) {
          try {
            await ctx.storage.writeText(name, "{}")
          } catch (error) {
            codes.push((error as PluginContractError).code)
          }
        }
        expect(
          await rejectionMessage(ctx.storage.readText("settings.json")),
        ).toMatch(/reserved/)
      },
    })
    expect(codes).toEqual(["invalid-storage-name", "invalid-storage-name"])
    expect(loaded.testbed.storage.files("remote")).toEqual({})
    await loaded.dispose()
  })

  test("an explicit config bypasses the settings file", async () => {
    const testbed = createTestbed()
    const module = versioned()
    testbed.storage.seed("remote", "settings.json", "{ broken")
    const loaded = await testbed.load(module, {})
    expect(loaded.config).toEqual({ endpoint: "https://a.test/mcp" })
    await testbed.dispose()
  })
})
