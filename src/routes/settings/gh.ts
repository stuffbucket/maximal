/**
 * Local GitHub CLI endpoints — /settings/api/gh/*.
 *
 * Read-only hinting for the auth UI: is `gh` installed, and which accounts is
 * it already signed in to. Inherits the /settings/api auth gate. See
 * src/lib/system/gh-cli.ts — no token is read or returned here.
 *
 * Exposed as `createGhRoutes(deps)` so tests can inject in-process stubs for
 * the three downstream services without process-wide `mock.module`, which
 * leaks across test files (see docs/architecture.md § Testing gotchas and
 * docs/decisions/0011-mock-module-leakage-discipline.md). Production
 * callers use the zero-arg default; the registrar exports `ghRoutes` as the
 * default-wired instance so existing imports keep working.
 */

import { Hono } from "hono"

import {
  preflightCopilotError as defaultPreflightCopilotError,
  type PreflightCopilotErrorFn,
} from "~/lib/copilot-preflight"
import { forwardError } from "~/lib/error"
import {
  addAccountToDefaultRegistry as defaultAddAccountToDefaultRegistry,
  makeAccountRecord,
} from "~/lib/github-token-store"
import {
  detectGhCli as defaultDetectGhCli,
  getGhAccountToken as defaultGetGhAccountToken,
  type GhCliStatus,
} from "~/lib/system/gh-cli"

export interface GhRoutesDeps {
  detectGhCli: () => Promise<GhCliStatus>
  getGhAccountToken: (login: string, host: string) => Promise<string | null>
  preflightCopilotError: PreflightCopilotErrorFn
  addAccountToDefaultRegistry: (
    record: ReturnType<typeof makeAccountRecord>,
  ) => Promise<void>
}

const defaultGhDeps: GhRoutesDeps = {
  detectGhCli: defaultDetectGhCli,
  getGhAccountToken: defaultGetGhAccountToken,
  preflightCopilotError: defaultPreflightCopilotError,
  addAccountToDefaultRegistry: defaultAddAccountToDefaultRegistry,
}

export function createGhRoutes(deps: Partial<GhRoutesDeps> = {}): Hono {
  const {
    detectGhCli,
    getGhAccountToken,
    preflightCopilotError,
    addAccountToDefaultRegistry,
  } = { ...defaultGhDeps, ...deps }

  const routes = new Hono()

  routes.get("/status", async (c) => {
    try {
      return c.json(await detectGhCli())
    } catch (error) {
      return await forwardError(c, error)
    }
  })

  /**
   * Adopt a local `gh` account as the active GitHub identity: read its token via
   * the gh CLI and write it to the token store. The caller (shell) then reboots
   * the sidecar (`restart_sidecar`) so it boots signed-in to this account — we
   * don't mutate the running auth state here, just the on-disk config.
   *
   * The requested {login, host} MUST be one gh actually reports, so this can't
   * be used to fish for an arbitrary account's token.
   */
  routes.post("/use", async (c) => {
    try {
      const body = (await c.req.json().catch(() => null)) as {
        login?: unknown
        host?: unknown
      } | null
      const login = body?.login
      const host = body?.host
      if (
        typeof login !== "string"
        || !login
        || typeof host !== "string"
        || !host
      ) {
        return c.json(
          { error: { message: "Expected { login, host } strings." } },
          400,
        )
      }

      const status = await detectGhCli()
      const known = status.accounts.some(
        (a) => a.login === login && a.host === host,
      )
      if (!known) {
        return c.json(
          { error: { message: `gh has no account ${login} on ${host}.` } },
          404,
        )
      }

      const token = await getGhAccountToken(login, host)
      if (!token) {
        return c.json(
          { error: { message: `Could not read the gh token for ${login}.` } },
          502,
        )
      }

      // Pre-flight: confirm the token works for Copilot BEFORE writing it +
      // rebooting, so a stale/no-subscription account fails fast with a specific
      // reason rather than a generic post-reboot "came back unauthenticated".
      const preflightError = await preflightCopilotError(token, login)
      if (preflightError) {
        return c.json({ error: { message: preflightError } }, 422)
      }

      // Persist as the active account (login+host from the validated request).
      // The shell reboots into this config; we don't mutate running state here.
      await addAccountToDefaultRegistry(
        makeAccountRecord({ login, host, token, addedVia: "gh-cli" }),
      )
      return c.json({ ok: true, login, host })
    } catch (error) {
      return await forwardError(c, error)
    }
  })

  return routes
}

/** Default-wired instance used by the registrar. Tests construct their
 *  own via createGhRoutes(deps) — they MUST NOT import this one. */
export const ghRoutes = createGhRoutes()
