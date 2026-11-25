/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-unnecessary-condition */
import { describe, expect, test } from "bun:test"

import {
  createPluginModuleLoader,
  InventoryReadFailure,
  loadPluginInventory,
  MAX_INVENTORY_BYTES,
  PluginInventoryError,
  PluginModuleLoadError,
  PLUGIN_INVENTORY_SCHEMA,
  reloadPluginInventory,
  type InventoryFileSystem,
  type PluginCatalog,
  type PluginGeneration,
  type ResolvedPlugin,
} from "../src/index"
const catalog: PluginCatalog = {
  descriptors: [
    {
      id: "descriptor",
      provenance: "built-in",
      module: { moduleId: "module", export: "plugin" },
    },
  ],
  installations: [],
}
const plugin: ResolvedPlugin = {
  id: "plugin",
  provenance: "built-in",
  descriptorId: "descriptor",
  descriptor: {
    id: "descriptor",
    provenance: "built-in",
    module: { moduleId: "module", export: "plugin" },
  },
  definedIn: "root",
}
function fs(
  files: Readonly<Record<string, string>>,
  aliases: Readonly<Record<string, string>> = {},
): InventoryFileSystem {
  const open = (id: string) => {
    const canonicalId = aliases[id] ?? id
    const text = files[canonicalId]
    if (text === undefined)
      return Promise.reject(new InventoryReadFailure("not-found", id))
    return Promise.resolve({ canonicalId, text })
  }
  return {
    openEntry: ({ entry }) => open(entry),
    openInclude: ({ reference }) => open(reference),
  }
}
const document = (value: Record<string, unknown> = {}) =>
  JSON.stringify({ $schema: PLUGIN_INVENTORY_SCHEMA, ...value })
