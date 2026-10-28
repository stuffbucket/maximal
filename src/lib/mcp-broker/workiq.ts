/**
 * Work IQ (`@microsoft/workiq`) as a brokered endpoint: where its setup
 * stands, and the steps the user can take from Settings to finish it
 * (accept Microsoft's EULA, sign in). Maximal runs a Work IQ command only
 * when the user confirms that step; on its own it only reads
 * `workiq config show`.
 *
 * Whether sign-in actually works is judged by what the server offers: Work
 * IQ always lists a few local tools, and lists its Microsoft 365 tools
 * (`fetch`, `get_schema`, `search_paths`, …) only once it has a working
 * sign-in. The broker records the tools each endpoint listed when it
 * started, so after a sign-in Maximal restarts the broker to look again.
 *
 * Until its setup is done (installed, terms accepted, signed in at least
 * once), a Work IQ endpoint is held back from the broker even while it is
 * on (`holdBackWorkIqUntilSetUp`): on Windows, `workiq mcp` opens
 * Microsoft's sign-in window by itself as soon as it starts, outside the
 * steps the card walks through.
 */

import type { McpServerConfig } from "~/lib/config/config"
import type {
  WorkIqSignIn,
  WorkIqState,
  WorkIqStatus,
} from "~/lib/config/settings-types"

import {
  readWorkIqConfig,
  runWorkIq,
  type WorkIqCommand,
  type WorkIqRunner,
} from "~/lib/system/workiq-cli"

import type { McpBrokerConfig } from "./types"

import {
  brokerProcessEnvironment,
  resolveBrokerConfiguration,
} from "./configuration"
import { brokerStderrLog, type ServerProblemLine } from "./server-log"
import {
  type BrokerReadiness,
  type BrokerSupervisorState,
  getBrokerEndpointTools,
  getBrokerSupervisorSnapshot,
  reconfigureBrokerAfter,
  restartBroker,
  waitForBrokerReady,
} from "./supervisor"

/** The tools Work IQ lists before anyone signs in. */
const LOCAL_TOOLS = new Set(["accept_eula", "ask", "list_agents"])

/** `auth login` waits for the user in the browser. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000
const COMMAND_TIMEOUT_MS = 30_000
/** After signing in, how long to wait for Work IQ to come back. Its
 *  startup timeout is 30s. */
const RESTART_WAIT_MS = 45_000

/** Desktop-session variables a browser sign-in needs on Linux. Names only;
 *  none of them is a credential. */
const DESKTOP_SESSION = [
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "LANG",
  "TMPDIR",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
]

export function isWorkIqEndpoint(server: McpServerConfig): boolean {
  return server.catalog === "workiq"
}

/** Where Work IQ is, from its config and what the running broker saw. */
export function workIqState(input: {
  installed: boolean
  eulaAccepted: boolean
  signedInBefore: boolean
  brokerReady: boolean
  tools: ReadonlyArray<string> | undefined
}): WorkIqState {
  if (!input.installed) return "not-installed"
  if (!input.eulaAccepted) return "eula-needed"
  if (!input.signedInBefore) return "signin-needed"
  if (!input.brokerReady || input.tools === undefined) return "starting"
  return input.tools.some((tool) => !LOCAL_TOOLS.has(tool)) ?
      "ready"
    : "consent-needed"
}

export interface WorkIqDeps {
  run?: WorkIqRunner
  restartBroker?: () => Promise<boolean>
  waitForBroker?: (timeoutMs: number) => Promise<BrokerReadiness>
  brokerState?: () => BrokerSupervisorState
  endpointTools?: (id: string) => ReadonlyArray<string> | undefined
  log?: {
    lastProblem(id: string): ServerProblemLine | undefined
    forget(id: string): void
  }
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

interface SignInJob {
  state: WorkIqSignIn
  controller: AbortController
  /** What Work IQ said when the sign-in failed. */
  problem: string | null
}

/** The last non-blank line of a command's output. */
function lastLine(text: string): string | null {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.at(-1)?.slice(0, 500) ?? null
}

export class WorkIq {
  readonly #deps: Required<Omit<WorkIqDeps, "run">>
  /** Undefined runs the real `workiq`. */
  readonly #runner: WorkIqRunner | undefined
  readonly #signIns = new Map<string, SignInJob>()
  /** Per endpoint: whether its setup was done when its config was last
   *  read. Not read yet counts as not done. */
  readonly #setUp = new Map<string, boolean>()

