/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression, max-lines-per-function */
import { afterEach, describe, expect, test } from "bun:test"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  createPluginGenerationSelectionToken,
  parsePluginInventoryDocument,
  PLUGIN_API_VERSION,
  PLUGIN_INVENTORY_SCHEMA,
  PLUGIN_RUNNER_PROTOCOL_VERSION,
  PluginGenerationRepository,
  preparePluginGeneration,
  reverifyGenerationSelectionForRunner,
  verifyPluginGeneration,
  type GenerationCompatibility,
  type PluginGenerationBuild,
  type ResolvedPlugin,
  type ResolvedPluginInventory,
} from "../src/index"

const roots = new Set<string>()
const compatibility: GenerationCompatibility = {
  maximal: "1.2.3",
  protocol: PLUGIN_RUNNER_PROTOCOL_VERSION,
  pluginApi: PLUGIN_API_VERSION,
  runtime: `bun:${Bun.version}`,
  platform: process.platform,
  architecture: process.arch,
}

function build(id = "build-one"): PluginGenerationBuild {
  return { ...compatibility, id }
}

function plugin(
  id: string,
  options: {
    export?: string
    compatibility?: ResolvedPlugin["descriptor"]["compatibility"]
    provides?: ReadonlyArray<string>
    requires?: ReadonlyArray<string>
  } = {},
): ResolvedPlugin {
  return {
    id,
    descriptorId: `${id}-descriptor`,
    provenance: "built-in",
    definedIn: "test-inventory",
    descriptor: {
      id: `${id}-descriptor`,
      provenance: "built-in",
      module: {
        moduleId: `${id}-module`,
        ...(options.export === undefined ? {} : { export: options.export }),
      },
      ...(options.compatibility === undefined ?
        {}
      : { compatibility: options.compatibility }),
      ...(options.provides === undefined && options.requires === undefined ?
        {}
      : {
          services: {
            ...(options.provides === undefined ?
              {}
            : { provides: options.provides }),
            ...(options.requires === undefined ?
              {}
            : { requires: options.requires }),
          },
        }),
    },
  }
}

function inventory(
  plugins: ReadonlyArray<ResolvedPlugin>,
): ResolvedPluginInventory {
  return { plugins, sources: ["test-inventory"] }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-generation-"))
  roots.add(root)
  return root
}

async function prepare(
  root: string,
  plugins: ReadonlyArray<ResolvedPlugin>,
  options: {
    enabled?: ReadonlyArray<string>
    build?: PluginGenerationBuild
    sources?: Readonly<Record<string, string>>
  } = {},
) {
  const sourceRoot = path.join(root, "source")
  await mkdir(sourceRoot, { recursive: true })
  const targets = []
  for (const item of plugins) {
    const entrypoint = path.join(sourceRoot, `${item.id}.ts`)
    await writeFile(
      entrypoint,
      options.sources?.[item.id]
        ?? `export const name = ${JSON.stringify(item.id)}\nexport const manifest = {}\nexport const inject = ${JSON.stringify(item.descriptor.services?.requires ?? [])}\nexport const provides = ${JSON.stringify(item.descriptor.services?.provides ?? [])}\nexport const Config = {}\nexport function apply() {}\nexport const plugin = { name, manifest, inject, provides, Config, apply }\n`,
    )
    targets.push({
      moduleId: item.descriptor.module.moduleId,
      entrypoint,
      metadata: {
        name: item.id,
        inject: item.descriptor.services?.requires ?? [],
        provides: item.descriptor.services?.provides ?? [],
      },
      trustedRoots: [sourceRoot],
    })
  }
  return preparePluginGeneration({
    artifactRoot: path.join(root, "artifacts"),
    inventory: inventory(plugins),
    enabledPluginIds: options.enabled ?? plugins.map(({ id }) => id),
    hostServices: ["host"],
    build: options.build ?? build(),
    targets,
  })
}

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  )
  roots.clear()
})

