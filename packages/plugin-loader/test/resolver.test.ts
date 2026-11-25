import { describe, expect, test } from "bun:test"

import {
  MAX_EXPANDED_PLUGINS,
  MAX_GROUP_DEPTH,
  MAX_GROUP_GRAPH_WORK,
  parsePluginInventoryDocument,
  PluginInventoryError,
  PLUGIN_INVENTORY_SCHEMA,
  resolvePluginInventory,
  type InventoryDocumentSource,
  type PluginCatalog,
} from "../src/index"
const catalog: PluginCatalog = {
  descriptors: [
    {
      id: "alpha-descriptor",
      provenance: "built-in",
      module: { moduleId: "alpha-module" },
    },
    {
      id: "beta-descriptor",
      provenance: "built-in",
      module: { moduleId: "beta-module" },
    },
    {
      id: "shared-descriptor",
      provenance: "built-in",
      module: { moduleId: "shared-module" },
    },
  ],
  installations: [
    {
      id: "external-install",
      descriptorId: "external-descriptor",
      package: { name: "external-package", location: "/trusted/package" },
    },
  ],
}
function source(
  source: string,
  value: Record<string, unknown>,
  includeSources: ReadonlyArray<string> = [],
): InventoryDocumentSource {
  return {
    source,
    document: parsePluginInventoryDocument(
      { $schema: PLUGIN_INVENTORY_SCHEMA, ...value },
      source,
    ),
    includeSources,
  }
}
function resolve(
  documents: ReadonlyArray<InventoryDocumentSource>,
  customCatalog = catalog,
) {
  return resolvePluginInventory({
    entry: "root",
    documents,
    catalog: customCatalog,
  })
}
function error(
  documents: ReadonlyArray<InventoryDocumentSource>,
  customCatalog = catalog,
): PluginInventoryError {
  try {
    resolve(documents, customCatalog)
  } catch (reason) {
    expect(reason).toBeInstanceOf(PluginInventoryError)
    return reason as PluginInventoryError
  }
  throw new Error("expected failure")
}
// eslint-disable-next-line max-lines-per-function
describe("pure inventory resolver", () => {
  test("expands canonical includes and nested groups deterministically with disable precedence", () => {
    const result = resolve([
      source(
        "root",
        {
          includes: ["alias.json"],
          plugins: [
            {
              id: "beta",
              descriptorId: "beta-descriptor",
            },
          ],
          groups: [
            {
              id: "all",
              members: [
                { plugin: "alpha" },
                { plugin: "beta" },
                { plugin: "alpha" },
              ],
            },
          ],
          members: [{ group: "all" }],
          disabled: [{ plugin: "beta" }],
        },
        ["canonical-child"],
      ),
      source("canonical-child", {
        plugins: [
          {
            id: "alpha",
            descriptorId: "alpha-descriptor",
          },
        ],
      }),
    ])
    expect(result.sources).toEqual(["canonical-child", "root"])
    expect(result.plugins.map((plugin) => plugin.id)).toEqual(["alpha"])
  })
  test("detects include cycles through canonical aliases", () => {
    const failure = error([
      source("root", { includes: ["alias"] }, ["canonical"]),
      source("canonical", { includes: ["back"] }, ["root"]),
    ])
    expect(failure.code).toBe("include-cycle")
    expect(failure.cycle).toEqual(["root", "canonical", "root"])
  })
  test.each([
    [{ members: [{ plugin: "missing" }] }, "missing-member"],
    [{ groups: [{ id: "loop", members: [{ group: "loop" }] }] }, "group-cycle"],
    [
      {
        plugins: [
          {
            id: "unknown",
            descriptorId: "not-approved",
          },
        ],
      },
      "missing-descriptor",
    ],
  ] as const)("returns structured resolution errors %#", (document, code) =>
    expect(error([source("root", document)]).code).toBe(code),
  )
  test("enforces one selected leaf per module", () => {
    const failure = error([
      source("root", {
        plugins: [
          {
            id: "first",
            descriptorId: "shared-descriptor",
          },
          {
            id: "second",
            descriptorId: "shared-descriptor",
          },
        ],
      }),
    ])
    expect(failure.code).toBe("duplicate-module")
  })
  test("takes provenance from the catalog and rejects illegal pairings", () => {
    const pairingCatalog: PluginCatalog = {
      descriptors: [
        {
          id: "built-in-descriptor",
          provenance: "built-in",
          module: { moduleId: "built-in-module" },
        },
        {
          id: "external-alpha",
          provenance: "external",
          module: { moduleId: "external-alpha-module" },
        },
        {
          id: "external-beta",
          provenance: "external",
          module: { moduleId: "external-beta-module" },
        },
      ],
      installations: [
        {
          id: "alpha-installation",
          descriptorId: "external-alpha",
          package: { name: "alpha-package", location: "/alpha" },
        },
        {
          id: "beta-installation",
          descriptorId: "external-beta",
          package: { name: "beta-package", location: "/beta" },
        },
      ],
    }
    const builtInMismatch = error(
      [
        source("root", {
          plugins: [
            {
              id: "bad-built-in",
              descriptorId: "built-in-descriptor",
              installationId: "alpha-installation",
            },
          ],
        }),
      ],
      pairingCatalog,
    )
    const externalMismatch = error(
      [
        source("root", {
          plugins: [{ id: "bad-external", descriptorId: "external-alpha" }],
        }),
      ],
      pairingCatalog,
    )
    const crossPair = error(
      [
        source("root", {
          plugins: [
            {
              id: "cross-pair",
              descriptorId: "external-alpha",
              installationId: "beta-installation",
            },
          ],
        }),
      ],
      pairingCatalog,
    )
    expect(builtInMismatch.code).toBe("provenance-mismatch")
    expect(externalMismatch.code).toBe("provenance-mismatch")
    expect(crossPair.code).toBe("installation-mismatch")
  })
  test("clones and deeply freezes trusted catalog data", () => {
    const descriptor = {
      id: "external-descriptor",
      provenance: "external" as const,
      module: { moduleId: "original-module", export: "plugin" },
      compatibility: {
        maximal: "^1",
        platforms: ["darwin"],
        architectures: ["arm64"],
      },
    }
    const installation = {
      id: "external-installation",
      descriptorId: "external-descriptor",
      package: {
        name: "external-package",
        version: "1.0.0",
        location: "/original",
      },
    }
    const result = resolve(
      [
        source("root", {
          plugins: [
            {
              id: "external-plugin",
              descriptorId: "external-descriptor",
              installationId: "external-installation",
            },
          ],
        }),
      ],
      { descriptors: [descriptor], installations: [installation] },
    )
    descriptor.module.moduleId = "mutated-module"
    descriptor.compatibility.platforms.push("linux")
    installation.package.location = "/mutated"
    Object.defineProperty(descriptor, "provenance", { value: "built-in" })
    const resolved = result.plugins[0]
    expect(resolved.provenance).toBe("external")
    if (resolved.provenance !== "external")
      throw new Error("expected external plugin")
    expect(resolved.descriptor.module.moduleId).toBe("original-module")
    expect(resolved.descriptor.compatibility?.platforms).toEqual(["darwin"])
    expect(resolved.installation.package.location).toBe("/original")
    expect(Object.isFrozen(resolved.descriptor.module)).toBe(true)
    expect(Object.isFrozen(resolved.descriptor.compatibility?.platforms)).toBe(
      true,
    )
    expect(Object.isFrozen(resolved.installation.package)).toBe(true)
  })
  test("bounds a deep linear group graph independently of JSON depth", () => {
    const groups: Array<Record<string, unknown>> = []
    for (let index = 0; index <= MAX_GROUP_DEPTH; index++)
      groups.push({
        id: `group-${String(index).padStart(3, "0")}`,
        members:
          index === MAX_GROUP_DEPTH ?
            [{ plugin: "alpha" }]
          : [{ group: `group-${String(index + 1).padStart(3, "0")}` }],
      })
    const failure = error([
      source("root", {
        plugins: [{ id: "alpha", descriptorId: "alpha-descriptor" }],
        groups,
        members: [{ group: "group-000" }],
      }),
    ])
    expect(failure.code).toBe("group-depth-limit")
  })
  test("bounds group graph work even when groups have no leaves", () => {
    const groups = Array.from(
      { length: MAX_GROUP_GRAPH_WORK + 1 },
      (_, index) => ({
        id: `work-${String(index).padStart(4, "0")}`,
        members: [],
      }),
    )
    const failure = error([source("root", { groups })])
    expect(failure.code).toBe("group-work-limit")
  })
  test("bounds memoized expansion without exponential materialization", () => {
    const groups: Array<Record<string, unknown>> = [
      { id: "level-00", members: [{ plugin: "alpha" }, { plugin: "alpha" }] },
    ]
    for (let index = 1; index < 15; index++) {
      const previous = `level-${String(index - 1).padStart(2, "0")}`
      groups.push({
        id: `level-${String(index).padStart(2, "0")}`,
        members: [{ group: previous }, { group: previous }],
      })
    }
    const failure = error([
      source("root", {
        plugins: [
          {
            id: "alpha",
            descriptorId: "alpha-descriptor",
          },
        ],
        groups,
        members: [{ group: "level-14" }],
      }),
    ])
    expect(failure.code).toBe("expansion-limit")
    expect(failure.message).toContain(String(MAX_EXPANDED_PLUGINS))
  })
})