  constructor(deps: WorkIqDeps = {}) {
    this.#runner = deps.run
    this.#deps = {
      restartBroker: deps.restartBroker ?? restartBroker,
      waitForBroker: deps.waitForBroker ?? waitForBrokerReady,
      brokerState:
        deps.brokerState ?? (() => getBrokerSupervisorSnapshot().state),
      endpointTools: deps.endpointTools ?? getBrokerEndpointTools,
      log: deps.log ?? brokerStderrLog,
      platform: deps.platform ?? process.platform,
      env: deps.env ?? process.env,
    }
  }

  /**
   * The environment Work IQ commands run with: the one the broker gives
   * the server (its allowlist, never Maximal's own credentials), plus the
   * desktop session a browser sign-in needs.
   */
  #environment(server: McpServerConfig): Record<string, string> {
    const source = this.#deps.env
    let endpoint: Record<string, string> = {}
    try {
      endpoint =
        resolveBrokerConfiguration(
          { servers: [{ ...server, enabled: true }] },
          source,
        ).endpoints[0]?.environment ?? {}
    } catch {
      // A secret reference that can't be resolved: the baseline will do.
    }
    const session = Object.fromEntries(
      DESKTOP_SESSION.flatMap((name) => {
        const value = source[name]
        return value === undefined ? [] : [[name, value]]
      }),
    )
    return { ...brokerProcessEnvironment(source), ...session, ...endpoint }
  }

  #run(
    server: McpServerConfig,
    command: WorkIqCommand,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ) {
    return runWorkIq(server.transport.command, command, {
      env: this.#environment(server),
      ...(this.#runner ? { run: this.#runner } : {}),
      ...options,
    })
  }

  async #readConfig(server: McpServerConfig) {
    const config = await readWorkIqConfig(
      server.transport.command,
      this.#environment(server),
      this.#runner,
    )
    this.#setUp.set(
      server.id,
      config.installed && config.eulaAccepted && config.signedInBefore,
    )
    return config
  }

  /** Whether the endpoint's setup was done when its config was last read
   *  (by `checkSetup`, `status`, or a step). False until then. */
  isSetUp(id: string): boolean {
    return this.#setUp.get(id) === true
  }

  /** Read the endpoint's config again; whether its setup is done. */
  async checkSetup(server: McpServerConfig): Promise<boolean> {
    await this.#readConfig(server)
    return this.isSetUp(server.id)
  }

  async status(server: McpServerConfig): Promise<WorkIqStatus> {
    const config = await this.#readConfig(server)
    const job = this.#signIns.get(server.id)
    return {
      state: workIqState({
        ...config,
        brokerReady: this.#deps.brokerState() === "ready",
        tools: this.#deps.endpointTools(server.id),
      }),
      eulaAccepted: config.eulaAccepted,
      signedInBefore: config.signedInBefore,
      browserSignIn: config.browserSignIn,
      macos: this.#deps.platform === "darwin",
      signIn: job?.state ?? "idle",
      lastProblem:
        job?.problem ?? this.#deps.log.lastProblem(server.id)?.line ?? null,
    }
  }

  /** Run `workiq accept-eula`. Only on the user's explicit request. */
  async acceptEula(
    server: McpServerConfig,
  ): Promise<{ ok: true } | { ok: false; problem: string | null }> {
    const result = await this.#run(server, "accept-eula", {
      timeoutMs: COMMAND_TIMEOUT_MS,
    })
    const config = await this.#readConfig(server)
    if (
      result.outcome !== "exited"
      || result.code !== 0
      || !config.eulaAccepted
    ) {
      return { ok: false, problem: lastLine(result.stderr || result.stdout) }
    }
    // A sign-in from before can work now; let the broker look again.
    if (config.signedInBefore) {
      this.#deps.log.forget(server.id)
      await this.#deps.restartBroker()
    }
    return { ok: true }
  }

  /**
   * Start `workiq auth login` (it opens the browser) in the background;
   * the status reports how it goes. With `useBrowserSignIn`, the user
   * chose to switch Work IQ to browser sign-in first. A sign-in already
   * running is left alone.
   */
  startSignIn(
    server: McpServerConfig,
    options: { useBrowserSignIn: boolean },
  ): { started: boolean; finished: Promise<void> } {
    const running = this.#signIns.get(server.id)
    if (running?.state === "waiting" || running?.state === "restarting") {
      return { started: false, finished: Promise.resolve() }
    }
    const job: SignInJob = {
      state: "waiting",
      controller: new AbortController(),
      problem: null,
    }
    this.#signIns.set(server.id, job)
    this.#deps.log.forget(server.id)
    return { started: true, finished: this.#signIn(server, job, options) }
  }

  async #signIn(
    server: McpServerConfig,
    job: SignInJob,
    options: { useBrowserSignIn: boolean },
  ): Promise<void> {
    const settle = (state: WorkIqSignIn, output = "") => {
      job.state = state
      job.problem = state === "failed" ? lastLine(output) : null
    }
    try {
      if (options.useBrowserSignIn) {
        const switched = await this.#run(server, "use-browser-sign-in", {
          timeoutMs: COMMAND_TIMEOUT_MS,
        })
        if (switched.outcome !== "exited" || switched.code !== 0) {
          settle("failed", switched.stderr || switched.stdout)
          return
        }
      }
      const result = await this.#run(server, "sign-in", {
        timeoutMs: SIGN_IN_TIMEOUT_MS,
        signal: job.controller.signal,
      })
      if (result.outcome === "cancelled" || job.controller.signal.aborted) {
        settle("cancelled")
        return
      }
      if (result.outcome === "timed-out") {
        settle("timed-out")
        return
      }
      const config = await this.#readConfig(server)
      if (result.code !== 0 || !config.signedInBefore) {
        settle("failed", result.stderr || result.stdout)
        return
      }
      // Work IQ lists its Microsoft 365 tools when it starts, so the broker
      // has to start it again to see whether the sign-in works.
      settle("restarting")
      await this.#deps.restartBroker()
      await this.#deps.waitForBroker(RESTART_WAIT_MS)
      settle("idle")
    } catch (error) {
      settle("failed", error instanceof Error ? error.message : String(error))
    }
  }

  /** Stop a sign-in that's waiting. False when none is. */
  cancelSignIn(id: string): boolean {
    const job = this.#signIns.get(id)
    if (job?.state !== "waiting") return false
    job.controller.abort()
    return true
  }
}

