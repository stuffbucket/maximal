import type {
  GenerationSelection,
  GenerationVerifier,
  RunnerChannel,
  RunnerInventoryComposer,
  RunnerInventoryRoot,
} from "./contracts"

import { RUNNER_API_VERSION, RUNNER_PROTOCOL_VERSION } from "./contracts"
import { parseParentMessage } from "./messages"
import { RunnerStateMachine } from "./state-machine"

const HEARTBEAT_INTERVAL_MS = 1_000

export interface PluginRunnerOptions {
  readonly nonce: string
  readonly selection: GenerationSelection
  readonly channel: RunnerChannel
  readonly verifier: GenerationVerifier
  readonly composer: RunnerInventoryComposer
  readonly heartbeatIntervalMs?: number
  readonly parentDisconnectDrainMs?: number
  readonly parentDeathDeadlineMs?: number
  readonly hardExit?: (code: number) => void
  readonly monotonicNow?: () => number
}

function sameIdentity(
  selection: GenerationSelection,
  root: Awaited<ReturnType<RunnerInventoryRoot["prepare"]>>,
): boolean {
  return (
    root.generationId === selection.token.generationId
    && root.manifestSha256 === selection.token.manifestSha256
    && root.inventoryDigest === selection.inventoryDigest
    && root.controlEpoch === selection.controlEpoch
  )
}

/** Child-side authenticated runner lifecycle, independent of its transport. */
// eslint-disable-next-line max-lines-per-function -- lifecycle resources share one ownership scope.
export async function runPluginRunner(
  options: PluginRunnerOptions,
): Promise<void> {
  const { selection } = options
  const machine = new RunnerStateMachine()
  const parentAbort = new AbortController()
  const now = options.monotonicNow ?? (() => performance.now())
  let root: RunnerInventoryRoot | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let parentDeathTimer: ReturnType<typeof setTimeout> | undefined
  let inflight = 0
  let finishing = false
  let disposal: Promise<void> | undefined
  let resolveCompletion: (() => void) | undefined
  let rejectCompletion: ((error: unknown) => void) | undefined
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })

  const sendState = (
    state: Parameters<RunnerStateMachine["transition"]>[0],
    prepared?: Awaited<ReturnType<RunnerInventoryRoot["prepare"]>>,
  ): void => {
    machine.transition(state)
    options.channel.send({
      type: "runner.state",
      state,
      ...(prepared === undefined ? {} : { prepared }),
    })
  }
  const stopHeartbeat = (): void => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = undefined
  }
  const disposeRoot = (): Promise<void> => {
    if (!root) return Promise.resolve()
    disposal ??= root.dispose()
    return disposal
  }
  const finish = async (reason: string): Promise<void> => {
    if (finishing) return
    finishing = true
    stopHeartbeat()
    try {
      const needsDrain = machine.state === "active"
      if (needsDrain) sendState("draining")
      if (needsDrain) {
        const drainMs = options.parentDisconnectDrainMs ?? 1_000
        await root?.drain(Date.now() + drainMs)
      }
      if (machine.state === "draining") sendState("stopping")
      await disposeRoot()
      if (machine.state === "stopping") sendState("stopped")
      resolveCompletion?.()
    } catch (error) {
      rejectCompletion?.(
        new Error(`Runner shutdown failed (${reason}).`, { cause: error }),
      )
    }
  }

  let queue = Promise.resolve()
  const unsubscribe = options.channel.subscribe((raw) => {
    queue = queue
      // Lifecycle commands deliberately share one serialized discriminated handler.
      // eslint-disable-next-line complexity
      .then(async () => {
        const message = parseParentMessage(raw)
        if (message.type === "supervisor.accept") {
          if (message.nonce !== options.nonce || machine.state !== "spawned")
            throw new Error("Supervisor handshake is invalid.")
          sendState("negotiated")
          sendState("preparing")
          // The Phase 4 verifier hashes and imports the exact selected modules;
          // composition follows immediately and receives those canonical objects.
          const verified = await options.verifier.reverifyImmediatelyBeforeLoad(
            selection,
            parentAbort.signal,
          )
          parentAbort.signal.throwIfAborted()
          root = await options.composer.compose(
            verified,
            selection,
            parentAbort.signal,
          )
          try {
            parentAbort.signal.throwIfAborted()
          } catch (error) {
            await disposeRoot()
            throw error
          }
          const prepared = await root.prepare()
          if (
            !sameIdentity(selection, prepared)
            || prepared.inventoryDigest
              !== verified.prepared.manifest.inventoryDigest
            || !prepared.complete
          ) {
            throw new Error(
              "Prepared runner snapshot does not match the selected generation.",
            )
          }
          sendState("prepared", prepared)
          return
        }
        if (message.type === "supervisor.activate") {
          if (!root || machine.state !== "prepared")
            throw new Error("Runner cannot activate in its current state.")
          sendState("committing")
          await root.activate()
          sendState("active")
          heartbeat = setInterval(() => {
            options.channel.send({
              type: "runner.heartbeat",
              monotonicMs: now(),
              inflight,
            })
          }, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS)
          heartbeat.unref()
          return
        }
        if (message.type === "supervisor.dispatch") {
          if (!root || machine.state !== "active")
            throw new Error("Runner is not active.")
          inflight += 1
          try {
            if (!root.dispatch)
              throw new Error("Runner transport dispatch is not installed.")
            const value = await root.dispatch(message.method, message.params)
            options.channel.send({
              type: "runner.result",
              callId: message.callId,
              value,
            })
          } catch (error) {
            options.channel.send({
              type: "runner.result",
              callId: message.callId,
              error: {
                code: "runner_dispatch_failed",
                message: error instanceof Error ? error.message : String(error),
              },
            })
          } finally {
            inflight -= 1
          }
          return
        }
        if (message.type === "supervisor.cancel") return
        if (message.type === "supervisor.drain") {
          if (!root || machine.state !== "active")
            throw new Error("Runner cannot drain in its current state.")
          sendState("draining")
          stopHeartbeat()
          await root.drain(message.deadlineMs)
          options.channel.send({ type: "runner.drained" })
          return
        }
        await finish(message.reason)
      })
      .catch((error: unknown) => {
        rejectCompletion?.(error)
      })
  })
  const unsubscribeClose = options.channel.onClose(() => {
    parentAbort.abort(new Error("Plugin runner parent disconnected."))
    stopHeartbeat()
    if (!parentDeathTimer) {
      parentDeathTimer = setTimeout(() => {
        options.hardExit?.(1)
      }, options.parentDeathDeadlineMs ?? 1_000)
      parentDeathTimer.unref()
    }
    // Do not wait behind prepare/dispatch: parent death owns an independent
    // abort and hard-exit deadline. The queue checks the signal before publish.
    void finish("parent disconnected")
  })

  options.channel.send({
    type: "runner.hello",
    nonce: options.nonce,
    protocol: RUNNER_PROTOCOL_VERSION,
    pluginApi: RUNNER_API_VERSION,
    generationId: selection.token.generationId,
    manifestSha256: selection.token.manifestSha256,
    selectionSeal: selection.token.seal,
  })

  try {
    await completion
    await queue
  } finally {
    unsubscribe()
    unsubscribeClose()
    stopHeartbeat()
    if (parentDeathTimer) clearTimeout(parentDeathTimer)
    await disposeRoot()
  }
}
