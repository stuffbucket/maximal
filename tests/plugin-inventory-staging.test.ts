import type { PluginModule } from "@stuffbucket/maximal-plugin-host"

import {
  PluginGenerationRepository,
  preparePluginGeneration,
} from "@stuffbucket/maximal-plugin-loader"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { trustedInventoryContext } from "~/lib/plugins/compose"
import {
  currentPluginGenerationBuild,
  currentPluginGenerationCompatibility,
  selectAvailablePackagedBuiltInGeneration,
} from "~/lib/plugins/generations"
import { createInventorySelector } from "~/lib/plugins/runner/inventory-staging"
import { createPluginStateBroker } from "~/lib/plugins/state-broker"

import {
  alive,
  activePid,
  call,
  cleanupGenerationHarness,
  start,
  tempRoot,
  text,
  until,
} from "./helpers/plugin-generation-harness"

afterEach(cleanupGenerationHarness)

/** Trusted built-in stand-ins: the parent only reads their static exports. */
function trusted(name: string): PluginModule {
  return {
    name,
    manifest: {
      id: name,
      kind: "model",
      displayName: name,
      description: `${name} fixture`,
      settingsVersion: 1,
    },
    inject: ["serverTools"],
    provides: [],
    Config: {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: (value: unknown) => ({ value }),
      },
    },
    apply: () => undefined,
  } as unknown as PluginModule
}

/** The packaged (namespace-style) module bytes for one built-in. */
function moduleSource(name: string): string {
  return `const Config = { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value } } } }
export const name = ${JSON.stringify(name)}
export const manifest = { id: ${JSON.stringify(name)}, kind: "model", displayName: ${JSON.stringify(name)}, description: "fixture", settingsVersion: 1 }
export const inject = ["serverTools"]
export const provides = []
export { Config }
export function apply(ctx) {
  ctx.serverTools.register({
    name: ${JSON.stringify(`${name}_tool`)},
    description: "fixture",
    input_schema: { type: "object", properties: {} },
    render: "hidden",
    offer: "always",
    execute: () => Promise.resolve({ content: [{ type: "text", text: ${JSON.stringify(name)} }] }),
  })
}
`
}

/** A packaged superset (alpha + beta) committed under a temp built-ins root. */
async function packagedSuperset() {
  const context = trustedInventoryContext([
    { descriptorId: "alpha", module: trusted("alpha") },
    { descriptorId: "beta", module: trusted("beta") },
  ])
  const root = await tempRoot("inventory-staging-")
  const packaged = path.join(root, "plugin-builtins")
  const source = path.join(root, "source")
  await mkdir(source, { recursive: true })
  const targets = await Promise.all(
    ["alpha", "beta"].map(async (name) => {
      const entrypoint = path.join(source, `${name}.ts`)
      await writeFile(entrypoint, moduleSource(name))
      return {
        moduleId: name,
        entrypoint,
        metadata: { name, inject: ["serverTools"], provides: [] },
        trustedRoots: [source, process.cwd()],
      }
    }),
  )
  const superset = await preparePluginGeneration({
    artifactRoot: packaged,
    inventory: context.defaultInventory,
    enabledPluginIds: ["alpha", "beta"],
    hostServices: ["serverTools"],
    build: currentPluginGenerationBuild(),
    targets,
  })
  await new PluginGenerationRepository({
    artifactRoot: packaged,
    commitFile: path.join(packaged, "committed.json"),
    compatibility: currentPluginGenerationCompatibility(),
  }).commit(superset)
  const appDirectory = path.join(root, "app")
  await mkdir(appDirectory, { recursive: true })
  await writeFile(
    path.join(appDirectory, "inventory.json"),
    JSON.stringify({
      $schema: "maximal-plugin-inventory/1",
      plugins: [{ id: "alpha", descriptorId: "alpha" }],
      members: [{ plugin: "alpha" }],
    }),
  )
  return { context, root, packaged, superset, appDirectory }
}

