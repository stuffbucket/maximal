/**
 * /_debug/state — runtime introspection endpoint (PRD M3).
 *
 * Returns the same shape as `copilot-api debug --json`, but live from
 * the running proxy. Gated on state.verbose so it's 404 by default;
 * --verbose is required to expose it.
 *
 * Use case: a misconfigured proxy that's already up, where we don't
 * want to restart just to read its `debug` output. Pair with M1's
 * subcommand for cold + live coverage.
 */

import { Hono } from "hono"

import { getConfig } from "~/lib/config"
import { state } from "~/lib/state"

import { describeExecutor, secretStatus } from "../../debug"

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

  return c.json({
    runtime: {
      account_type: state.accountType,
      verbose: state.verbose,
      manual_approve: state.manualApprove,
      rate_limit_seconds: state.rateLimitSeconds ?? null,
      rate_limit_wait: state.rateLimitWait,
      models_loaded: (state.models?.data.length ?? 0) > 0,
      models_count: state.models?.data.length ?? 0,
      copilot_token_present: state.copilotToken !== undefined,
      github_token_present: state.githubToken !== undefined,
    },
    config: {
      use_messages_api: config.useMessagesApi,
      use_function_apply_patch: config.useFunctionApplyPatch,
      use_responses_api_web_search: config.useResponsesApiWebSearch,
      small_model: config.smallModel,
      claude_token_multiplier: config.claudeTokenMultiplier,
      api_keys_configured: (config.auth?.apiKeys?.length ?? 0) > 0,
      providers_declared: Object.keys(config.providers ?? {}),
    },
    executor: describeExecutor(),
    secrets: [
      secretStatus({
        name: "ollama_api_key",
        envVar: "OLLAMA_API_KEY",
        configValue: undefined,
      }),
      secretStatus({
        name: "anthropic_api_key",
        envVar: "ANTHROPIC_API_KEY",
        configValue: config.anthropicApiKey,
      }),
    ],
  })
})
