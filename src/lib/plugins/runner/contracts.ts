import type {
  PluginGenerationSelectionToken,
  PreparedPluginGeneration,
} from "@stuffbucket/maximal-plugin-loader"
import type { JsonValue } from "@stuffbucket/maximal-plugin-protocol"

import {
  PLUGIN_API_VERSION,
  PLUGIN_RUNNER_PROTOCOL_VERSION,
} from "@stuffbucket/maximal-plugin-loader"

export const RUNNER_PROTOCOL_VERSION = PLUGIN_RUNNER_PROTOCOL_VERSION
export const RUNNER_API_VERSION = PLUGIN_API_VERSION

export type RunnerLifecycleState =
  | "spawned"
  | "negotiated"
  | "preparing"
  | "prepared"
  | "committing"
  | "active"
  | "draining"
  | "stopping"
  | "stopped"

/** Phase 4 owns the sealed token; Phase 2 supplies only the authority epoch. */
export interface GenerationSelection {
  readonly token: PluginGenerationSelectionToken
  readonly controlEpoch: number
  readonly inventoryDigest: string
}

export type RunnerHealthClassification =
  | "healthy"
  | "needs-setup"
  | "signed-out"
  | "existing-failure"
  | "waiting-dependency"
  | "regression"
  | "host-failure"

export interface RunnerHealthEntry {
  readonly pluginId: string
  readonly classification: RunnerHealthClassification
  readonly detail?: string
}

export interface PreparedRunnerSnapshot {
  readonly complete: boolean
  readonly revision: number
  readonly controlEpoch: number
  readonly generationId: string
  readonly manifestSha256: string
  readonly inventoryDigest: string
  readonly health: ReadonlyArray<RunnerHealthEntry>
  readonly snapshot: JsonValue
}

export interface VerifiedRunnerGeneration {
  readonly prepared: PreparedPluginGeneration
  /** Canonical module objects imported by the Phase 4 reverifier. */
  readonly modules: ReadonlyArray<unknown>
}

/** Exact Phase 4 child-side verification seam; no parallel token format. */
export interface GenerationVerifier {
  reverifyImmediatelyBeforeLoad(
    selection: GenerationSelection,
    signal: AbortSignal,
  ): Promise<VerifiedRunnerGeneration>
}

/** One object represents the one Cordis root for the whole selected inventory. */
export interface RunnerInventoryRoot {
  prepare(): Promise<PreparedRunnerSnapshot>
  activate(): Promise<void>
  /** Temporary narrow command seam; Phase 3 transport supplies the full RPC. */
  dispatch?(method: string, params: JsonValue): Promise<JsonValue>
  drain(deadlineMs: number): Promise<void>
  dispose(): Promise<void>
}

/** Phase 2 brokers can supply host/settings/provider services to compose later. */
export interface RunnerInventoryComposer {
  compose(
    generation: VerifiedRunnerGeneration,
    selection: GenerationSelection,
    signal: AbortSignal,
  ): Promise<RunnerInventoryRoot>
}

export type RunnerToParentMessage =
  | {
      readonly type: "runner.hello"
      readonly nonce: string
      readonly protocol: string
      readonly pluginApi: string
      readonly generationId: string
      readonly manifestSha256: string
      readonly selectionSeal: string
    }
  | {
      readonly type: "runner.state"
      readonly state: RunnerLifecycleState
      readonly prepared?: PreparedRunnerSnapshot
    }
  | {
      readonly type: "runner.heartbeat"
      readonly monotonicMs: number
      readonly inflight: number
    }
  | { readonly type: "runner.drained" }
  | {
      readonly type: "runner.result"
      readonly callId: string
      readonly value?: JsonValue
      readonly error?: {
        readonly code: string
        readonly message: string
        readonly indeterminate?: boolean
      }
    }

export type ParentToRunnerMessage =
  | {
      readonly type: "supervisor.accept"
      readonly nonce: string
      readonly protocol: typeof RUNNER_PROTOCOL_VERSION
      readonly pluginApi: typeof RUNNER_API_VERSION
    }
  | { readonly type: "supervisor.activate" }
  | {
      readonly type: "supervisor.drain"
      readonly deadlineMs: number
      readonly reason: string
    }
  | {
      readonly type: "supervisor.shutdown"
      readonly graceful: boolean
      readonly reason: string
    }
  | {
      readonly type: "supervisor.dispatch"
      readonly callId: string
      readonly method: string
      readonly params: JsonValue
    }
  | {
      readonly type: "supervisor.cancel"
      readonly callId: string
      readonly reason: string
    }

export interface RunnerChannel {
  send(message: ParentToRunnerMessage | RunnerToParentMessage): void
  subscribe(listener: (message: unknown) => void): () => void
  onClose(listener: () => void): () => void
  close(): void
}

export interface RunnerProcessExit {
  readonly code: number | null
  readonly signal: string | null
}

export interface RunnerProcess {
  readonly pid: number
  sendIpc(message: unknown): void
  subscribeIpc(listener: (message: unknown) => void): () => void
  onIpcClose(listener: () => void): () => void
  kill(signal?: "SIGTERM" | "SIGKILL"): void
  wait(): Promise<RunnerProcessExit>
}

export interface RunnerProcessSpawner {
  spawn(command: RunnerSpawnCommand): Promise<RunnerProcess>
}

export interface RunnerChannelFactory {
  open(process: RunnerProcess): RunnerChannel
}

export interface RunnerSpawnCommand {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly mode: "source" | "packaged"
}

/** Tauri containment is inherited. Platform-specific owners can add hooks here. */
export interface RunnerContainmentHooks {
  attach(process: RunnerProcess): Promise<void> | void
  terminateDescendants(process: RunnerProcess): Promise<void> | void
  reaped(process: RunnerProcess): Promise<void> | void
}

export interface RunnerStateAuthority {
  currentControlEpoch(): number
  validatePrepared(snapshot: PreparedRunnerSnapshot): Promise<void> | void
  /** Initial one-runner install only. Phase 5 replaces this with atomic cutover. */
  installInitial(snapshot: PreparedRunnerSnapshot): Promise<void> | void
  /**
   * Awaited when a runner reports ACTIVE, before the supervisor itself becomes
   * available or its startup resolves. A throw fails that runner. Used to
   * confirm the process owns the resources the parent's lease already covers.
   */
  activated?(): Promise<void> | void
}

export interface RunnerScheduler {
  now(): number
  setTimeout(callback: () => void, delayMs: number): () => void
}

export interface RunnerCommandEnvironment {
  readonly executable: string
  readonly sourceEntry: string
  readonly cwd: string
  readonly packaged: boolean
  readonly baseEnv?: Readonly<Record<string, string>>
}