describe("config-driven inventory staging for managed generations", () => {
  test("a configured inventory stages a sealed generation and cuts N over to N+1, and back", async () => {
    const { context, root, packaged, superset, appDirectory } =
      await packagedSuperset()
    let configured: { entry: string } | undefined
    const warnings: Array<string> = []
    const select = createInventorySelector({
      context,
      base: () => selectAvailablePackagedBuiltInGeneration([packaged]),
      stagingRoot: path.join(root, "staged"),
      configured: () => configured,
      rootDirectory: appDirectory,
      log: (message) => warnings.push(message),
    })

    const { manager } = await start({
      select,
      settings: { alpha: { enabled: true }, beta: { enabled: true } },
    })
    const { gateway } = manager
    expect(gateway.currentGenerationId()).toBe(superset.manifest.generationId)
    expect(gateway.list().map((plugin) => plugin.id)).toEqual(["alpha", "beta"])
    const first = activePid(manager)

    // Selecting only alpha through the inventory file stages and cuts over.
    await writeFile(
      path.join(appDirectory, "inventory.json"),
      JSON.stringify({
        $schema: "maximal-plugin-inventory/1",
        plugins: [{ id: "alpha", descriptorId: "alpha" }],
        members: [{ plugin: "alpha" }],
      }),
    )
    configured = { entry: "inventory.json" }
    const result = await manager.refresh()
    expect(result).toMatchObject({ status: "cutover", recovered: false })
    expect(result.status === "cutover" && result.generationId).not.toBe(
      superset.manifest.generationId,
    )
    expect(gateway.list().map((plugin) => plugin.id)).toEqual(["alpha"])
    const prepared = await gateway.prepareServerTool("alpha", "alpha_tool", {})
    expect(text(await prepared.execute(call()))).toBe("alpha")
    await until(() => !alive(first), "the packaged generation to stop")
    expect(await manager.refresh()).toMatchObject({ status: "unchanged" })

    // An unreadable inventory keeps what is serving.
    await writeFile(path.join(appDirectory, "inventory.json"), "{ not json")
    expect(await manager.refresh()).toMatchObject({ status: "unchanged" })
    expect(warnings.length).toBeGreaterThan(0)
    expect(gateway.list().map((plugin) => plugin.id)).toEqual(["alpha"])

    // Dropping the override returns to the packaged generation (N+1 -> N+2).
    configured = undefined
    const back = await manager.refresh()
    expect(back).toMatchObject({
      status: "cutover",
      generationId: superset.manifest.generationId,
    })
    expect(gateway.list().map((plugin) => plugin.id)).toEqual(["alpha", "beta"])
  }, 120_000)

  test("an unreadable inventory after a parent restart keeps the durably committed staged generation", async () => {
    const { context, root, packaged, superset, appDirectory } =
      await packagedSuperset()
    const stagingRoot = path.join(root, "staged")
    const state = createPluginStateBroker(path.join(root, "parent-plugins"))
    const committed = async () => {
      const record = await state.committedGeneration()
      if (!record) return undefined
      const selection = record.generationRecord as
        | { artifactId?: string }
        | undefined
      return {
        generationId: record.generationId,
        ...(selection?.artifactId === undefined ?
          {}
        : { artifactId: selection.artifactId }),
      }
    }
    const selector = () =>
      createInventorySelector({
        context,
        base: () => selectAvailablePackagedBuiltInGeneration([packaged]),
        stagingRoot,
        configured: () => ({ entry: "inventory.json" }),
        rootDirectory: appDirectory,
        committed,
      })

    // Before this process ever staged anything: no memory, packaged wins.
    const broken = path.join(appDirectory, "inventory.json")
    const valid = await Bun.file(broken).text()
    await writeFile(broken, "{ not json")
    expect((await selector()())?.generationId).toBe(
      superset.manifest.generationId,
    )

    // Stage alpha-only and commit it durably, as a finished cutover would.
    await writeFile(broken, valid)
    // One selector, two overlapping selections: they share one staging.
    const shared = selector()
    const [first, second] = await Promise.all([shared(), shared()])
    const staged = first
    expect(staged?.generationId).not.toBe(superset.manifest.generationId)
    expect(second?.generationId).toBe(staged?.generationId)
    await state.commitGeneration({
      commitId: "commit",
      handoffIdempotencyKey: "key",
      generationId: staged?.generationId ?? "",
      inventoryDigest: "digest",
      baseEpoch: 0,
      pluginRevisions: {},
      generationRecord: { artifactId: staged?.manifestSha256 },
    })

    // A "restarted" parent (fresh selector) with an unreadable inventory keeps
    // the committed staged generation instead of reverting to the packaged one.
    await writeFile(broken, "{ not json")
    const recovered = await selector()()
    expect(recovered?.generationId).toBe(staged?.generationId)
    expect(recovered?.manifestSha256).toBe(staged?.manifestSha256)

    // A committed generation this parent cannot verify is never trusted.
    await rm(path.join(stagingRoot, staged?.generationId ?? ""), {
      recursive: true,
      force: true,
    })
    expect((await selector()())?.generationId).toBe(
      superset.manifest.generationId,
    )
  }, 60_000)
})
