import type {
  PluginLogger,
  PluginStatus,
  PluginStatusAction,
  ToolCallContext,
  ToolDefinition,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk"

import type {
  ConnectorAccount,
  TextStore,
  TokenProvider,
} from "./auth/token-provider"
import type { ConnectorTermsManifest } from "./manifest"
import type { NegotiatedProtocol, UpstreamTool } from "./upstream/connection"

import { ConnectorError, isAbort } from "./errors"
import { mirrorTools } from "./tools"

/** Storage file recording that the user accepted the connector's terms (url + time). */
export const TERMS_FILE = "terms.json"

/** `PluginStatus.code` values a connector reports. */
export const STATUS_CODES = {
  termsNeeded: "terms-needed",
  signinNeeded: "signin-needed",
  working: "working",
  ready: "ready",
  error: "error",
} as const

/** Surface action ids a connector registers. */
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

/** Status wording that depends on the connector and its sign-in strategy. */
export interface ControllerWording {
  /** `terms-needed` summary (default "Accept the <name> terms to continue"). */
  termsSummary?: string
  /** `terms-needed` detail (default names the terms URL). */
  termsDetail?: string
  /** `signin-needed` summary (default "Sign in to <name>"). */
  signInPrompt?: string
  /** Detail while the browser sign-in is pending. */
  signInWaiting?: string
}

export interface ControllerOptions {
  /** Connector display name used in statuses. */
  name: string
  setStatus(status: PluginStatus): void
  /** Atomically replace the plugin's tool set (`ctx.tools.registerAll`). */
  setTools(tools: Array<ToolDefinition>): void
  storage: TextStore
  tokens: TokenProvider
  /** `false` for connectors without sign-in (`auth.type: "none"`). */
  interactive: boolean
  /** Terms gate; absent ⇒ no `terms-needed` step. */
  terms?: ConnectorTermsManifest
  upstream: Upstream
  /** Protocol negotiated by the most recent upstream connection. */
  protocol?(): NegotiatedProtocol | undefined
  logger: PluginLogger
  /** Classify a failure with the connector's wording. */
  toError(error: unknown): ConnectorError
  /** The per-call "your organization's policy doesn't allow this" failure. */
  policyDenied(failure: ConnectorError): ConnectorError
  /** Shown in the sign-in status ("times out after N minutes"). */
  signInTimeoutMs: number
  wording?: ControllerWording
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

/**
 * The connector setup state machine:
 * `terms-needed → signin-needed → working → ready`, with `error` for
 * consent, licence and connectivity problems. The terms step exists only
 * when the manifest names terms, the sign-in step only for interactive
 * strategies. Owns the long-running operations (sign-in, connect, tool
 * refresh); a newer operation supersedes an older one, and everything stops
 * when the plugin unloads.
 */
export class ConnectorController {
  readonly #options: ControllerOptions
  readonly #name: string
  readonly #signOut: PluginStatusAction
  readonly #lifetime = new AbortController()
  #op: AbortController | undefined
  #generation = 0
  #phase: Phase = "starting"
  #account: ConnectorAccount | undefined
  #toolCount = 0
  /** Most tools a successful list returned for the current sign-in. */
  #mostTools = 0

  constructor(options: ControllerOptions) {
    this.#options = options
    this.#name = options.name
    this.#signOut = {
      id: ACTION_IDS.signOut,
      label: "Sign out",
      kind: "destructive",
      confirm: `Sign out of ${options.name}? Its tools stay unavailable until you sign in again.`,
    }
  }

  get phase(): Phase {
    return this.#phase
  }

  /** Show a status right away and check terms/sign-in in the background. */
  start(): void {
    this.#show("starting", {
      state: "working",
      code: STATUS_CODES.working,
      summary: `Starting ${this.#name}…`,
    })
    void this.#boot()
  }

  /** Stop everything (plugin unload). Idempotent. */
  dispose(): void {
    this.#lifetime.abort(new Error(`${this.#name} stopped.`))
    this.#op?.abort()
  }

  async acceptTerms(signal?: AbortSignal): Promise<void> {
    const op = this.#begin(signal)
    try {
      const terms = this.#options.terms
      if (terms)
        await this.#options.storage.writeText(
          TERMS_FILE,
          `${JSON.stringify({ accepted: true, acceptedAt: new Date().toISOString(), terms: terms.url })}\n`,
        )
      await this.#afterTerms(op)
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
      this.#mostTools = 0
      const minutes = Math.max(
        1,
        Math.round(this.#options.signInTimeoutMs / 60_000),
      )
      const waiting =
        this.#options.wording?.signInWaiting
        ?? "Finish signing in in the browser window that opened."
      this.#show("signing-in", {
        state: "working",
        code: STATUS_CODES.working,
        summary: "Waiting for sign-in in your browser",
        detail: `${waiting} Sign-in times out after ${minutes} minute${minutes === 1 ? "" : "s"}.`,
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
    this.#mostTools = 0
    this.#account = undefined
    await this.#options.upstream.closeAll().catch(() => {})
    try {
      await this.#options.tokens.signOut()
    } catch (error) {
      this.#options.logger.warn(
        `Sign-out could not clear the stored credentials: ${this.#options.toError(error).message}`,
      )
    }
    if (!op.current()) return
    if (await this.#termsAccepted()) this.#showSignin()
    else this.#showTerms()
  }

  /** Re-run the full check (terms, sign-in, fresh token, connect, list) — entitlement may have changed. */
  async retry(signal?: AbortSignal): Promise<void> {
    const op = this.#begin(signal)
    await this.#options.tokens.invalidate?.().catch(() => false)
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
      const failure = this.#options.toError(error)
      if (failure.accountLevel) this.#fail(this.#begin(), failure)
      else
        this.#options.logger.warn(
          `Could not refresh ${this.#name} tools: ${failure.message}`,
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
      const failure = this.#options.toError(error)
      let reported = failure
      if (failure.status === 403) {
        // Partial entitlement: the policy refuses this request, not the
        // connector. Keep the state and the tools.
        reported = this.#options.policyDenied(failure)
      } else if (failure.code === "not-entitled") {
        // A refreshed token was refused: re-check the whole tool list,
        // which moves the connector to `error` if access is really gone.
        void this.refreshTools()
      } else if (failure.accountLevel && this.#phase === "ready") {
        this.#fail(this.#begin(), failure)
      }
      return {
        isError: true,
        content: [{ type: "text", text: reported.message }],
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
      await this.#afterTerms(op)
    } catch (error) {
      this.#fail(op, error)
    }
  }

  /** Terms are settled: connect with a cached sign-in, or ask for one. */
  async #afterTerms(op: Operation): Promise<void> {
    if (!this.#options.interactive) {
      await this.#connect(op)
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
  }

  async #connect(op: Operation): Promise<void> {
    this.#show("connecting", {
      state: "working",
      code: STATUS_CODES.working,
      summary: `Connecting to ${this.#name}…`,
    })
    // Silent token check first: an expired sign-in is `signin-needed`, not a connection error.
    await this.#options.tokens.getToken(op.signal)
    // Fresh upstream sessions for the (possibly new) identity.
    await this.#options.upstream.closeAll()
    const tools = await this.#options.upstream.listTools(op.signal)
    const account =
      this.#options.interactive ?
        (this.#account ?? (await this.#options.tokens.account()))
      : undefined
    if (!op.current()) return
    this.#account = account
    this.#publishTools(tools)
    this.#showReady()
  }

  #fail(op: Operation, error: unknown): void {
    if (!op.current()) return
    // Superseded operations and unloads return above; an abort that is still
    // current came from the action's caller.
    const failure: ConnectorError =
      isAbort(error, op.signal) ?
        new ConnectorError(
          this.#phase === "signing-in" ? "sign-in-cancelled" : "upstream",
          this.#phase === "signing-in" ?
            "Sign-in was cancelled."
          : `Connecting to ${this.#name} was cancelled.`,
        )
      : this.#options.toError(error)
    this.#options.logger.warn(`${this.#name}: ${failure.message}`)
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

  /** Accepted when `terms.json` records acceptance of the manifest's current terms URL. */
  async #termsAccepted(): Promise<boolean> {
    const terms = this.#options.terms
    if (!terms) return true
    const text = await this.#options.storage.readText(TERMS_FILE)
    if (!text) return false
    try {
      const record = JSON.parse(text) as { accepted?: unknown; terms?: unknown }
      return record.accepted === true && record.terms === terms.url
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
    this.#mostTools = Math.max(this.#mostTools, definitions.length)
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
    const terms = this.#options.terms
    const wording = this.#options.wording
    const label = terms?.label ?? `the ${this.#name} terms`
    this.#show("terms", {
      state: "needs-setup",
      code: STATUS_CODES.termsNeeded,
      summary: wording?.termsSummary ?? `Accept ${label} to continue`,
      detail:
        wording?.termsDetail
        ?? `Review ${label} at ${terms?.url ?? ""} before you continue.`,
      actions: [
        { id: ACTION_IDS.acceptTerms, label: "Accept terms", kind: "primary" },
      ],
    })
  }

  #showSignin(detail?: string): void {
    this.#show("signin", {
      state: "needs-setup",
      code: STATUS_CODES.signinNeeded,
      summary:
        this.#options.wording?.signInPrompt ?? `Sign in to ${this.#name}`,
      ...(detail ? { detail } : {}),
      actions: [{ id: ACTION_IDS.signIn, label: "Sign in", kind: "primary" }],
    })
  }

  #facts(): Array<{ label: string; value: string }> {
    const facts: Array<{ label: string; value: string }> = []
    const account = this.#account
    if (account?.username)
      facts.push({ label: "Account", value: account.username })
    if (account?.tenantId)
      facts.push({ label: "Tenant", value: account.tenantId })
    if (account?.issuer && !account.username)
      facts.push({ label: "Signed in at", value: hostOf(account.issuer) })
    return facts
  }

  #showReady(): void {
    const protocol = this.#options.protocol?.()
    this.#show("ready", {
      state: "ready",
      code: STATUS_CODES.ready,
      summary:
        this.#account?.username ?
          `Connected as ${this.#account.username}`
        : "Connected",
      facts: [
        ...this.#facts(),
        {
          label: "Tools",
          value:
            this.#toolCount < this.#mostTools ?
              `${this.#toolCount} (some may be restricted by your organization)`
            : String(this.#toolCount),
        },
        ...(protocol ?
          [{ label: "Protocol", value: `MCP ${protocol.version}` }]
        : []),
      ],
      ...(this.#options.interactive ? { actions: [this.#signOut] } : {}),
    })
  }

  #showError(failure: ConnectorError): void {
    const actions: Array<PluginStatusAction> = [
      { id: ACTION_IDS.retry, label: "Try again", kind: "primary" },
    ]
    if (this.#options.interactive) {
      if (failure.accountLevel || failure.code === "port-in-use")
        actions.push({
          id: ACTION_IDS.signIn,
          label: this.#account ? "Sign in with another account" : "Sign in",
          kind: "secondary",
        })
      // Not-entitled keeps the sign-in so Try again works once an admin acts.
      if (this.#account) actions.push(this.#signOut)
    }
    const facts = this.#facts()
    const reason = `Reason: ${failure.code}${failure.status ? ` (HTTP ${failure.status})` : ""}.`
    this.#show("error", {
      state: "error",
      code: STATUS_CODES.error,
      summary: failure.message,
      detail: failure.hint ? `${failure.hint} ${reason}` : reason,
      ...(facts.length > 0 ? { facts } : {}),
      actions,
    })
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
