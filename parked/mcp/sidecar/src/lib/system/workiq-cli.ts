/**
 * Microsoft's Work IQ CLI (`workiq`), run by Maximal only for the steps the
 * user asks for in Settings. The commands are a closed set: reading the
 * config is the only one Maximal runs on its own; accepting the EULA,
 * switching to browser sign-in and signing in each run only when the user
 * confirms that step. Nothing here reads Work IQ's token cache or prose:
 * state comes from `workiq config show`'s key=value lines.
 */
import { type ExecFileException, execFile } from "node:child_process"

/** What each command runs. Maximal never builds other arguments. */
export const WORKIQ_COMMAND_ARGS = {
  "config-show": ["config", "show"],
  "accept-eula": ["accept-eula"],
  "use-browser-sign-in": ["config", "set", "disableBrokeredAuth=true"],
  "sign-in": ["auth", "login"],
} as const satisfies Record<string, ReadonlyArray<string>>

export type WorkIqCommand = keyof typeof WORKIQ_COMMAND_ARGS

export interface WorkIqRunResult {
  stdout: string
  stderr: string
  code: number
  /** `exited` covers any exit code; the others mean it didn't finish. */
  outcome: "exited" | "not-found" | "timed-out" | "cancelled"
}

export interface WorkIqRunOptions {
  /** The whole environment the command gets. */
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
}

/** Runs `executable` with one command's arguments. Injectable for tests. */
export type WorkIqRunner = (
  executable: string,
  args: Array<string>,
  options: WorkIqRunOptions,
) => Promise<WorkIqRunResult>

const DEFAULT_TIMEOUT_MS = 15_000

const execRunner: WorkIqRunner = (executable, args, options) =>
  new Promise((resolve) => {
    const child = execFile(
      executable,
      args,
      {
        encoding: "utf8",
        env: options.env ?? {},
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 1_000_000,
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error: ExecFileException | null, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, code: 0, outcome: "exited" })
          return
        }
        if (error.code === "ENOENT") {
          resolve({ stdout, stderr, code: 127, outcome: "not-found" })
          return
        }
        if (options.signal?.aborted) {
          resolve({ stdout, stderr, code: 1, outcome: "cancelled" })
          return
        }
        if (error.killed) {
          resolve({ stdout, stderr, code: 1, outcome: "timed-out" })
          return
        }
        const code = typeof error.code === "number" ? error.code : 1
        resolve({ stdout, stderr, code, outcome: "exited" })
      },
    )
    // Nothing to type: a command that asks for input gets end-of-file
    // instead of waiting out its timeout.
    child.stdin?.end()
  })

/** Run one of the allowed Work IQ commands. Never rejects. */
export function runWorkIq(
  executable: string,
  command: WorkIqCommand,
  {
    run = execRunner,
    ...options
  }: WorkIqRunOptions & {
    run?: WorkIqRunner
  } = {},
): Promise<WorkIqRunResult> {
  return run(executable, [...WORKIQ_COMMAND_ARGS[command]], options).catch(
    (error: unknown) => ({
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: 1,
      outcome: "exited" as const,
    }),
  )
}

export interface WorkIqConfig {
  /** `I-accept-EULA=true`. */
  eulaAccepted: boolean
  /** `defaultAccount` is set: someone signed in on this account before. It
   *  doesn't prove the sign-in still works. */
  signedInBefore: boolean
  /** `disableBrokeredAuth=true`: sign-in uses the browser rather than the
   *  OS sign-in broker. */
  browserSignIn: boolean
}

/** The settings Maximal needs from `workiq config show`'s key=value lines. */
export function parseWorkIqConfig(output: string): WorkIqConfig {
  const values = new Map<string, string>()
  for (const line of output.split(/\r?\n/u)) {
    const equals = line.indexOf("=")
    if (equals <= 0) continue
    const key = line.slice(0, equals).trim()
    if (/^[\w-]+$/u.test(key)) {
      values.set(key.toLowerCase(), line.slice(equals + 1).trim())
    }
  }
  const isTrue = (key: string) => values.get(key)?.toLowerCase() === "true"
  return {
    eulaAccepted: isTrue("i-accept-eula"),
    signedInBefore: (values.get("defaultaccount") ?? "") !== "",
    browserSignIn: isTrue("disablebrokeredauth"),
  }
}

/** Read Work IQ's config. `installed` is false when the executable is gone;
 *  a config that can't be read counts as nothing set. */
export async function readWorkIqConfig(
  executable: string,
  env: Record<string, string>,
  run?: WorkIqRunner,
): Promise<WorkIqConfig & { installed: boolean }> {
  const result = await runWorkIq(executable, "config-show", { env, run })
  if (result.outcome === "not-found") {
    return {
      installed: false,
      eulaAccepted: false,
      signedInBefore: false,
      browserSignIn: false,
    }
  }
  const parsed =
    result.outcome === "exited" && result.code === 0 ?
      parseWorkIqConfig(result.stdout)
    : parseWorkIqConfig("")
  return { installed: true, ...parsed }
}
