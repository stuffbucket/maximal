import type {
  PluginLogger,
  PluginStatus,
  PluginStatusAction,
  ToolCallContext,
  ToolDefinition,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk"

import type {
  TextStore,
  TokenProvider,
  WorkIqAccount,
} from "./auth/token-provider"
import type { UpstreamTool } from "./upstream/connection"

import { TERMS_URL } from "./config"
import { isAbort, toWorkIqError, WorkIqError } from "./errors"
import { mirrorTools } from "./tools"

/** Storage file recording that the user accepted Microsoft's Work IQ terms. */
export const TERMS_FILE = "terms.json"

/** `PluginStatus.code` values this plugin reports. */
export const STATUS_CODES = {
  termsNeeded: "terms-needed",
  signinNeeded: "signin-needed",
  working: "working",
  ready: "ready",
  error: "error",
} as const

/** Surface action ids this plugin registers. */
export const ACTION_IDS = {
  acceptTerms: "accept-terms",
  signIn: "sign-in",
  signOut: "sign-out",
  retry: "retry",
} as const

/** What the controller needs from the tool catalogue (`listTools` / `callTool` on the upstream pool). */
export interface Upstream {
  listTools(signal?: AbortSignal): Promise<Array<UpstreamTool>>
  callTool(
    name: string,
    input: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult>
  closeAll(): Promise<void>
}

export interface ControllerOptions {
  setStatus(status: PluginStatus): void
  /** Atomically replace the plugin's tool set (`ctx.tools.registerAll`). */
  setTools(tools: Array<ToolDefinition>): void
  storage: TextStore
  tokens: TokenProvider
  upstream: Upstream
  logger: PluginLogger
  endpoint: string
  /** Shown in the sign-in status ("times out after N minutes"). */
  signInTimeoutMs: number
}

type Phase =
  | "starting"
  | "terms"
  | "signin"
  | "signing-in"
  | "connecting"
  | "ready"
  | "error"

interface Operation {
  readonly signal: AbortSignal
  current(): boolean
}

const SIGN_OUT: PluginStatusAction = {
  id: ACTION_IDS.signOut,
  label: "Sign out",
  kind: "destructive",
  confirm:
    "Sign out of Work IQ? Its tools stay unavailable until you sign in again.",
}

/**
 * The Work IQ setup state machine:
 * `terms-needed → signin-needed → working → ready`, with `error` for
 * consent, licence and connectivity problems. Owns the long-running
 * operations (sign-in, connect, tool refresh); a newer operation supersedes
 * an older one, and everything stops when the plugin unloads.
 */
export class WorkIqController {
  readonly #options: ControllerOptions
  readonly #lifetime = new AbortController()
  #op: AbortController | undefined
  #generation = 0
  #phase: Phase = "starting"
  #account: WorkIqAccount | undefined
  #toolCount = 0

  constructor(options: ControllerOptions) {
    this.#options = options
  }

  get phase(): Phase {
    return this.#phase
  }

  /** Show a status right away and check terms/sign-in in the background. */
  start(): void {
    this.#show("starting", {
      state: "working",
      code: STATUS_CODES.working,
      summary: "Starting Work IQ…",
    })
    void this.#boot()
  }

  /** Stop everything (plugin unload). Idempotent. */
  dispose(): void {
    this.#lifetime.abort(new Error("Work IQ plugin stopped."))
    this.#op?.abort()
  }

  async acceptTerms(signal?: AbortSignal): Promise<void> {
    const op = this.#begin(signal)
    try {
      await this.#options.storage.writeText(
        TERMS_FILE,
        `${JSON.stringify({ accepted: true, acceptedAt: new Date().toISOString(), terms: TERMS_URL })}\n`,
      )
      const account = await this.#options.tokens.account()
      if (!op.current()) return
      if (account) await this.#connect(op)
      else this.#showSignin()
    } catch (error) {
      this.#fail(op, error)
    }
  }

  async signIn(signal?: AbortSignal): Promise<void> {
    const op = this.#begin(signal)
    try {
      if (!(await this.#termsAccepted())) {
        if (op.current()) this.#showTerms()
        return
      }
      this.#clearTools()
      const minutes = Math.max(
        1,
        Math.round(this.#options.signInTimeoutMs / 60_000),
      )
      this.#show("signing-in", {
        state: "working",
        code: STATUS_CODES.working,
        summary: "Waiting for sign-in in your browser",
        detail: `Finish signing in with your work or school account in the browser window that opened. Sign-in times out after ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        actions: [
          { id: ACTION_IDS.signOut, label: "Cancel", kind: "secondary" },
        ],
      })
      const account = await this.#options.tokens.signIn(op.signal)
      if (!op.current()) return
      this.#account = account
      await this.#connect(op)
    } catch (error) {
      this.#fail(op, error)
    }
  }

  async signOut(): Promise<void> {
    const op = this.#begin()
    this.#clearTools()
    this.#account = undefined
    await this.#options.upstream.closeAll().catch(() => {})
    try {
      await this.#options.tokens.signOut()
    } catch (error) {
      this.#options.logger.warn(
        `Sign-out could not clear the token cache: ${toWorkIqError(error).message}`,
      )
    }
    if (!op.current()) return
    if (await this.#termsAccepted()) this.#showSignin()
    else this.#showTerms()
  }

  async retry(signal?: AbortSignal): Promise<void> {
    const op = this.#begin(signal)
    await this.#boot(op)
  }

  /** Upstream announced a new tool list. */
  async refreshTools(): Promise<void> {
    if (this.#phase !== "ready") return
    const generation = this.#generation
    try {
      const tools = await this.#options.upstream.listTools(
        this.#lifetime.signal,
      )
      if (
        generation !== this.#generation
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the phase can change during the await; TS narrows it to "ready" from the guard above
        || this.#phase !== "ready"
        || this.#lifetime.signal.aborted
      )
        return
      this.#publishTools(tools)
      this.#showReady()
    } catch (error) {
      if (isAbort(error, this.#lifetime.signal)) return
      const failure = toWorkIqError(error, this.#options.endpoint)
      if (failure.accountLevel) this.#fail(this.#begin(), failure)
      else
        this.#options.logger.warn(
          `Could not refresh Work IQ tools: ${failure.message}`,
        )
    }
  }

  /** `execute` of every mirrored tool. */
  async callTool(
    name: string,
    input: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult> {
    try {
      return await this.#options.upstream.callTool(name, input, call)
    } catch (error) {
      if (isAbort(error, call.signal)) throw error
      const failure = toWorkIqError(error, this.#options.endpoint)
      if (failure.accountLevel && this.#phase === "ready")
        this.#fail(this.#begin(), failure)
      return {
        isError: true,
        content: [{ type: "text", text: failure.message }],
      }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  #begin(external?: AbortSignal): Operation {
    this.#op?.abort()
    const controller = new AbortController()
    this.#op = controller
    const generation = ++this.#generation
    const signals = [
      controller.signal,
      this.#lifetime.signal,
      ...(external ? [external] : []),
    ]
    return {
      signal: AbortSignal.any(signals),
      current: () =>
        generation === this.#generation && !this.#lifetime.signal.aborted,
    }
  }

  async #boot(op: Operation = this.#begin()): Promise<void> {
    try {
      if (!(await this.#termsAccepted())) {
        if (op.current()) this.#showTerms()
        return
      }
      const account = await this.#options.tokens.account()
      if (!op.current()) return
      if (!account) {
        this.#showSignin()
        return
      }
      this.#account = account
      await this.#connect(op)
    } catch (error) {
      this.#fail(op, error)
    }
  }

  async #connect(op: Operation): Promise<void> {
    this.#show("connecting", {
      state: "working",
      code: STATUS_CODES.working,
      summary: "Connecting to Work IQ…",
    })
    // Silent token check first: an expired sign-in is `signin-needed`, not a connection error.
    await this.#options.tokens.getToken(op.signal)
    // Fresh upstream sessions for the (possibly new) identity.
    await this.#options.upstream.closeAll()
    const tools = await this.#options.upstream.listTools(op.signal)
    const account = this.#account ?? (await this.#options.tokens.account())
    if (!op.current()) return
    this.#account = account
    this.#publishTools(tools)
    this.#showReady()
  }

  #fail(op: Operation, error: unknown): void {
    if (!op.current()) return
    // Superseded operations and unloads return above; an abort that is still
    // current came from the action's caller.
    const failure: WorkIqError =
      isAbort(error, op.signal) ?
        new WorkIqError(
          this.#phase === "signing-in" ? "sign-in-cancelled" : "upstream",
          this.#phase === "signing-in" ?
            "Sign-in was cancelled."
          : "Connecting to Work IQ was cancelled.",
        )
      : toWorkIqError(error, this.#options.endpoint)
    this.#options.logger.warn(`Work IQ: ${failure.message}`)
    this.#clearTools()
    switch (failure.code) {
      case "signed-out": {
        this.#account = undefined
        this.#showSignin(failure.message)
        return
      }
      case "sign-in-cancelled":
      case "sign-in-timeout": {
        this.#showSignin(failure.message)
        return
      }
      default: {
        this.#showError(failure)
      }
    }
  }

  async #termsAccepted(): Promise<boolean> {
    const text = await this.#options.storage.readText(TERMS_FILE)
    if (!text) return false
    try {
      return (JSON.parse(text) as { accepted?: unknown }).accepted === true
    } catch {
      return false
    }
  }

  #publishTools(tools: ReadonlyArray<UpstreamTool>): void {
    if (this.#lifetime.signal.aborted) return
    const definitions = mirrorTools(
      tools,
      (name, input, call) => this.callTool(name, input, call),
      this.#options.logger,
    )
    this.#options.setTools(definitions)
    this.#toolCount = definitions.length
  }

  #clearTools(): void {
    if (this.#lifetime.signal.aborted || this.#toolCount === 0) return
    this.#options.setTools([])
    this.#toolCount = 0
  }

  #show(phase: Phase, status: PluginStatus): void {
    if (this.#lifetime.signal.aborted) return
    this.#phase = phase
    this.#options.setStatus(status)
  }

  #showTerms(): void {
    this.#show("terms", {
      state: "needs-setup",
      code: STATUS_CODES.termsNeeded,
      summary: "Accept the Microsoft Work IQ terms to continue",
      detail: `Work IQ is a Microsoft service that answers questions from your Microsoft 365 data. Review its terms at ${TERMS_URL} before you continue.`,
      actions: [
        { id: ACTION_IDS.acceptTerms, label: "Accept terms", kind: "primary" },
      ],
    })
  }

  #showSignin(detail?: string): void {
    this.#show("signin", {
      state: "needs-setup",
      code: STATUS_CODES.signinNeeded,
      summary: "Sign in with your work or school account",
      ...(detail ? { detail } : {}),
      actions: [{ id: ACTION_IDS.signIn, label: "Sign in", kind: "primary" }],
    })
  }

  #facts(): Array<{ label: string; value: string }> {
    const facts: Array<{ label: string; value: string }> = []
    if (this.#account)
      facts.push({ label: "Account", value: this.#account.username })
    if (this.#account?.tenantId)
      facts.push({ label: "Tenant", value: this.#account.tenantId })
    return facts
  }

  #showReady(): void {
    this.#show("ready", {
      state: "ready",
      code: STATUS_CODES.ready,
      summary:
        this.#account ? `Connected as ${this.#account.username}` : "Connected",
      facts: [
        ...this.#facts(),
        { label: "Tools", value: String(this.#toolCount) },
      ],
      actions: [SIGN_OUT],
    })
  }

  #showError(failure: WorkIqError): void {
    const actions: Array<PluginStatusAction> = [
      { id: ACTION_IDS.retry, label: "Try again", kind: "primary" },
    ]
    if (failure.accountLevel)
      actions.push({
        id: ACTION_IDS.signIn,
        label: "Sign in with another account",
        kind: "secondary",
      })
    actions.push(SIGN_OUT)
    const facts = this.#facts()
    this.#show("error", {
      state: "error",
      code: STATUS_CODES.error,
      summary: failure.message,
      detail: `Reason: ${failure.code}${failure.status ? ` (HTTP ${failure.status})` : ""}.`,
      ...(facts.length > 0 ? { facts } : {}),
      actions,
    })
  }
}
