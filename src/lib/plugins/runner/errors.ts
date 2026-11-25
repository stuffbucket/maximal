export type RunnerUnavailableReason =
  | "not-started"
  | "starting"
  | "backing-off"
  | "circuit-open"
  | "startup-timeout"
  | "heartbeat-lost"
  | "protocol"
  | "crashed"
  | "shutting-down"

export class PluginRunnerUnavailableError extends Error {
  readonly code = "plugin_runner_unavailable"
  readonly reason: RunnerUnavailableReason
  readonly retryAfterMs?: number

  constructor(
    reason: RunnerUnavailableReason,
    message: string,
    options?: { retryAfterMs?: number; cause?: unknown },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = "PluginRunnerUnavailableError"
    this.reason = reason
    this.retryAfterMs = options?.retryAfterMs
  }
}

export class PluginRunnerShutdownError extends Error {
  readonly code = "plugin_runner_shutdown_incomplete"
  readonly budgetMs: number

  constructor(budgetMs: number) {
    super(
      `Plugin runner did not terminate and reap its process tree within ${budgetMs}ms.`,
    )
    this.name = "PluginRunnerShutdownError"
    this.budgetMs = budgetMs
  }
}

export class PluginRunnerIndeterminateError extends Error {
  readonly code = "plugin_runner_indeterminate"
  readonly callId: string

  constructor(
    callId: string,
    message = "The plugin runner exited after dispatch; the outcome is unknown.",
  ) {
    super(message)
    this.name = "PluginRunnerIndeterminateError"
    this.callId = callId
  }
}
