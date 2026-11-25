import type { RunnerProcess } from "~/lib/plugins/runner/contracts"
import type { IpcPort } from "~/lib/plugins/transport/ipc"

function isTransportMessage(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false
  return (
    ("tag" in value && value.tag === "maximal-plugin-handshake")
    || ("protocol" in value
      && "generation" in value
      && "id" in value
      && typeof value.protocol === "number"
      && typeof value.generation === "string"
      && typeof value.id === "string")
  )
}

/** Filter one runner process's shared IPC stream down to transport frames. */
export class RunnerProcessIpcPort implements IpcPort {
  readonly #process: RunnerProcess

  constructor(process: RunnerProcess) {
    this.#process = process
  }

  send(message: unknown): boolean {
    this.#process.sendIpc(message)
    return true
  }

  onMessage(listener: (message: unknown) => void): () => void {
    return this.#process.subscribeIpc((message) => {
      if (isTransportMessage(message)) listener(message)
    })
  }

  onDisconnect(listener: () => void): () => void {
    return this.#process.onIpcClose(listener)
  }
}

class MemoryPort implements IpcPort {
  readonly #messages = new Set<(message: unknown) => void>()
  readonly #disconnects = new Set<() => void>()
  readonly #drains = new Set<() => void>()
  #peer: MemoryPort | undefined
  #closed = false
  #paused = false
  #pending: Array<unknown> = []

  setPeer(peer: MemoryPort): void {
    this.#peer = peer
  }

  send(message: unknown): boolean {
    if (this.#closed || !this.#peer || this.#peer.#closed) {
      throw new Error("In-memory IPC channel is closed.")
    }
    const cloned = structuredClone(message)
    if (this.#peer.#paused) {
      this.#peer.#pending.push(cloned)
      return false
    }
    const peer = this.#peer
    queueMicrotask(() => peer.#deliver(cloned))
    return true
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messages.add(listener)
    return () => this.#messages.delete(listener)
  }

  onDisconnect(listener: () => void): () => void {
    this.#disconnects.add(listener)
    return () => this.#disconnects.delete(listener)
  }

  onDrain(listener: () => void): () => void {
    this.#drains.add(listener)
    return () => this.#drains.delete(listener)
  }

  disconnect(): void {
    if (this.#closed) return
    this.#closed = true
    const peer = this.#peer
    this.#peer = undefined
    for (const listener of this.#disconnects) listener()
    this.#messages.clear()
    this.#disconnects.clear()
    this.#drains.clear()
    if (peer) peer.#peerDisconnected()
  }

  pause(): void {
    this.#paused = true
  }

  resume(): void {
    if (!this.#paused) return
    this.#paused = false
    const pending = this.#pending.splice(0)
    for (const message of pending) queueMicrotask(() => this.#deliver(message))
    const peer = this.#peer
    if (peer) queueMicrotask(() => peer.#notifyDrain())
  }

  inject(message: unknown): void {
    this.#deliver(structuredClone(message))
  }

  #deliver(message: unknown): void {
    if (this.#closed) return
    for (const listener of this.#messages) listener(message)
  }

  #notifyDrain(): void {
    if (this.#closed) return
    for (const listener of this.#drains) listener()
  }

  #peerDisconnected(): void {
    if (this.#closed) return
    this.#closed = true
    for (const listener of this.#disconnects) listener()
    this.#messages.clear()
    this.#disconnects.clear()
    this.#drains.clear()
  }
}

export interface FakeIpcPort extends IpcPort {
  pause(): void
  resume(): void
  inject(message: unknown): void
}

/** Deterministic structured-clone ports used by transport and supervisor tests. */
export function createInMemoryIpcPair(): {
  parent: FakeIpcPort
  runner: FakeIpcPort
} {
  const parent = new MemoryPort()
  const runner = new MemoryPort()
  parent.setPeer(runner)
  runner.setPeer(parent)
  return { parent, runner }
}
