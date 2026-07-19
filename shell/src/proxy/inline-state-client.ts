/**
 * Read the state the sidecar inlined into the served HTML as `window.__STATE__`
 * (spec §1.4) — the instant-paint source. DOM-free: the caller passes the global,
 * so this is unit-testable without a browser. The shape is the shared
 * `InlineUiState` (feed-types.ts) — the same object the sidecar's
 * `buildInlineUiState` produces — so the first paint agrees with the first WS frame.
 */
import type { InlineUiState } from "../../../src/lib/ws/feed-types"

/** The subset of `window` the reader needs — just the injected state slot. */
export interface InlineStateWindow {
  __STATE__?: unknown
}

// The sidecar sets `window.__STATE__` in the served HTML (§1.4); declare it on
// both `Window` and the global scope so callers can pass either `window` or
// `globalThis` without a cast.
declare global {
  interface Window {
    __STATE__?: unknown
  }

  var __STATE__: unknown
}

/**
 * Return the inlined state, or null when it is absent or malformed. Never throws
 * — a missing/garbled `__STATE__` just means "no instant paint; hydrate via the
 * WS + fetch as usual". Validates the load-bearing fields (a `snapshot` object and
 * a numeric `boundPort`) so a truthy-but-wrong value can't crash first paint.
 */
export function readInlineState(win: InlineStateWindow): InlineUiState | null {
  const raw = win.__STATE__
  if (typeof raw !== "object" || raw === null) return null
  // Validate over an unknown-typed record — the inlined value is boundary data,
  // so every field check below is load-bearing (not a redundant type assertion).
  const candidate = raw as Record<string, unknown>
  if (
    typeof candidate.snapshot !== "object"
    || candidate.snapshot === null
    || typeof candidate.boundPort !== "number"
    || typeof candidate.sessionToken !== "string"
  ) {
    return null
  }
  return candidate as unknown as InlineUiState
}