describe("immutable generation preparation", () => {
  test("builds one complete manifest with exact identity and artifact hashes", async () => {
    const root = await temporaryRoot()
    const prepared = await prepare(root, [
      plugin("alpha", { export: "plugin" }),
    ])

    expect(prepared.manifest.build).toEqual(build())
    expect(prepared.manifest.inventoryDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(prepared.manifest.modules).toHaveLength(1)
    expect(prepared.manifest.modules[0]).toMatchObject({
      pluginId: "alpha",
      export: "plugin",
      provenance: "built-in",
    })
    await expect(
      verifyPluginGeneration({
        directory: prepared.directory,
        expected: compatibility,
        expectedManifestSha256: prepared.manifestSha256,
      }),
    ).resolves.toMatchObject({
      manifest: { generationId: prepared.manifest.generationId },
    })
  })

  test.each([
    ["maximal", "9.9.9"],
    ["pluginApi", "maximal-plugin-api/other"],
    ["runtime", "bun:0"],
    ["platform", "other-platform"],
    ["architecture", "other-architecture"],
  ] as const)(
    "rejects incompatible plugin %s before publication",
    async (field, value) => {
      const root = await temporaryRoot()
      let requirement: NonNullable<
        ResolvedPlugin["descriptor"]["compatibility"]
      >
      if (field === "platform") requirement = { platforms: [value] }
      else if (field === "architecture")
        requirement = { architectures: [value] }
      else requirement = { [field]: value }
      await expect(
        prepare(root, [plugin("alpha", { compatibility: requirement })]),
      ).rejects.toMatchObject({
        code: "incompatible-plugin",
        pluginId: "alpha",
      })
    },
  )

  test.each([
    "protocol",
    "pluginApi",
    "runtime",
    "platform",
    "architecture",
  ] as const)("rejects a generation built for another %s", async (field) => {
    const root = await temporaryRoot()
    const prepared = await prepare(root, [plugin("alpha")])
    await expect(
      verifyPluginGeneration({
        directory: prepared.directory,
        expected: { ...compatibility, [field]: "different" },
      }),
    ).rejects.toMatchObject({ code: "incompatible-generation" })
  })

  test("rejects missing enabled providers and dependency cycles", async () => {
    const missingRoot = await temporaryRoot()
    await expect(
      prepare(missingRoot, [plugin("consumer", { requires: ["catalog"] })]),
    ).rejects.toMatchObject({ code: "missing-provider" })

    const cycleRoot = await temporaryRoot()
    await expect(
      prepare(cycleRoot, [
        plugin("alpha", { provides: ["alpha"], requires: ["beta"] }),
        plugin("beta", { provides: ["beta"], requires: ["alpha"] }),
      ]),
    ).rejects.toMatchObject({ code: "dependency-cycle" })
  })

  test("builds the graph from static module metadata, not descriptor claims", async () => {
    const root = await temporaryRoot()
    const sourceRoot = path.join(root, "source")
    await mkdir(sourceRoot)
    const entrypoint = path.join(sourceRoot, "consumer.ts")
    await writeFile(
      entrypoint,
      "export const name = 'consumer'\nexport const inject = ['catalog']\n",
    )

    await expect(
      preparePluginGeneration({
        artifactRoot: path.join(root, "artifacts"),
        inventory: inventory([plugin("consumer")]),
        enabledPluginIds: ["consumer"],
        hostServices: [],
        build: build(),
        targets: [
          {
            moduleId: "consumer-module",
            entrypoint,
            metadata: {
              name: "consumer",
              inject: ["catalog"],
              provides: [],
            },
            trustedRoots: [sourceRoot],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "missing-provider" })
  })

  test("rejects a provider present in inventory but disabled by config", async () => {
    const root = await temporaryRoot()
    await expect(
      prepare(
        root,
        [
          plugin("provider", { provides: ["catalog"] }),
          plugin("consumer", { requires: ["catalog"] }),
        ],
        { enabled: ["consumer"] },
      ),
    ).rejects.toMatchObject({ code: "missing-provider" })
  })

  test("rejects source paths outside trusted roots and missing exports", async () => {
    const root = await temporaryRoot()
    const trusted = path.join(root, "trusted")
    const outside = path.join(root, "outside")
    await mkdir(trusted)
    await mkdir(outside)
    const entrypoint = path.join(outside, "plugin.ts")
    await writeFile(entrypoint, "export const plugin = true\n")
    await expect(
      preparePluginGeneration({
        artifactRoot: path.join(root, "artifacts"),
        inventory: inventory([plugin("alpha", { export: "plugin" })]),
        enabledPluginIds: ["alpha"],
        hostServices: [],
        build: build(),
        targets: [
          {
            moduleId: "alpha-module",
            entrypoint,
            metadata: { name: "alpha", inject: [], provides: [] },
            trustedRoots: [trusted],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "untrusted-path" })

    const externalRoot = await temporaryRoot()
    const approvedPackage = path.join(externalRoot, "approved-package")
    const otherPackage = path.join(externalRoot, "other-package")
    await mkdir(approvedPackage)
    await mkdir(otherPackage)
    const externalEntrypoint = path.join(otherPackage, "plugin.ts")
    await writeFile(externalEntrypoint, "export const plugin = true\n")
    const externalPlugin: ResolvedPlugin = {
      id: "external",
      descriptorId: "external-descriptor",
      provenance: "external",
      installationId: "approved-installation",
      definedIn: "inventory",
      descriptor: {
        id: "external-descriptor",
        provenance: "external",
        module: { moduleId: "external-module", export: "plugin" },
      },
      installation: {
        id: "approved-installation",
        descriptorId: "external-descriptor",
        package: {
          name: "external-package",
          location: approvedPackage,
        },
      },
    }
    await expect(
      preparePluginGeneration({
        artifactRoot: path.join(externalRoot, "artifacts"),
        inventory: inventory([externalPlugin]),
        enabledPluginIds: ["external"],
        hostServices: [],
        build: build(),
        targets: [
          {
            moduleId: "external-module",
            entrypoint: externalEntrypoint,
            metadata: { name: "external", inject: [], provides: [] },
            trustedRoots: [externalRoot],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "untrusted-path" })

    const missingRoot = await temporaryRoot()
    await expect(
      prepare(missingRoot, [plugin("alpha", { export: "missing" })], {
        sources: { alpha: "export const present = true\n" },
      }),
    ).rejects.toMatchObject({ code: "missing-export" })
  })

  test("runner verification rejects bundled declarations that differ from static metadata", async () => {
    const root = await temporaryRoot()
    const prepared = await prepare(root, [plugin("consumer")], {
      sources: {
        consumer:
          "export const name = 'consumer'\nexport const manifest = {}\nexport const inject = ['catalog']\nexport const provides = []\nexport const Config = {}\nexport function apply() {}\n",
      },
    })
    const token = await createPluginGenerationSelectionToken(prepared)

    await expect(
      reverifyGenerationSelectionForRunner({
        token,
        expected: compatibility,
      }),
    ).rejects.toMatchObject({
      code: "module-metadata-mismatch",
      pluginId: "consumer",
    })
  })

  test("sealed selection rejects token and artifact mutation", async () => {
    const tokenRoot = await temporaryRoot()
    const selected = await prepare(tokenRoot, [plugin("alpha")])
    const token = await createPluginGenerationSelectionToken(selected)
    await expect(
      reverifyGenerationSelectionForRunner({
        token: { ...token, generationId: "0".repeat(64) },
        expected: compatibility,
      }),
    ).rejects.toMatchObject({ code: "invalid-selection" })

    const artifact = path.join(
      selected.directory,
      selected.manifest.modules[0]?.artifact ?? "missing",
    )
    if (process.platform !== "win32") await chmod(artifact, 0o600)
    await writeFile(artifact, `${await readFile(artifact, "utf8")}\n// swap\n`)
    await expect(
      reverifyGenerationSelectionForRunner({ token, expected: compatibility }),
    ).rejects.toMatchObject({ code: "hash-mismatch" })
  })

  test("detects mutable artifacts and hash mismatches before spawn", async () => {
    const root = await temporaryRoot()
    const prepared = await prepare(root, [plugin("alpha")])
    const artifact = path.join(
      prepared.directory,
      prepared.manifest.modules[0]?.artifact ?? "missing",
    )
    if (process.platform !== "win32") await chmod(artifact, 0o600)
    await writeFile(
      artifact,
      `${await readFile(artifact, "utf8")}\n// changed\n`,
    )

    await expect(
      verifyPluginGeneration({
        directory: prepared.directory,
        expected: compatibility,
      }),
    ).rejects.toMatchObject({ code: "hash-mismatch" })
  })
})

describe("durable generation authority", () => {
  test("recovers the committed custom generation after restart and inventory corruption", async () => {
    const root = await temporaryRoot()
    const prepared = await prepare(root, [plugin("custom")])
    const options = {
      artifactRoot: path.join(root, "artifacts"),
      commitFile: path.join(root, "state", "committed.json"),
      compatibility,
    }
    await new PluginGenerationRepository(options).commit(prepared)

    expect(() =>
      parsePluginInventoryDocument(
        { $schema: PLUGIN_INVENTORY_SCHEMA, plugins: "corrupt" },
        "inventory.json",
      ),
    ).toThrow()
    const restarted = new PluginGenerationRepository(options)
    await expect(restarted.committed()).resolves.toMatchObject({
      manifest: { generationId: prepared.manifest.generationId },
    })
  })

  test("retains committed, last-known-good, and leased generations", async () => {
    const root = await temporaryRoot()
    const first = await prepare(root, [plugin("alpha")], {
      build: build("one"),
    })
    const second = await prepare(root, [plugin("alpha")], {
      build: build("two"),
    })
    const leased = await prepare(root, [plugin("alpha")], {
      build: build("three"),
    })
    const repository = new PluginGenerationRepository({
      artifactRoot: path.join(root, "artifacts"),
      commitFile: path.join(root, "committed.json"),
      compatibility,
    })
    await repository.commit(first)
    await repository.commit(second)
    const lease = await repository.retain(leased.manifest.generationId)

    const retained = await repository.garbageCollect({ retainNewest: 0 })
    expect(retained.removed).toEqual([])
    expect([...retained.retained].sort()).toEqual(
      [
        first.manifest.generationId,
        second.manifest.generationId,
        leased.manifest.generationId,
      ].sort(),
    )

    lease.release()
    const collected = await repository.garbageCollect({ retainNewest: 0 })
    expect(collected.removed).toEqual([leased.manifest.generationId])
  })

  test("retries Windows-style locked-file failures during collection", async () => {
    const root = await temporaryRoot()
    const first = await prepare(root, [plugin("alpha")], {
      build: build("one"),
    })
    let attempts = 0
    const delays: Array<number> = []
    const repository = new PluginGenerationRepository({
      artifactRoot: path.join(root, "artifacts"),
      commitFile: path.join(root, "committed.json"),
      compatibility,
      removeDirectory: async (directory) => {
        attempts += 1
        if (attempts < 3) {
          const error = new Error("locked") as NodeJS.ErrnoException
          error.code = "EPERM"
          throw error
        }
        await rm(directory, { recursive: true, force: true })
      },
      sleep: (milliseconds) => {
        delays.push(milliseconds)
        return Promise.resolve()
      },
    })

    const result = await repository.garbageCollect({
      retainNewest: 0,
      lockRetries: 3,
      retryDelayMs: 10,
    })
    expect(result.removed).toEqual([first.manifest.generationId])
    expect(attempts).toBe(3)
    expect(delays).toEqual([10, 20])
  })
})
