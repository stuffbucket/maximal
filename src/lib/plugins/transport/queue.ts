export type TransportPriority = "control" | "interactive" | "bulk"

export interface QueueLimits {
  maxMessages: number
  maxBytes: number
}

interface QueueEntry<T> {
  value: T
  bytes: number
  resolve: () => void
  reject: (error: Error) => void
}

const PRIORITIES: ReadonlyArray<TransportPriority> = [
  "control",
  "interactive",
  "bulk",
]

const DEFAULT_WEIGHTS: Readonly<Record<TransportPriority, number>> = {
  control: 8,
  interactive: 4,
  bulk: 1,
}

export class QueueOverflowError extends Error {
  constructor(message = "Transport queue limit exceeded.") {
    super(message)
    this.name = "QueueOverflowError"
  }
}

/** A bounded weighted round-robin queue. Every non-empty class gets service. */
export class FairBoundedQueue<T> {
  readonly #limits: QueueLimits
  readonly #weights: Readonly<Record<TransportPriority, number>>
  readonly #queues: Record<TransportPriority, Array<QueueEntry<T>>> = {
    control: [],
    interactive: [],
    bulk: [],
  }
  #messages = 0
  #bytes = 0
  #priorityIndex = 0
  #remainingWeight: number
  #closedError: Error | undefined

  constructor(
    limits: QueueLimits,
    weights: Readonly<Record<TransportPriority, number>> = DEFAULT_WEIGHTS,
  ) {
    if (
      !Number.isSafeInteger(limits.maxMessages)
      || !Number.isSafeInteger(limits.maxBytes)
      || limits.maxMessages < 1
      || limits.maxBytes < 1
    ) {
      throw new RangeError("Queue limits must be positive.")
    }
    this.#limits = limits
    this.#weights = weights
    this.#remainingWeight = weights[PRIORITIES[0]]
  }

  get size(): number {
    return this.#messages
  }

  get bytes(): number {
    return this.#bytes
  }

  enqueue(value: T, bytes: number, priority: TransportPriority): Promise<void> {
    if (this.#closedError) return Promise.reject(this.#closedError)
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      return Promise.reject(
        new RangeError("Queue byte size must be non-negative."),
      )
    }
    if (
      this.#messages + 1 > this.#limits.maxMessages
      || this.#bytes + bytes > this.#limits.maxBytes
    ) {
      return Promise.reject(new QueueOverflowError())
    }
    return new Promise<void>((resolve, reject) => {
      this.#queues[priority].push({ value, bytes, resolve, reject })
      this.#messages += 1
      this.#bytes += bytes
    })
  }

  shift():
    | { value: T; delivered: () => void; failed: (error: Error) => void }
    | undefined {
    if (this.#messages === 0) return undefined
    let attempts = 0
    while (attempts < PRIORITIES.length * 2) {
      const priority = PRIORITIES[this.#priorityIndex]
      const queue = this.#queues[priority]
      if (queue.length > 0 && this.#remainingWeight > 0) {
        const entry = queue.shift()
        if (!entry) return undefined
        this.#remainingWeight -= 1
        this.#messages -= 1
        this.#bytes -= entry.bytes
        if (this.#remainingWeight === 0) this.#advancePriority()
        return {
          value: entry.value,
          delivered: entry.resolve,
          failed: entry.reject,
        }
      }
      this.#advancePriority()
      attempts += 1
    }
    return undefined
  }

  close(error: Error): void {
    if (this.#closedError) return
    this.#closedError = error
    for (const priority of PRIORITIES) {
      for (const entry of this.#queues[priority].splice(0)) entry.reject(error)
    }
    this.#messages = 0
    this.#bytes = 0
  }

  #advancePriority(): void {
    this.#priorityIndex = (this.#priorityIndex + 1) % PRIORITIES.length
    this.#remainingWeight = this.#weights[PRIORITIES[this.#priorityIndex]]
  }
}
