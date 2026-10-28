import { expect } from "bun:test"

// Stored request rows and a view builder for the sessions-view tests.
import type { InFlight } from "~/lib/token-usage/in-flight"
import type { SessionRow } from "~/lib/token-usage/store"

import {
  buildSessionsView,
  CacheObservations,
} from "~/lib/token-usage/sessions"
import { SessionsResponse } from "~/lib/token-usage/sessions-schema"

/** A minute-aligned instant, so bucket arithmetic in the tests is exact. */
export const T = 1_800_000_000_000
export const MINUTE = 60_000
export const CLAUDE = "claude-sonnet-4"

let nextId = 1

/** A stored request. It starts when it completes unless
 *  `request_started_at_ms` says otherwise. */
export function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    request_started_at_ms: overrides.created_at_ms ?? T,
    id: nextId++,
    session_id: "s1",
    client: "claude-code",
    client_label: null,
    model: CLAUDE,
    created_at_ms: T,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_tokens: 0,
    cache_ttl_s: 300,
    cache_ttl_requested: 1,
    is_compact: 0,
    context_window_tokens: 200_000,
    context_ceiling_tokens: 128_000,
    compact_at_tokens: null,
    window_source: "models-endpoint",
    ...overrides,
  }
}

export function inFlight(overrides: Partial<InFlight> = {}): InFlight {
  return {
    traceId: "trace",
    sessionId: "s1",
    client: "claude-code",
    model: CLAUDE,
    startedAtMs: T,
    streamedChars: 0,
    ...overrides,
  }
}

export function build(
  rows: Array<SessionRow>,
  nowMs: number,
  options: {
    inFlight?: Array<InFlight>
    observations?: CacheObservations
  } = {},
) {
  return buildSessionsView({
    rows,
    inFlight: options.inFlight ?? [],
    nowMs,
    observations: options.observations ?? new CacheObservations(),
  })
}

export function only(view: SessionsResponse) {
  expect(view.sessions).toHaveLength(1)
  return view.sessions[0]
}