describe("atomic filesystem boundary", () => {
  test("uses adapter canonical identities for aliases and reads each canonical file once", async () => {
    const result = await loadPluginInventory({
      entry: "entry-alias",
      rootDirectory: "root",
      catalog,
      fileSystem: fs(
        {
          root: document({ includes: ["child-alias", "child-again"] }),
          child: document({
            plugins: [
              {
                id: "plugin",
                descriptorId: "descriptor",
              },
            ],
          }),
        },
        {
          "entry-alias": "root",
          "child-alias": "child",
          "child-again": "child",
        },
      ),
    })
    expect(result.sources).toEqual(["child", "root"])
    expect(result.plugins[0]?.id).toBe("plugin")
  })
  test.each([
    [new InventoryReadFailure("not-found", "gone"), "read-not-found"],
    [
      new InventoryReadFailure("permission-denied", "no"),
      "read-permission-denied",
    ],
    [new InventoryReadFailure("too-large", "large"), "read-too-large"],
    [new Error("adapter broke"), "read-failed"],
  ] as const)("distinguishes read failure %#", async (failure, code) => {
    const fileSystem: InventoryFileSystem = {
      openEntry: () => Promise.reject(failure),
      openInclude: () => Promise.reject(failure),
    }
    try {
      await loadPluginInventory({
        entry: "root",
        rootDirectory: "root",
        catalog,
        fileSystem,
      })
    } catch (reason) {
      expect(reason).toBeInstanceOf(PluginInventoryError)
      expect((reason as PluginInventoryError).code).toBe(code)
      return
    }
    throw new Error("expected failure")
  })
  test("bounds bytes even when an adapter violates its contract", async () => {
    try {
      await loadPluginInventory({
        entry: "root",
        rootDirectory: "root",
        catalog,
        fileSystem: fs({ root: " ".repeat(MAX_INVENTORY_BYTES + 1) }),
      })
    } catch (reason) {
      expect((reason as PluginInventoryError).code).toBe("read-too-large")
      return
    }
    throw new Error("expected failure")
  })
  test("retains last-good on every controlled adapter failure", async () => {
    const lastGood = await loadPluginInventory({
      entry: "root",
      rootDirectory: "root",
      catalog,
      fileSystem: fs({ root: document() }),
    })
    const result = await reloadPluginInventory({
      entry: "missing",
      rootDirectory: "root",
      catalog,
      fileSystem: fs({}),
      lastGood,
    })
    expect(result.ok).toBe(false)
    expect(result.inventory).toBe(lastGood)
  })
})
describe("full-generation module artifacts", () => {
  test("imports unique bundled artifacts so transitive changes reload", async () => {
    const dependencies = new Map([
      ["1", "dependency-v1"],
      ["2", "dependency-v2"],
    ])
    const loader = createPluginModuleLoader({
      prepareGeneration: (_plugin, generation) =>
        Promise.resolve({
          generation,
          specifier: `bundle:${generation}:${dependencies.get(generation)}`,
        }),
      importModule: (specifier) => Promise.resolve({ plugin: { specifier } }),
    })
    const first = await loader.load(plugin, 1)
    const second = await loader.load(plugin, 2)
    expect(first).toEqual({ specifier: "bundle:1:dependency-v1" })
    expect(second).toEqual({ specifier: "bundle:2:dependency-v2" })
  })
  test("runtime-checks generations and rejects reused artifacts", async () => {
    const loader = createPluginModuleLoader({
      prepareGeneration: (_plugin, generation) =>
        Promise.resolve({ generation, specifier: "same-bundle" }),
      importModule: () => Promise.resolve({ plugin: true }),
    })
    await loader.load(plugin, 1)
    await expect(loader.load(plugin, 2)).rejects.toMatchObject({
      code: "invalid-generation-artifact",
    })
    await expect(
      loader.load(plugin, { bad: true } as unknown as PluginGeneration),
    ).rejects.toMatchObject({ code: "invalid-generation" })
  })
  test("rejects changing the artifact for one module generation", async () => {
    let preparation = 0
    const loader = createPluginModuleLoader({
      prepareGeneration: (_plugin, generation) => {
        preparation += 1
        return Promise.resolve({
          generation,
          specifier: preparation === 1 ? "bundle:first" : "bundle:second",
        })
      },
      importModule: () => Promise.resolve({ plugin: true }),
    })
    await loader.load(plugin, 1)
    await expect(loader.load(plugin, 1)).rejects.toMatchObject({
      code: "invalid-generation-artifact",
    })
  })
  test.each([
    null,
    undefined,
    { generation: 1, specifier: "bundle" },
    { generation: "1", specifier: 1 },
  ])("rejects malformed generation artifact %#", async (artifact) => {
    const loader = createPluginModuleLoader({
      prepareGeneration: () => Promise.resolve(artifact),
      importModule: () => Promise.resolve({ plugin: true }),
    })
    await expect(loader.load(plugin, 1)).rejects.toMatchObject({
      code: "invalid-generation-artifact",
    })
  })
  test("requires named exports to be own properties", async () => {
    const loader = createPluginModuleLoader({
      prepareGeneration: (_plugin, generation) =>
        Promise.resolve({ generation, specifier: `bundle:${generation}` }),
      importModule: () =>
        Promise.resolve(Object.create({ plugin: true }) as object),
    })
    await expect(loader.load(plugin, 1)).rejects.toMatchObject({
      code: "missing-export",
    })
  })
  test("missing exports cannot silently resolve", async () => {
    const loader = createPluginModuleLoader({
      prepareGeneration: (_plugin, generation) =>
        Promise.resolve({ generation, specifier: `bundle:${generation}` }),
      importModule: () => Promise.resolve({}),
    })
    try {
      await loader.load(plugin, 1)
    } catch (reason) {
      expect(reason).toBeInstanceOf(PluginModuleLoadError)
      expect((reason as PluginModuleLoadError).code).toBe("missing-export")
      return
    }
    throw new Error("expected missing export")
  })
})
