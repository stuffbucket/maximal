import type {
  GenerationSelection,
  RunnerCommandEnvironment,
  RunnerSpawnCommand,
} from "./contracts"

import { encodeGenerationSelection } from "./selection"

export const INTERNAL_PLUGIN_RUNNER_COMMAND = "__plugin-runner"
export const RUNNER_NONCE_ENV = "MAXIMAL_PLUGIN_RUNNER_NONCE"
export const RUNNER_SELECTION_ENV = "MAXIMAL_PLUGIN_RUNNER_SELECTION"
export const RUNNER_PARENT_PID_ENV = "MAXIMAL_PLUGIN_RUNNER_PARENT_PID"

/** Resolve source Bun spawn versus a compiled binary spawning itself. */
export function resolveRunnerCommand(
  environment: RunnerCommandEnvironment,
  nonce: string,
  selection: GenerationSelection,
): RunnerSpawnCommand {
  const args =
    environment.packaged ?
      [INTERNAL_PLUGIN_RUNNER_COMMAND]
    : ["run", environment.sourceEntry, INTERNAL_PLUGIN_RUNNER_COMMAND]
  return Object.freeze({
    executable: environment.executable,
    args,
    cwd: environment.cwd,
    mode: environment.packaged ? "packaged" : "source",
    env: Object.freeze({
      ...environment.baseEnv,
      [RUNNER_NONCE_ENV]: nonce,
      [RUNNER_SELECTION_ENV]: encodeGenerationSelection(selection),
      [RUNNER_PARENT_PID_ENV]: String(process.pid),
    }),
  })
}
