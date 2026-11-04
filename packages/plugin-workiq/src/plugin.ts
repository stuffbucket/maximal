import type { FetchLike } from "@modelcontextprotocol/client"
import type {
  Context,
  PluginLogger,
  PluginMeta,
  PluginModule,
} from "@stuffbucket/maximal-plugin-sdk"

import type { TextStore, TokenProvider } from "./auth/token-provider"
import type { Sleep } from "./util"

import { createMsalTokenProvider, SIGN_IN_TIMEOUT_MS } from "./auth/msal"
import { Config, TERMS_URL } from "./config"
import { ACTION_IDS, WorkIqController } from "./state"
import { UpstreamConnection } from "./upstream/connection"
import { createUpstreamFetch } from "./upstream/fetch"
import { UpstreamPool } from "./upstream/pool"

export const PLUGIN_ID = "workiq"

export const META: PluginMeta = {
  displayName: "Work IQ",
  description:
    "Microsoft 365 mail, meetings, chats, files and people through Microsoft's hosted Work IQ service.",
  homepage: TERMS_URL,
}

export const INJECT = ["tools", "surface", "storage", "host"] as const

/** What a token provider factory gets (the default builds the MSAL provider). */
export interface TokenProviderEnv {
  config: Config
  store: TextStore
  openBrowser: (url: string) => Promise<void>
  logger: PluginLogger
  signInTimeoutMs: number
}

/** Seams for tests and embedding; production uses the defaults. */
export interface WorkIqPluginOptions {
  createTokenProvider?: (env: TokenProviderEnv) => TokenProvider
  /** Waits between throttled attempts (default 2/4/8/16 s). */
  retryDelaysMs?: ReadonlyArray<number>
  sleep?: Sleep
  /** Underlying fetch for upstream HTTP (default global `fetch`). */
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

function defaultTokenProvider(env: TokenProviderEnv): TokenProvider {
  return createMsalTokenProvider({
    authority: env.config.authority,
    store: env.store,
    openBrowser: env.openBrowser,
    logger: env.logger,
    signInTimeoutMs: env.signInTimeoutMs,
  })
}

/** Build the Work IQ plugin module (the package entry exports the default instance). */
export function createWorkIqPlugin(
  options: WorkIqPluginOptions = {},
): PluginModule<Config> {
  const signInTimeoutMs = options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS

  function apply(ctx: Context, config: Config): void {
    const logger = ctx.host.logger
    const store: TextStore = {
      readText: (name) => ctx.storage.readText(name),
      writeText: (name, text) => ctx.storage.writeText(name, text),
      delete: (name) => ctx.storage.delete(name),
    }
    const tokens = (options.createTokenProvider ?? defaultTokenProvider)({
      config,
      store,
      openBrowser: (url) => ctx.host.openExternal(url),
      logger,
      signInTimeoutMs,
    })
    const upstreamFetch = createUpstreamFetch({
      getToken: (signal) => tokens.getToken(signal),
      ...(options.retryDelaysMs ?
        { retryDelaysMs: options.retryDelaysMs }
      : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.fetch ? { baseFetch: options.fetch } : {}),
    })
    const pool = new UpstreamPool({
      async connect(signal) {
        const connection = new UpstreamConnection({
          endpoint: new URL(config.endpoint),
          fetch: upstreamFetch,
          clientInfo: { name: "maximal", version: ctx.host.appVersion },
          callTimeoutMs: options.callTimeoutMs ?? 10 * 60_000,
          requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
          onToolsChanged: () => void workiq.refreshTools(),
        })
        try {
          await connection.connect(signal)
        } catch (error) {
          await connection.close()
          throw error
        }
        return connection
      },
      ...(options.sessionIdleMs === undefined ?
        {}
      : { idleMs: options.sessionIdleMs }),
      ...(options.maxSessions === undefined ?
        {}
      : { maxSessions: options.maxSessions }),
    })
    let stopped = false
    // Background work can finish while the fiber is unloading, when cordis
    // refuses new effects; contributions vanish with the fiber anyway.
    const contribute = (label: string, run: () => void) => {
      if (stopped) return
      try {
        run()
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `stopped` can flip while `run` executes; TS narrows it to false from the guard above
        if (!stopped)
          logger.warn(
            `Could not update ${label}: ${error instanceof Error ? error.message : String(error)}`,
          )
      }
    }
    const workiq = new WorkIqController({
      setStatus: (status) =>
        contribute("status", () => ctx.surface.setStatus(status)),
      setTools: (tools) =>
        contribute("tools", () => void ctx.tools.registerAll(tools)),
      storage: store,
      tokens,
      upstream: pool,
      logger,
      endpoint: config.endpoint,
      signInTimeoutMs,
    })

    ctx.surface.registerAction(ACTION_IDS.acceptTerms, (signal) =>
      workiq.acceptTerms(signal),
    )
    ctx.surface.registerAction(ACTION_IDS.signIn, (signal) =>
      workiq.signIn(signal),
    )
    ctx.surface.registerAction(ACTION_IDS.signOut, () => workiq.signOut())
    ctx.surface.registerAction(ACTION_IDS.retry, (signal) =>
      workiq.retry(signal),
    )
    const shutdown = () => {
      stopped = true
      workiq.dispose()
      void pool.dispose()
    }
    ctx.effect(() => shutdown, "workiq lifecycle")
    workiq.start()
  }

  return { name: PLUGIN_ID, meta: META, inject: INJECT, Config, apply }
}
