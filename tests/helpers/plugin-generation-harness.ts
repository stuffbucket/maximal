import type { ExclusiveResourceLeaseRegistry } from "@stuffbucket/maximal-plugin-sdk"
import type { PluginSettings } from "@stuffbucket/maximal-plugin-sdk/gateway"

import { type PluginGenerationSelectionToken } from "@stuffbucket/maximal-plugin-loader"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { ProductionPluginGenerationManager } from "~/lib/plugins/runner/generation-manager"

import { PluginGenerationLifecycleRegistry } from "~/lib/plugins/generation-lifecycle"
import { startProductionPluginGenerationManager } from "~/lib/plugins/runner/production"
import {
  createPluginStateBroker,
  type PluginStateBroker,
  type PluginStateBrokerOptions,
  type StateBrokerFaultPoint,
} from "~/lib/plugins/state-broker"

/** Shared harness for tests that run real source-mode plugin generation children. */

export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected promise to reject.")
}

const roots = new Set<string>()
const managers = new Set<ProductionPluginGenerationManager>()

/** Track a temp directory for removal by `cleanupGenerationHarness`. */
export function trackRoot(root: string): string {
  roots.add(root)
  return root
}

export function trackManager(manager: ProductionPluginGenerationManager): void {
  managers.add(manager)
}

/** Register with `afterEach`. */
export async function cleanupGenerationHarness(): Promise<void> {
  for (const manager of managers) {
    await manager.gateway.dispose().catch(() => undefined)
  }
  managers.clear()
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  )
  roots.clear()
}

export async function tempRoot(prefix: string): Promise<string> {
  return trackRoot(await mkdtemp(path.join(os.tmpdir(), prefix)))
}

export const call = () => {
  const invocationId = `invocation-${Math.random()}`
  let sequence = 0
  return {
    signal: new AbortController().signal,
    model: "claude-sonnet-4.6",
    client: "claude-code",
    invocationId,
    nextProviderCall: (
      operation:
        | "systemone"
        | "decisions"
        | "images.generations"
        | "images.edits",
      model: string,
    ) => ({
      invocationId,
      providerCallId: `${invocationId}-${sequence + 1}`,
      sequence: ++sequence,
      operation,
      model,
    }),
  }
}

export function text(result: {
  content: Array<{ type: string; text?: string }>
}) {
  return result.content.map((block) => block.text).join("")
}

export function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function until(
  condition: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}.`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

export async function start(options: {
  select: () => Promise<PluginGenerationSelectionToken | undefined>
  fault?: (point: StateBrokerFaultPoint) => void
  env?: Record<string, string>
  /** Plugin settings every generation starts from (default: `selected` on). */
  settings?: PluginSettings
  leases?: ExclusiveResourceLeaseRegistry
}): Promise<{
  manager: ProductionPluginGenerationManager
  state: PluginStateBroker
  lifecycle: PluginGenerationLifecycleRegistry
}> {
  const home = await mkdtemp(path.join(os.tmpdir(), "generation-manager-home-"))
  trackRoot(home)
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  const brokerOptions: PluginStateBrokerOptions = {}
  if (options.fault) brokerOptions.fault = options.fault
  const state = createPluginStateBroker(
    path.join(home, "parent-plugins"),
    brokerOptions,
  )
  const lifecycle = new PluginGenerationLifecycleRegistry()
  const manager = await startProductionPluginGenerationManager({
    select: options.select,
    state,
    lifecycle,
    ...(options.leases === undefined ? {} : { leases: options.leases }),
    command: {
      executable: process.execPath,
      sourceEntry: path.resolve(import.meta.dir, "../../src/main.ts"),
      cwd: process.cwd(),
      packaged: false,
      baseEnv: {
        ...baseEnv,
        ...options.env,
        COPILOT_API_HOME: path.join(home, "child-app"),
      },
    },
    desiredSettings: () => options.settings ?? { selected: { enabled: true } },
    cutover: { operationTimeoutMs: 20_000, drainWaitMs: 200 },
  })
  if (!manager) throw new Error("Expected a generation manager.")
  trackManager(manager)
  await manager.gateway.reconcile(
    options.settings ?? { selected: { enabled: true } },
  )
  return { manager, state, lifecycle }
}

export function activePid(manager: ProductionPluginGenerationManager): number {
  const entry = manager.diagnostics().generations.find((item) => item.active)
  if (entry?.pid === undefined) throw new Error("No active runner pid.")
  return entry.pid
}
