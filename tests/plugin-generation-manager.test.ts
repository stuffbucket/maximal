/* eslint-disable max-lines-per-function -- real two-generation child scenarios share fixtures. */
import type { PluginSettings } from "@stuffbucket/maximal-plugin-sdk/gateway"

import {
  createPluginGenerationSelectionToken,
  PluginGenerationRepository,
  preparePluginGeneration,
  type PluginGenerationSelectionToken,
  type PreparedPluginGeneration,
  type ResolvedPlugin,
} from "@stuffbucket/maximal-plugin-loader"
import { ExclusiveResourceLeaseRegistry } from "@stuffbucket/maximal-plugin-sdk"
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { appendFile, chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { GenerationAffinityCoordinator } from "~/lib/plugins/generation-affinity"
import { pluginGenerationLifecycle } from "~/lib/plugins/generation-lifecycle"
import {
  currentPluginGenerationBuild,
  currentPluginGenerationCompatibility,
  selectAvailablePackagedBuiltInGeneration,
} from "~/lib/plugins/generations"
import { startProductionPluginGenerationManager } from "~/lib/plugins/runner/production"
import {
  createPluginStateBroker,
  type StateBrokerFaultPoint,
} from "~/lib/plugins/state-broker"

import {
  activePid,
  alive,
  call,
  cleanupGenerationHarness,
  rejectionOf,
  start,
  text,
  trackManager,
  trackRoot,
  until,
} from "./helpers/plugin-generation-harness"

afterEach(cleanupGenerationHarness)

interface FixtureGeneration {
  readonly token: PluginGenerationSelectionToken
  readonly generation: PreparedPluginGeneration
}

/**
 * A real sealed generation. It serves one server tool and one `decisions`
 * operation that both report the generation's own version; with `exclusive`
 * it also owns a singleton (a lock file naming `version:pid`, stale once that
 * pid is dead, like an OS-released port).
 */
async function versionedGeneration(
  version: string,
  options: { exclusive?: boolean; artifactRoot?: string } = {},
): Promise<FixtureGeneration> {
  const root = await mkdtemp(path.join(os.tmpdir(), "generation-manager-"))
  trackRoot(root)
  const source = path.join(root, "source")
  await mkdir(source)
  const entrypoint = path.join(source, "selected.ts")
  const lifecycle =
    options.exclusive === true ?
      `
    const lock = path.join(process.env.FIXTURE_LOCK_DIR, "lock")
    const tag = ${JSON.stringify(version)} + ":" + process.pid
    const held = () => { try { return fs.readFileSync(lock, "utf8") } catch { return undefined } }
    const bind = () => {
      const current = held()
      if (current !== undefined) {
        const pid = Number(current.split(":")[1])
        let alive = false
        try { process.kill(pid, 0); alive = pid !== process.pid } catch {}
        if (alive) throw new Error("singleton busy: " + current)
      }
      fs.writeFileSync(lock, tag)
    }
    return {
      declaration: { mode: "exclusive", resources: ["fixture:singleton"] },
      prepare() {},
      commit: bind,
      revoke() { if (held() === tag) fs.rmSync(lock) },
      resume: bind,
    }`
    : ""
  await writeFile(
    entrypoint,
    `${options.exclusive === true ? 'import fs from "node:fs"\nimport path from "node:path"\n' : ""}const Config = { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value } } } }
export const plugin = {
  name: "selected",
  manifest: { id: "selected", kind: "model", displayName: "Selected", description: "Fixture plugin.", settingsVersion: 1 },
  inject: ["serverTools", "operations"],
  provides: [],
  Config,
  apply(ctx) {
    ctx.serverTools.register({
      name: "generation_version",
      description: "Reports which generation answered.",
      input_schema: { type: "object", properties: {} },
      render: "hidden",
      offer: "always",
      execute: () => Promise.resolve({ content: [{ type: "text", text: ${JSON.stringify(version)} }] }),
    })
    ctx.operations.register({
      operation: "decisions",
      bindings: [{ model: "fixture-model", provider: "fixture", upstreamModel: "fixture-upstream" }],
      handle: (request) => Promise.resolve({
        json: { version: ${JSON.stringify(version)} },
        usage: {},
        invocationId: request.invocationId,
        providerCallId: request.providerCallId,
        sequence: request.sequence,
      }),
    })${lifecycle}
  },
}
`,
  )
  const plugin: ResolvedPlugin = {
    id: "selected",
    descriptorId: "selected-descriptor",
    provenance: "built-in",
    definedIn: "test",
    descriptor: {
      id: "selected-descriptor",
      provenance: "built-in",
      module: { moduleId: "selected-module", export: "plugin" },
    },
  }
  const generation = await preparePluginGeneration({
    artifactRoot: options.artifactRoot ?? path.join(root, "artifacts"),
    inventory: { plugins: [plugin], sources: [`test-${version}`] },
    enabledPluginIds: ["selected"],
    hostServices: ["serverTools", "operations"],
    build: currentPluginGenerationBuild(),
    targets: [
      {
        moduleId: "selected-module",
        entrypoint,
        metadata: {
          name: "selected",
          inject: ["serverTools", "operations"],
          provides: [],
        },
        trustedRoots: [source, process.cwd()],
      },
    ],
  })
  return {
    generation,
    token: await createPluginGenerationSelectionToken(generation),
  }
}

const slot = (generationId: string) => `${generationId}/runner-generation`

const operationRequest = () => ({
  body: {},
  signal: new AbortController().signal,
  invocationId: `operation-${Math.random()}`,
  providerCallId: `provider-${Math.random()}`,
  sequence: 1,
  origin: { kind: "http" as const, client: "test" },
})

function lockOwner(lock: string): { version: string; pid: number } | undefined {
  if (!existsSync(lock)) return undefined
  const [version, pid] = readFileSync(lock, "utf8").split(":")
  return { version, pid: Number(pid) }
}

describe("production plugin generation manager (real source-mode children)", () => {
  test("holds N for leases, prepared operations and tools, and MCP affinity across cutover; routes new calls to N+1; stops N after release", async () => {
    const v1 = (await versionedGeneration("v1")).token
    const v2 = (await versionedGeneration("v2")).token
    expect(v2.generationId).not.toBe(v1.generationId)
    let selected = v1
    const { manager, lifecycle } = await start({
      select: () => Promise.resolve(selected),
    })
    const { gateway } = manager
    const events: Array<{ type: string; generation: string }> = []
    gateway.subscribe((event) =>
      events.push({
        type: event.type,
        generation: gateway.currentGenerationId(),
      }),
    )
    const globalCutovers: Array<string> = []
    const unsubscribeGlobal = pluginGenerationLifecycle.subscribeCutovers(
      (generationId) => globalCutovers.push(generationId),
    )
    expect(
      String(
        await rejectionOf(
          pluginGenerationLifecycle.releaseUpstreamSession(
            v1.generationId,
            "unregistered-test-session",
            new AbortController().signal,
          ),
        ),
      ),
    ).toContain("unavailable")

    // MCP affinity uses the manager-scoped production lifecycle contract.
    const migrated: Array<string> = []
    const affinity = new GenerationAffinityCoordinator({
      acquireGeneration: () => gateway.acquireGeneration(),
      releaseUpstreamSession: (generationId, sessionId, signal) =>
        lifecycle.releaseUpstreamSession(generationId, sessionId, signal),
      closeDownstream: () => undefined,
      onMigrated: (sessionId) => migrated.push(sessionId),
    })
    const unsubscribe = lifecycle.subscribeCutovers((generationId, deadline) =>
      affinity.cutover(generationId, deadline),
    )

    try {
      // N is active and serves.
      expect(manager.diagnostics().activeGenerationId).toBe(v1.generationId)
      expect(gateway.list()).toMatchObject([
        { id: "selected", lifecycle: "active" },
      ])
      const pidN = activePid(manager)
      expect(alive(pidN)).toBe(true)
      expect(await manager.refresh()).toEqual({
        status: "unchanged",
        generationId: v1.generationId,
      })

      // Everything that can pin N: a lease, a prepared operation, a prepared
      // server tool, and an MCP session call.
      const lease = gateway.acquireGeneration()
      expect(lease.generationId).toBe(v1.generationId)
      const operation = gateway
        .operations()
        .prepare("decisions", "fixture-model")
      if (!operation) throw new Error("Expected a prepared operation on N.")
      const held = await gateway.prepareServerTool(
        "selected",
        "generation_version",
        {},
      )
      const pinned = await affinity.acquire("session-1")
      expect(pinned.generation.generationId).toBe(v1.generationId)

      // Cut over to N+1 while N is pinned.
      selected = v2
      const result = await manager.refresh()
      expect(result).toMatchObject({
        status: "cutover",
        generationId: v2.generationId,
        previousGenerationId: v1.generationId,
        recovered: false,
      })
      expect(gateway.currentGenerationId()).toBe(v2.generationId)
      expect(manager.diagnostics().activeGenerationId).toBe(v2.generationId)
      expect(globalCutovers).not.toContain(v2.generationId)

      // The publication gate: the cutover diff reached observers only after the
      // pointer moved, and nothing from N+1 bypassed the coordinator earlier.
      expect(events.some((event) => event.type === "inventory")).toBe(true)
      expect(
        events.every((event) => event.generation === v1.generationId),
      ).toBe(false)

      // New acquisitions, operations, tools and sessions go to N+1.
      const fresh = gateway.acquireGeneration()
      expect(fresh.generationId).toBe(v2.generationId)
      fresh.release()
      const newOperation = gateway
        .operations()
        .prepare("decisions", "fixture-model")
      expect((await newOperation?.execute(operationRequest()))?.json).toEqual({
        version: "v2",
      })
      newOperation?.release()
      const next = await gateway.prepareServerTool(
        "selected",
        "generation_version",
        {},
      )
      expect(text(await next.execute(call()))).toBe("v2")
      const second = await affinity.acquire("session-2")
      expect(second.generation.generationId).toBe(v2.generationId)
      second.release()
      const session = affinity
        .diagnostics()
        .pinnedSessions.find((entry) => entry.sessionId === "session-1")
      expect(session?.generationId).toBe(v1.generationId)
      expect(session?.activeCalls).toBe(1)

      // N keeps running while anything pins it.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(alive(pidN)).toBe(true)
      const old = manager
        .diagnostics()
        .projected.find((item) => item.generationId === v1.generationId)
      expect(old).toMatchObject({ active: false })
      expect(old?.refs).toBe(4)
      expect(lease.get("selected")?.id).toBe("selected")

      // Release them one at a time; N stays until the last one drains.
      lease.release()
      expect(text(await held.execute(call()))).toBe("v1")
      expect((await operation.execute(operationRequest())).json).toEqual({
        version: "v1",
      })
      operation.release()
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(alive(pidN)).toBe(true)
      expect(migrated).toEqual([])

      // Releasing the session call migrates it: the old upstream session is
      // released through N's registered lifecycle target, then N drains.
      pinned.release()
      await until(() => migrated.includes("session-1"), "session migration")
      await until(() => !alive(pidN), "generation N to stop")
      await gateway.waitForGenerationDisposed(v1.generationId)
      const moved = await affinity.acquire("session-1")
      expect(moved.generation.generationId).toBe(v2.generationId)
      moved.release()
      expect(manager.diagnostics().activeGenerationId).toBe(v2.generationId)
      expect(alive(activePid(manager))).toBe(true)
      const released = lifecycle.releaseUpstreamSession(
        v1.generationId,
        "session",
        new AbortController().signal,
      )
      expect(String(await rejectionOf(released))).toContain("unavailable")
    } finally {
      unsubscribe()
      unsubscribeGlobal()
      await affinity.closeAll()
    }
  }, 90_000)

  test("a pre-durable failure leaves N active; the committed generation is recovered to N+1", async () => {
    const v1 = (await versionedGeneration("v1")).token
    const v2 = (await versionedGeneration("v2")).token
    let selected = v1
    let armed: StateBrokerFaultPoint | undefined
    const { manager, state } = await start({
      select: () => Promise.resolve(selected),
      fault: (point) => {
        if (armed !== point) return
        armed = undefined
        throw new Error(`injected ${point}`)
      },
    })
    const { gateway } = manager
    const pidN = activePid(manager)
    selected = v2

    // The candidate prepares fine, then the durable commit point fails first.
    armed = "before-commit-point"
    expect(String(await rejectionOf(manager.refresh()))).toContain("injected")
    expect(gateway.currentGenerationId()).toBe(v1.generationId)
    expect(manager.diagnostics().activeGenerationId).toBe(v1.generationId)
    expect(alive(pidN)).toBe(true)
    const rejected = manager
      .diagnostics()
      .generations.find((item) => item.generationId === v2.generationId)
    expect(rejected).toMatchObject({ stopped: true, active: false })
    await until(() => !alive(rejected?.pid), "the rejected candidate to exit")
    const prepared = await gateway.prepareServerTool(
      "selected",
      "generation_version",
      {},
    )
    expect(text(await prepared.execute(call()))).toBe("v1")
    expect(await state.committedGeneration()).toBeUndefined()

    // The commit becomes durable but its outcome is reported as a failure.
    armed = "after-commit-point"
    const result = await manager.refresh()
    expect(result).toMatchObject({
      status: "cutover",
      generationId: v2.generationId,
      recovered: true,
    })
    expect(gateway.currentGenerationId()).toBe(v2.generationId)
    const after = await gateway.prepareServerTool(
      "selected",
      "generation_version",
      {},
    )
    expect(text(await after.execute(call()))).toBe("v2")
    await until(() => !alive(pidN), "generation N to stop after recovery")
    expect(alive(activePid(manager))).toBe(true)
    expect(await state.committedGeneration()).toMatchObject({
      generationId: v2.generationId,
      installed: true,
      published: true,
    })
  }, 90_000)

  test("hands an exclusive resource from N to N+1, rolls it back before the durable point, and completes after it", async () => {
    const lockDir = await mkdtemp(path.join(os.tmpdir(), "generation-lock-"))
    trackRoot(lockDir)
    const lock = path.join(lockDir, "lock")
    const v1 = (await versionedGeneration("v1", { exclusive: true })).token
    const v2 = (await versionedGeneration("v2", { exclusive: true })).token
    let selected = v1
    let armed: StateBrokerFaultPoint | undefined
    const { manager } = await start({
      select: () => Promise.resolve(selected),
      env: { FIXTURE_LOCK_DIR: lockDir },
      fault: (point) => {
        if (armed !== point) return
        armed = undefined
        throw new Error(`injected ${point}`)
      },
    })
    const { gateway } = manager
    expect(lockOwner(lock)?.version).toBe("v1")
    const pidN = activePid(manager)
    selected = v2

    // Pre-durable failure: N is restored as the singleton's owner.
    armed = "before-commit-point"
    await rejectionOf(manager.refresh())
    expect(lockOwner(lock)).toEqual({ version: "v1", pid: pidN })
    expect(gateway.currentGenerationId()).toBe(v1.generationId)
    expect(alive(pidN)).toBe(true)

    // Durable commit reached, outcome reported as failed: converge on N+1.
    armed = "after-commit-point"
    const result = await manager.refresh()
    expect(result).toMatchObject({
      status: "cutover",
      generationId: v2.generationId,
    })
    expect(lockOwner(lock)?.version).toBe("v2")
    expect(gateway.currentGenerationId()).toBe(v2.generationId)
    await until(() => !alive(pidN), "generation N to stop")
    expect(lockOwner(lock)).toEqual({
      version: "v2",
      pid: activePid(manager),
    })
  }, 90_000)

  test("revives a crashed active generation, re-binds its exclusive resource, and still cuts over", async () => {
    const lockDir = await mkdtemp(path.join(os.tmpdir(), "generation-lock-"))
    trackRoot(lockDir)
    const lock = path.join(lockDir, "lock")
    const v1 = (await versionedGeneration("v1", { exclusive: true })).token
    const v2 = (await versionedGeneration("v2", { exclusive: true })).token
    let selected = v1
    const { manager } = await start({
      select: () => Promise.resolve(selected),
      env: { FIXTURE_LOCK_DIR: lockDir },
    })
    const { gateway } = manager
    const before = activePid(manager)
    expect(lockOwner(lock)).toEqual({ version: "v1", pid: before })
    const seen: Array<string> = []
    gateway.subscribe((event) => seen.push(event.type))

    process.kill(before, "SIGKILL")
    await until(() => {
      const entry = manager
        .diagnostics()
        .generations.find((item) => item.active)
      return (
        entry?.availability === "active"
        && entry.pid !== undefined
        && entry.pid !== before
      )
    }, "the supervisor to revive the active generation")
    const after = activePid(manager)

    // The revived process owns the singleton the parent lease still covers,
    // the plugin is back, and observers were told once it was ACTIVE.
    expect(lockOwner(lock)).toEqual({ version: "v1", pid: after })
    expect(gateway.list()).toMatchObject([
      { id: "selected", lifecycle: "active" },
    ])
    expect(seen).toContain("inventory")
    const prepared = await gateway.prepareServerTool(
      "selected",
      "generation_version",
      {},
    )
    expect(text(await prepared.execute(call()))).toBe("v1")

    // The parent's lease accounting is intact: the handoff still works.
    selected = v2
    await manager.refresh()
    expect(lockOwner(lock)?.version).toBe("v2")
    await until(() => !alive(after), "the revived generation to stop")
  }, 90_000)

  test("refresh follows the sealed committed generation across successive cutovers and rejects tampering", async () => {
    const artifactRoot = await mkdtemp(
      path.join(os.tmpdir(), "generation-builtins-"),
    )
    trackRoot(artifactRoot)
    const repository = new PluginGenerationRepository({
      artifactRoot,
      commitFile: path.join(artifactRoot, "committed.json"),
      compatibility: currentPluginGenerationCompatibility(),
    })
    const build = async (version: string) => {
      const fixture = await versionedGeneration(version, { artifactRoot })
      await repository.commit(fixture.generation)
      return fixture
    }
    const g1 = await build("v1")
    const { manager } = await start({
      select: () => selectAvailablePackagedBuiltInGeneration([artifactRoot]),
    })
    const { gateway } = manager
    expect(gateway.currentGenerationId()).toBe(g1.token.generationId)
    const first = activePid(manager)

    const g2 = await build("v2")
    expect(await manager.refresh()).toMatchObject({
      status: "cutover",
      generationId: g2.token.generationId,
    })
    expect(await manager.refresh()).toMatchObject({ status: "unchanged" })
    await until(() => !alive(first), "v1 to stop")

    // A second cutover (N+1 -> N+2) after a finished one.
    const second = activePid(manager)
    const g3 = await build("v3")
    expect(await manager.refresh()).toMatchObject({
      status: "cutover",
      generationId: g3.token.generationId,
    })
    const prepared = await gateway.prepareServerTool(
      "selected",
      "generation_version",
      {},
    )
    expect(text(await prepared.execute(call()))).toBe("v3")
    await until(() => !alive(second), "v2 to stop")

    // A committed generation whose bytes changed is never selected.
    const g4 = await build("v4")
    const artifact = path.join(
      g4.generation.directory,
      g4.generation.manifest.modules[0].artifact,
    )
    await chmod(artifact, 0o644)
    await appendFile(artifact, "\n// tampered\n")
    expect(String(await rejectionOf(manager.refresh()))).not.toBe("")
    expect(gateway.currentGenerationId()).toBe(g3.token.generationId)
    expect(alive(activePid(manager))).toBe(true)
  }, 90_000)

  test("keeps serving when startup markers cannot be settled, then settles them on refresh", async () => {
    const v1 = (await versionedGeneration("v1")).token
    const home = await mkdtemp(path.join(os.tmpdir(), "generation-markers-"))
    trackRoot(home)
    let failMarkers = false
    const seeded = createPluginStateBroker(path.join(home, "parent-plugins"), {
      fault: (point) => {
        if (failMarkers && point === "after-commit-point")
          throw new Error("marker write failed")
      },
    })
    // A durable selection of the serving generation that never finished.
    await seeded.commitGeneration({
      commitId: "crashed-commit",
      handoffIdempotencyKey: "crashed-key",
      generationId: v1.generationId,
      inventoryDigest: "digest",
      baseEpoch: 0,
      pluginRevisions: {},
    })
    failMarkers = true
    const manager = await startProductionPluginGenerationManager({
      select: () => Promise.resolve(v1),
      state: seeded,
      command: {
        executable: process.execPath,
        sourceEntry: path.resolve(import.meta.dir, "../src/main.ts"),
        cwd: process.cwd(),
        packaged: false,
        baseEnv: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          COPILOT_API_HOME: path.join(home, "child-app"),
        },
      },
    })
    if (!manager) throw new Error("Expected a generation manager.")
    trackManager(manager)
    expect(manager.diagnostics().unsettledMarkers).toBeDefined()

    failMarkers = false
    expect(await manager.refresh()).toMatchObject({ status: "unchanged" })
    expect(manager.diagnostics().unsettledMarkers).toBeUndefined()
    expect(await seeded.committedGeneration()).toMatchObject({
      installed: true,
      published: true,
    })
  }, 90_000)

  test("leases an initial generation's exclusive resource before the child binds it", async () => {
    const lockDir = await mkdtemp(path.join(os.tmpdir(), "generation-lock-"))
    trackRoot(lockDir)
    const lock = path.join(lockDir, "lock")
    const generation = (
      await versionedGeneration("initial", { exclusive: true })
    ).token
    const leases = new ExclusiveResourceLeaseRegistry()
    leases.acquire("intruder/slot", ["fixture:singleton"])

    const failure = await rejectionOf(
      start({
        select: () => Promise.resolve(generation),
        env: { FIXTURE_LOCK_DIR: lockDir },
        leases,
      }),
    )

    expect(String(failure)).toContain("already leased by intruder/slot")
    expect(lockOwner(lock)).toBeUndefined()
    expect(leases.snapshot()).toEqual({
      "fixture:singleton": "intruder/slot",
    })
  }, 90_000)

  test("an exclusive resource enabled after activation is leased by the parent before it binds, moves with the handoff, and is released when disabled", async () => {
    const lockDir = await mkdtemp(path.join(os.tmpdir(), "generation-lock-"))
    trackRoot(lockDir)
    const lock = path.join(lockDir, "lock")
    const v1 = (await versionedGeneration("v1", { exclusive: true })).token
    const v2 = (await versionedGeneration("v2", { exclusive: true })).token
    let selected = v1
    const leases = new ExclusiveResourceLeaseRegistry()
    // Disabled at activation: the generation starts with no exclusive resource.
    const settings: PluginSettings = {}
    const { manager } = await start({
      select: () => Promise.resolve(selected),
      env: { FIXTURE_LOCK_DIR: lockDir },
      settings,
      leases,
    })
    const { gateway } = manager
    expect(lockOwner(lock)).toBeUndefined()
    expect(manager.diagnostics().resourceLeases).toEqual({})

    // Another owner holds the singleton: enabling the plugin must fail at the
    // parent lease, before anything binds in the child.
    leases.acquire("intruder/slot", ["fixture:singleton"])
    settings.selected = { enabled: true }
    const busy = await rejectionOf(gateway.reconcile(settings))
    expect(String(busy)).toContain("already leased by intruder/slot")
    expect(lockOwner(lock)).toBeUndefined()
    expect(manager.diagnostics().resourceLeases).toEqual({
      "fixture:singleton": "intruder/slot",
    })

    // Once free, the same command leases it for N and only then binds it.
    leases.release("intruder/slot")
    await gateway.reconcile(settings)
    const pidN = activePid(manager)
    expect(lockOwner(lock)).toEqual({ version: "v1", pid: pidN })
    expect(manager.diagnostics().resourceLeases).toEqual({
      "fixture:singleton": slot(v1.generationId),
    })
    expect(() => leases.acquire("other/slot", ["fixture:singleton"])).toThrow(
      "already leased",
    )

    // A settings import restarts the slot without changing its declaration. The
    // parent already owns the lease, but must still tell the new child slot to
    // commit its physical singleton.
    expect(
      await gateway.importLegacyConfig("selected", { imported: true }),
    ).toBe(true)
    expect(lockOwner(lock)).toEqual({ version: "v1", pid: pidN })
    expect(manager.diagnostics().resourceLeases).toEqual({
      "fixture:singleton": slot(v1.generationId),
    })

    // The late resource participates in N -> N+1: no overlap, lease moves.
    selected = v2
    await manager.refresh()
    expect(lockOwner(lock)).toEqual({ version: "v2", pid: activePid(manager) })
    expect(manager.diagnostics().resourceLeases).toEqual({
      "fixture:singleton": slot(v2.generationId),
    })
    await until(() => !alive(pidN), "generation N to stop")

    // Disabling releases both the physical resource and the parent lease; a
    // later enable binds it again under a fresh lease.
    settings.selected = { enabled: false }
    await gateway.reconcile(settings)
    expect(lockOwner(lock)).toBeUndefined()
    expect(manager.diagnostics().resourceLeases).toEqual({})
    settings.selected = { enabled: true }
    await gateway.reconcile(settings)
    expect(lockOwner(lock)?.version).toBe("v2")
    expect(manager.diagnostics().resourceLeases).toEqual({
      "fixture:singleton": slot(v2.generationId),
    })
  }, 90_000)
})
