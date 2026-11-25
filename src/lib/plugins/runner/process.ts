import { access } from "node:fs/promises"
import path from "node:path"

import type {
  RunnerChannel,
  RunnerChannelFactory,
  RunnerContainmentHooks,
  RunnerProcess,
  RunnerProcessExit,
  RunnerProcessSpawner,
  RunnerSpawnCommand,
} from "./contracts"

function isRunnerLifecycleMessage(value: unknown): boolean {
  return (
    value !== null
    && typeof value === "object"
    && "type" in value
    && typeof value.type === "string"
    && value.type.startsWith("runner.")
  )
}

class ProcessRunnerChannel implements RunnerChannel {
  readonly #process: RunnerProcess

  constructor(process: RunnerProcess) {
    this.#process = process
  }

  send(message: Parameters<RunnerChannel["send"]>[0]): void {
    this.#process.sendIpc(message)
  }

  subscribe(listener: (message: unknown) => void): () => void {
    return this.#process.subscribeIpc((message) => {
      if (isRunnerLifecycleMessage(message)) listener(message)
    })
  }

  onClose(listener: () => void): () => void {
    return this.#process.onIpcClose(listener)
  }

  close(): void {
    // The owning process controls the IPC lifetime. Production Bun has no
    // half-close primitive, so this intentionally only stops local listeners.
  }
}

export const processRunnerChannelFactory: RunnerChannelFactory = Object.freeze({
  open: (process: RunnerProcess) => new ProcessRunnerChannel(process),
})

class BunRunnerProcess implements RunnerProcess {
  readonly #child: ReturnType<typeof Bun.spawn>
  readonly #messageListeners = new Set<(message: unknown) => void>()
  readonly #closeListeners = new Set<() => void>()
  readonly #pendingMessages: Array<unknown> = []
  #pendingFlushScheduled = false
  #closed = false
  #treeTermination: Promise<void> | undefined

  constructor(child: ReturnType<typeof Bun.spawn>) {
    this.#child = child
    void child.exited.finally(() => this.#close())
  }

  get pid(): number {
    return this.#child.pid
  }

  deliver(message: unknown): void {
    if (this.#messageListeners.size === 0) {
      this.#pendingMessages.push(message)
      return
    }
    for (const listener of this.#messageListeners) listener(message)
  }

  sendIpc(message: unknown): void {
    this.#child.send(message)
  }

  subscribeIpc(listener: (message: unknown) => void): () => void {
    this.#messageListeners.add(listener)
    if (this.#pendingMessages.length > 0 && !this.#pendingFlushScheduled) {
      this.#pendingFlushScheduled = true
      queueMicrotask(() => {
        this.#pendingFlushScheduled = false
        const pending = this.#pendingMessages.splice(0)
        for (const message of pending)
          for (const subscribed of this.#messageListeners) subscribed(message)
      })
    }
    return () => this.#messageListeners.delete(listener)
  }

  onIpcClose(listener: () => void): () => void {
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
    // taskkill must capture the live root before its direct handle is killed.
    if (signal === "SIGKILL" && process.platform === "win32")
      void this.terminateTree().catch(() => {
        // The supervisor awaits and reports the same shared failure.
      })
    this.#child.kill(signal)
  }

  terminateTree(): Promise<void> {
    this.#treeTermination ??= terminateWindowsTree(this.pid)
    return this.#treeTermination
  }

  async wait(): Promise<RunnerProcessExit> {
    const code = await this.#child.exited
    return {
      code,
      signal: this.#child.signalCode ?? null,
    }
  }

  #close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const listener of this.#closeListeners) listener()
    this.#closeListeners.clear()
    this.#messageListeners.clear()
  }
}

function taskkillPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
  if (!systemRoot)
    throw new Error("Windows process-tree containment requires SystemRoot.")
  return path.join(systemRoot, "System32", "taskkill.exe")
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

async function terminateWindowsTree(pid: number): Promise<void> {
  const child = Bun.spawn({
    cmd: [taskkillPath(), "/PID", String(pid), "/T", "/F"],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  const code = await child.exited
  // taskkill returns 128 when the process tree has already disappeared.
  if (code !== 0 && code !== 128)
    throw new Error(
      `Could not terminate runner process tree (taskkill ${code}).`,
    )
}

/** Mandatory production ownership for the runner and every descendant. */
export const runnerProcessContainment: RunnerContainmentHooks = Object.freeze({
  async attach(child: RunnerProcess) {
    if (process.platform === "win32") {
      await access(taskkillPath())
      return
    }
    if (!processGroupExists(child.pid))
      throw new Error("Runner process group was not established.")
  },
  async terminateDescendants(child: RunnerProcess) {
    if (process.platform === "win32") {
      await (child instanceof BunRunnerProcess ?
        child.terminateTree()
      : terminateWindowsTree(child.pid))
      return
    }
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  },
  reaped(child: RunnerProcess) {
    if (process.platform !== "win32" && processGroupExists(child.pid))
      throw new Error("Runner process group still has live descendants.")
  },
})

export class BunRunnerProcessSpawner implements RunnerProcessSpawner {
  spawn(command: RunnerSpawnCommand): Promise<RunnerProcess> {
    const receiver: { process?: BunRunnerProcess; pending: Array<unknown> } = {
      pending: [],
    }
    const child = Bun.spawn({
      cmd: [command.executable, ...command.args],
      cwd: command.cwd,
      env: command.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      // A distinct POSIX process group / Windows process tree is mandatory so
      // runner restarts cannot orphan plugin descendants.
      detached: true,
      ipc(message) {
        if (receiver.process) receiver.process.deliver(message)
        else receiver.pending.push(message)
      },
    })
    const process = new BunRunnerProcess(child)
    receiver.process = process
    for (const message of receiver.pending) process.deliver(message)
    receiver.pending.length = 0
    return Promise.resolve(process)
  }
}