export const workIq = new WorkIq()

const heldBack = (server: McpServerConfig, workiq: WorkIq): boolean =>
  isWorkIqEndpoint(server)
  && server.enabled !== false
  && !workiq.isSetUp(server.id)

/**
 * What the broker gets of `config`: each Work IQ endpoint that is on but
 * whose setup isn't done (or hasn't been read yet) is turned off in the
 * broker's copy, so `workiq mcp` doesn't start. The saved config is
 * unchanged. Registered with `setBrokerConfigFilter` at startup.
 */
export function holdBackWorkIqUntilSetUp(
  config: McpBrokerConfig,
  workiq: WorkIq = workIq,
): McpBrokerConfig {
  const servers = config.servers ?? []
  if (!servers.some((server) => heldBack(server, workiq))) return config
  return {
    ...config,
    servers: servers.map((server) =>
      heldBack(server, workiq) ? { ...server, enabled: false } : server,
    ),
  }
}

/** Whether `server` is on but held back until its setup is done. */
export function isHeldBackFromBroker(
  server: McpServerConfig,
  workiq: WorkIq = workIq,
): boolean {
  return heldBack(server, workiq)
}

/**
 * Reconfigure the broker after reading each Work IQ endpoint's setup
 * again, so one set up meanwhile (or outside Maximal) starts and one that
 * isn't stays held back. A config that can't be read counts as not set up.
 */
export function reconfigureBrokerAfterSetupCheck(
  config: McpBrokerConfig,
  workiq: WorkIq = workIq,
): Promise<boolean> {
  return reconfigureBrokerAfter(async () => {
    await Promise.all(
      (config.servers ?? [])
        .filter(
          (server) => isWorkIqEndpoint(server) && server.enabled !== false,
        )
        .map((server) => workiq.checkSetup(server).catch(() => false)),
    )
    return config
  })
}

/** Endpoint views, each Work IQ endpoint that is on with its status. */
export async function withWorkIqStatus<
  T extends { id: string; enabled: boolean },
>(
  endpoints: Array<T>,
  servers: ReadonlyArray<McpServerConfig>,
  workiq: WorkIq = workIq,
): Promise<Array<T & { workiq?: WorkIqStatus }>> {
  return Promise.all(
    endpoints.map(async (endpoint) => {
      const server = servers.find((candidate) => candidate.id === endpoint.id)
      if (!endpoint.enabled || !server || !isWorkIqEndpoint(server)) {
        return endpoint
      }
      return { ...endpoint, workiq: await workiq.status(server) }
    }),
  )
}
