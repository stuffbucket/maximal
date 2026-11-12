import type { RunnerLifecycleState } from "./contracts"

const ALLOWED_TRANSITIONS: Readonly<
  Record<RunnerLifecycleState, ReadonlySet<RunnerLifecycleState>>
> = {
  spawned: new Set(["negotiated"]),
  negotiated: new Set(["preparing"]),
  preparing: new Set(["prepared"]),
  prepared: new Set(["committing"]),
  committing: new Set(["active"]),
  active: new Set(["draining"]),
  draining: new Set(["stopping"]),
  stopping: new Set(["stopped"]),
  stopped: new Set(),
}

export class IllegalRunnerStateTransitionError extends Error {
  readonly from: RunnerLifecycleState
  readonly to: RunnerLifecycleState

  constructor(from: RunnerLifecycleState, to: RunnerLifecycleState) {
    super(`Illegal runner state transition: ${from} -> ${to}.`)
    this.name = "IllegalRunnerStateTransitionError"
    this.from = from
    this.to = to
  }
}

/** Generic generation process state machine shared with Phase 5 cutover. */
export class RunnerStateMachine {
  #state: RunnerLifecycleState = "spawned"

  get state(): RunnerLifecycleState {
    return this.#state
  }

  transition(next: RunnerLifecycleState): void {
    if (!ALLOWED_TRANSITIONS[this.#state].has(next)) {
      throw new IllegalRunnerStateTransitionError(this.#state, next)
    }
    this.#state = next
  }
}
