/**
 * The `/status` payload — a small, unauthenticated identity + liveness
 * report for the whole proxy.
 *
 * Schema shape (deliberately layered so it grows without churn):
 *
 *   - TOP LEVEL is "Maximal, all up": the fields that describe the proxy
 *     process itself. The mere presence of a well-formed response (with
 *     `service: "maximal"`) is the identity signal — that's what the
 *     Claude Code shim keys off, and it's stable forever.
 *
 *   - `subsystems` namespaces everything else by the part of Maximal it
 *     describes. Each subsystem is its own object. As we add subsystems
 *     (more providers, the shell, background jobs, …) they get a new key
 *     here — callers that don't know about them simply ignore the key,
 *     and existing keys never have to be reshaped. This is the seam that
 *     keeps `/status` from becoming a flat hand-rolled grab-bag.
 *
 * Everything here is SAFE to expose unauthenticated on loopback: booleans
 * and tiers and counts, never token values, account logins, PIDs, or any
 * PII. Sensitive/granular diagnostics stay behind auth
 * (`/settings/api/diagnostics`) or the verbose-gated `/_debug/state`.
 *
 * Platform-neutral by construction — nothing here is macOS-specific, so
 * the same contract holds on Windows and Linux.
 */

import { getBrokerSupervisorSnapshot } from "~/lib/mcp-broker/supervisor"
import {
  hasCopilotToken,
  hasGithubToken,
  modelsCached,
  state,
} from "~/lib/runtime-state/state"
import { BUILD_VERSION } from "~/lib/update/build-info"
import { peekUpdateStatus } from "~/lib/update/update-check"

/** Health of the GitHub Copilot auth + upstream subsystem. */
export interface CopilotSubsystemStatus {
  /** A GitHub token is present (the user has signed in). */
  authenticated: boolean
  /** Signed in AND a Copilot token is minted — the proxy can actually
   *  serve completions right now. */
  ready: boolean
  /** Copilot plan tier, e.g. "individual" | "business" | "enterprise". */
  account_type: string
}

/** Health of the model catalog the proxy serves from. */
export interface ModelsSubsystemStatus {
  /** Number of models currently cached (0 before the first load). */
  cached: number
}

export interface McpBrokerSubsystemStatus {
  /** Coarse supervisor state; endpoint details remain authenticated. */
  state:
    | "disabled"
    | "starting"
    | "ready"
    | "degraded"
    | "backoff"
    | "circuit-open"
    | "stopping"
    | "unavailable"
  /** Number of enabled configured endpoints, never their identities. */
  enabled_endpoints: number
}

export interface UpdateSubsystemStatus {
  /** Newest release on this build's channel, from the last check this
   *  process made (no fetch here); null before a check succeeds or while
   *  checks are off. */
  latest: string | null
  /** `latest` is newer than the running version. */
  update_available: boolean
  /** The apt command that upgrades an apt install; null otherwise. */
  update_command: string | null
}

export interface StatusResponse {
  /** Identity marker. Always the literal "maximal" — the stable signal a
   *  caller uses to confirm the thing on the port is this proxy. */
  service: "maximal"
  /** Overall liveness. "ok" whenever the process is up and answering;
   *  per-subsystem readiness lives under `subsystems`. */
  status: "ok"
  /** Build version (e.g. "0.4.12"). */
  version: string
  /** Milliseconds since the server module started. */
  uptime_ms: number
  /** Per-subsystem health. New subsystems are added as new keys here. */
  subsystems: {
    copilot: CopilotSubsystemStatus
    models: ModelsSubsystemStatus
    mcp_broker: McpBrokerSubsystemStatus
    update: UpdateSubsystemStatus
  }
}

/**
 * Build the `/status` payload from current in-memory state. Pure read —
 * no upstream calls, no I/O — so it's cheap enough to hit on every shim
 * invocation.
 *
 * @param startMs - server start timestamp, for the uptime field.
 */
export function buildStatus(startMs: number): StatusResponse {
  const authenticated = hasGithubToken()
  const ready = authenticated && hasCopilotToken()
  const broker = getBrokerSupervisorSnapshot()
  const update = peekUpdateStatus()

  return {
    service: "maximal",
    status: "ok",
    version: BUILD_VERSION,
    uptime_ms: Date.now() - startMs,
    subsystems: {
      copilot: {
        authenticated,
        ready,
        account_type: state.accountType,
      },
      models: {
        cached: modelsCached(),
      },
      mcp_broker: {
        state: broker.state,
        enabled_endpoints: broker.enabledEndpoints,
      },
      update: {
        latest: update?.latest ?? null,
        update_available: update?.update_available ?? false,
        update_command: update?.update_command ?? null,
      },
    },
  }
}
