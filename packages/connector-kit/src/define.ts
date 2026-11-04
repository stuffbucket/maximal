import type { FetchLike } from "@modelcontextprotocol/client"
import type {
  ConnectorLimits,
  Context,
  PluginModule,
  PluginStatus,
  ToolDefinition,
  ToolDefinitionPublic,
  ToolPermission,
} from "@stuffbucket/maximal-plugin-sdk"
import type { z } from "zod"

import type {
  AuthStrategy,
  TextStore,
  TokenProvider,
} from "./auth/token-provider"
import type { ConnectorErrorWording } from "./errors"
import type { RemoteMcpConnectorManifest } from "./manifest"
import type { ControllerWording } from "./state"
import type { ThrottleHooks } from "./upstream/classify"
import type { Clock, Random, Sleep } from "./util"

import { authStrategyFor } from "./auth"
import { SIGN_IN_TIMEOUT_MS } from "./auth/entra"
import {
  configJsonSchema,
  connectorConfigSchema,
  type ConnectorConfig,
} from "./config"
import { toConnectorError, worded, type ConnectorError } from "./errors"
import { ACTION_IDS, ConnectorController } from "./state"
import {
  UpstreamConnection,
  type NegotiatedProtocol,
} from "./upstream/connection"
import { createUpstreamFetch } from "./upstream/fetch"
import { GuardedUpstream } from "./upstream/guarded"
import { ConnectorLimiter } from "./upstream/limiter"
import { resolveLimits } from "./upstream/limits"
import { UpstreamPool } from "./upstream/pool"
import { cooldownFor } from "./upstream/retry"
import { systemClock } from "./util"

/** Host services a connector uses. */
export const CONNECTOR_INJECT = ["tools", "surface", "storage", "host"] as const

/** Options for `defineRemoteMcpConnector`; everything is optional. */
export interface RemoteMcpConnectorOptions {
  /** Replaces the manifest's default endpoint (the config default), e.g. a local fake in the bench. */
  endpoint?: string
  /** Replaces the manifest-derived sign-in strategy (tests, bench). */
  auth?: AuthStrategy
  /** Connector-specific wording for account-level and policy failures, and the admin hint. */
  errors?: ConnectorErrorWording
  /** Connector-specific status wording (terms step). Sign-in wording comes from the strategy. */
  wording?: Pick<ControllerWording, "termsSummary" | "termsDetail">
  /** Plugin override of the host's default tool permission. */
  defaultToolPermission?: (
    tool: ToolDefinitionPublic,
  ) => ToolPermission | undefined
  /** Upgrade an older settings `config` (see `manifest.settingsVersion`). */
  migrateSettings?: (fromVersion: number, config: unknown) => unknown
  /**
   * Rate-limiting numbers over the manifest's `connector.limits` (lanes and
   * retry merge per key).
   */
  limits?: ConnectorLimits
  /** Connector-specific throttling behaviour: tool kinds, lanes, result inspection, batch tools. */
  throttle?: ThrottleHooks
  /** Fallback waits between throttled attempts (default 2/4/8/16 s); also sets the attempts unless `limits.retry.attempts` does. */
  retryDelaysMs?: ReadonlyArray<number>
  /** Backoff waits (tests, bench); default `clock.sleep`. */
  sleep?: Sleep
  /** Time and timers for the limiter (default the system clock). */
  clock?: Clock
  /** Jitter source (default `Math.random`). */
  random?: Random
  /** Underlying fetch for upstream and identity-provider HTTP (default global `fetch`). */
  fetch?: FetchLike
  /** Close per-session upstream connections idle this long (default 10 min). */
  sessionIdleMs?: number
  maxSessions?: number
  /** Per tool call, reset by upstream progress (default 10 min). */
  callTimeoutMs?: number
  /** Connect and `tools/list` (default 60 s). */
  requestTimeoutMs?: number
  /** Interactive sign-in (default 5 min). */
  signInTimeoutMs?: number
}

/** The plugin module `defineRemoteMcpConnector` returns. */
export interface RemoteMcpConnectorModule extends PluginModule<ConnectorConfig> {
  readonly name: string
  readonly manifest: RemoteMcpConnectorManifest
  readonly inject: typeof CONNECTOR_INJECT
  /** zod schema (`{}` is valid); its JSON Schema is `manifest.configSchema`. */
  readonly Config: z.ZodType<ConnectorConfig>
  defaultToolPermission?(tool: ToolDefinitionPublic): ToolPermission | undefined
  migrateSettings?(fromVersion: number, config: unknown): unknown
}

