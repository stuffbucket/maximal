/**
 * /_debug/state — runtime introspection endpoint.
 *
 * Same shape as `maximal debug --json`, but live from the running
 * proxy. Gated on `state.verbose` so it's 404 by default. Pairs with
 * the `debug` subcommand: that one for cold inspection, this for when
 * a restart isn't an option.
 */

import { Hono } from "hono"

import { getConfig } from "~/lib/config/config"
import { allCacheMetrics } from "~/lib/runtime-state/cache"
import { modelsCached, state, tokenPresence } from "~/lib/runtime-state/state"
import { getGitVersion } from "~/lib/update/version"

import {
  collectSecretStatuses,
  describeExecutor,
  summarizeConfig,
} from "../../debug"

export const debugRoutes = new Hono()

debugRoutes.get("/state", (c) => {
  if (!state.verbose) {
    return c.notFound()
  }

  // Config read may throw on disk error; surface as empty rather than
  // 500ing. Mirrors the debug-subcommand behavior.
  let config: ReturnType<typeof getConfig>
  try {
    config = getConfig()
  } catch {
    config = {}
  }

  const models = modelsCached()
  const tokens = tokenPresence()
  return c.json({
    git: getGitVersion(),
    runtime: {
      account_type: state.accountType,
      verbose: state.verbose,
      manual_approve: state.manualApprove,
      rate_limit_seconds: state.rateLimitSeconds ?? null,
      rate_limit_wait: state.rateLimitWait,
      models_loaded: models > 0,
      models_count: models,
      copilot_token_present: tokens.copilot,
      github_token_present: tokens.github,
    },
    config: summarizeConfig(config),
    executor: describeExecutor(),
    caches: allCacheMetrics(),
    secrets: collectSecretStatuses(config),
  })
})