function withEndpoint(
  manifest: RemoteMcpConnectorManifest,
  endpoint: string | undefined,
): RemoteMcpConnectorManifest {
  if (endpoint === undefined) return manifest
  return { ...manifest, connector: { ...manifest.connector, endpoint } }
}

/** What one `apply` needs besides `ctx` and the config. */
interface Setup {
  manifest: RemoteMcpConnectorManifest
  strategy: AuthStrategy
  options: RemoteMcpConnectorOptions
  signInTimeoutMs: number
}

/** The connector's private storage as a `TextStore`. */
function storeOf(ctx: Context): TextStore {
  return {
    readText: (file) => ctx.storage.readText(file),
    writeText: (file, text) => ctx.storage.writeText(file, text),
    delete: (file) => ctx.storage.delete(file),
  }
}

/**
 * Upstream sessions over the bearer-injecting fetch, behind the shared
 * limiter and retry policy; remembers the negotiated protocol.
 */
function upstreamPool(
  ctx: Context,
  config: ConnectorConfig,
  wiring: {
    setup: Setup
    tokens: TokenProvider
    onToolsChanged: () => void
    toError: (error: unknown) => ConnectorError
  },
): {
  pool: UpstreamPool
  guarded: GuardedUpstream
  protocol: () => NegotiatedProtocol | undefined
} {
  const { options, manifest } = wiring.setup
  const { tokens } = wiring
  const clock = options.clock ?? systemClock
  const limits = resolveLimits(
    [manifest.connector.limits, options.limits],
    options.retryDelaysMs,
  )
  const limiter = new ConnectorLimiter(limits, clock)
  const upstreamFetch = createUpstreamFetch({
    getToken: (signal) => tokens.getToken(signal),
    onUnauthorized: () => tokens.invalidate?.() ?? Promise.resolve(false),
    retryDelaysMs: limits.retry.fallbackDelaysMs.slice(
      0,
      Math.max(0, limits.retry.attempts - 1),
    ),
    maxWaitMs: limits.retry.maxWaitMs,
    sleep: options.sleep ?? clock.sleep,
    now: () => clock.now(),
    // A throttled handshake or tool list holds tool calls off too.
    onThrottle: (_status, retryAfterMs) =>
      limiter.penalize(undefined, cooldownFor(limits.retry, 0, retryAfterMs)),
    ...(options.fetch ? { baseFetch: options.fetch } : {}),
  })
  let protocol: NegotiatedProtocol | undefined
  const pool = new UpstreamPool({
    async connect(signal) {
      const connection = new UpstreamConnection({
        endpoint: new URL(config.endpoint),
        fetch: upstreamFetch,
        clientInfo: { name: "maximal", version: ctx.host.appVersion },
        callTimeoutMs: options.callTimeoutMs ?? 10 * 60_000,
        requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
        onToolsChanged: wiring.onToolsChanged,
      })
      try {
        await connection.connect(signal)
      } catch (error) {
        await connection.close()
        throw error
      }
      const negotiated = connection.protocol
      if (negotiated && negotiated.version !== protocol?.version)
        ctx.host.logger.info(
          `${manifest.displayName}: connected with MCP ${negotiated.version} (${negotiated.era === "modern" ? "server/discover" : "initialize handshake"}).`,
        )
      protocol = negotiated
      return connection
    },
    ...(options.sessionIdleMs === undefined ?
      {}
    : { idleMs: options.sessionIdleMs }),
    ...(options.maxSessions === undefined ?
      {}
    : { maxSessions: options.maxSessions }),
  })
  const guarded = new GuardedUpstream({
    name: manifest.displayName,
    upstream: pool,
    limiter,
    clock,
    toError: wiring.toError,
    logger: ctx.host.logger,
    ...(options.throttle ? { hooks: options.throttle } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.random ? { random: options.random } : {}),
  })
  return { pool, guarded, protocol: () => protocol }
}

/**
 * Status/tool updates that tolerate the fiber unloading: background work can
 * finish while cordis refuses new effects, and contributions vanish with the
 * fiber anyway.
 */
function contributor(ctx: Context) {
  let stopped = false
  const contribute = (label: string, run: () => void) => {
    if (stopped) return
    try {
      run()
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `stopped` can flip while `run` executes; TS narrows it to false from the guard above
      if (!stopped)
        ctx.host.logger.warn(
          `Could not update ${label}: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
  }
  return {
    setStatus: (status: PluginStatus) =>
      contribute("status", () => ctx.surface.setStatus(status)),
    setTools: (tools: Array<ToolDefinition>) =>
      contribute("tools", () => void ctx.tools.registerAll(tools)),
    stop: () => {
      stopped = true
    },
  }
}

function registerActions(
  ctx: Context,
  controller: ConnectorController,
  setup: Setup,
): void {
  if (setup.manifest.connector.terms)
    ctx.surface.registerAction(ACTION_IDS.acceptTerms, (signal) =>
      controller.acceptTerms(signal),
    )
  if (setup.strategy.interactive) {
    ctx.surface.registerAction(ACTION_IDS.signIn, (signal) =>
      controller.signIn(signal),
    )
    ctx.surface.registerAction(ACTION_IDS.signOut, () => controller.signOut())
  }
  ctx.surface.registerAction(ACTION_IDS.retry, (signal) =>
    controller.retry(signal),
  )
}

function applyConnector(
  ctx: Context,
  config: ConnectorConfig,
  setup: Setup,
): void {
  const { manifest, strategy, options, signInTimeoutMs } = setup
  const name = manifest.displayName
  const errorContext = {
    name,
    endpoint: config.endpoint,
    ...(options.errors ? { wording: options.errors } : {}),
  }
  const toError = (error: unknown) => toConnectorError(error, errorContext)
  const store = storeOf(ctx)
  const tokens = strategy.create({
    displayName: name,
    endpoint: config.endpoint,
    config: { ...config },
    store,
    openBrowser: (url) => ctx.host.openExternal(url),
    logger: ctx.host.logger,
    signInTimeoutMs,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    toError,
  })
  const upstream = upstreamPool(ctx, config, {
    setup,
    tokens,
    onToolsChanged: () => void controller.refreshTools(),
    toError,
  })
  const output = contributor(ctx)
  const terms = manifest.connector.terms
  const controller = new ConnectorController({
    name,
    setStatus: output.setStatus,
    setTools: output.setTools,
    storage: store,
    tokens,
    interactive: strategy.interactive,
    ...(terms ? { terms } : {}),
    upstream: upstream.guarded,
    protocol: upstream.protocol,
    logger: ctx.host.logger,
    toError,
    policyDenied: (failure) =>
      worded("policy-denied", errorContext, {
        cause: failure,
        ...(failure.status === undefined ? {} : { status: failure.status }),
      }),
    signInTimeoutMs,
    wording: {
      ...options.wording,
      ...(strategy.signInPrompt ? { signInPrompt: strategy.signInPrompt } : {}),
      ...(strategy.signInWaiting ?
        { signInWaiting: strategy.signInWaiting }
      : {}),
    },
  })
  registerActions(ctx, controller, setup)
  const shutdown = () => {
    output.stop()
    controller.dispose()
    upstream.guarded.dispose()
    void upstream.pool.dispose()
  }
  ctx.effect(() => shutdown, `${manifest.id} lifecycle`)
  controller.start()
}

/**
 * Build a complete plugin module for a remote MCP server from its manifest:
 * a config schema (`{ endpoint }`, plus `authority` for Entra), the setup
 * state machine (terms gate → sign-in → connect → ready), and the upstream
 * tool list mirrored as plugin tools. Credentials live only in the
 * connector's own `ctx.storage`; MCP clients never see upstream tokens.
 */
export function defineRemoteMcpConnector(
  baseManifest: RemoteMcpConnectorManifest,
  options: RemoteMcpConnectorOptions = {},
): RemoteMcpConnectorModule {
  const declared = withEndpoint(baseManifest, options.endpoint)
  const Config = connectorConfigSchema(declared)
  const manifest: RemoteMcpConnectorManifest = {
    ...declared,
    configSchema: configJsonSchema(Config),
  }
  const setup: Setup = {
    manifest,
    strategy: options.auth ?? authStrategyFor(manifest.connector.auth),
    options,
    signInTimeoutMs: options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS,
  }
  const { defaultToolPermission, migrateSettings } = options
  return {
    name: manifest.id,
    manifest,
    inject: CONNECTOR_INJECT,
    Config,
    apply: (ctx, config) => applyConnector(ctx, config, setup),
    ...(defaultToolPermission ? { defaultToolPermission } : {}),
    ...(migrateSettings ? { migrateSettings } : {}),
  }
}
