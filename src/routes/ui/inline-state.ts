import type { LiveFeedSnapshot } from "~/lib/ws/feed-types"

/**
 * Instant paint via inlined `window.__STATE__` (spec §1.4).
 *
 * The sidecar inlines current state into the served `/ui/settings/index.html` so
 * the tab paints populated on the first frame; the WS then takes over. No
 * localStorage/indexedDB on the first-paint path (Safari ITP evicts them). This
 * ALSO carries the locale override (§1.4) and the per-version update-banner
 * dismissal (§3.2) that would otherwise live in evictable client storage.
 *
 * The inlined shape IS the `LiveFeedSnapshot` (feed-types.ts) plus a few
 * first-paint-only extras, so the first frame never disagrees with the first WS
 * frame.
 *
 * Integration point (not done here): `serve()` in `src/routes/ui/route.ts` calls
 * `injectInlineState(html, state)` when `isHtmlResponse(hit.type)` before building
 * the Response. Left un-wired in this scaffold so existing UI-serve tests are
 * unaffected until the builder is real.
 */
import { notImplemented } from "~/lib/dev/not-implemented"

export interface InlineUiState {
  /** The full live snapshot (same shape the WS sends on connect). */
  readonly snapshot: LiveFeedSnapshot
  /** The minted session token the tab uses to authenticate the WS (§6.5). */
  readonly sessionToken: string
  /** Server-persisted locale override, off localStorage (§1.4 / i18n.md). */
  readonly locale: string
  /** The discovered bound port so the client derives the WS URL (§1.1). */
  readonly boundPort: number
  /** Per-version update-banner dismissal (§3.2), server-side not localStorage. */
  readonly dismissedUpdateVersion: string | null
}

/** Assemble the inline state for a served page load. */
export function buildInlineUiState(): Promise<InlineUiState> {
  return notImplemented("buildInlineUiState")
}

/** True for HTML responses that should receive the injected state. */
export function isHtmlResponse(contentType: string): boolean {
  return notImplemented("isHtmlResponse", { contentType })
}

/**
 * Serialize state into a `<script>window.__STATE__=…</script>` tag, escaped
 * against a `</script>` breakout (the `<` in `</script>` and in `<!--` must be
 * neutralized). Security-critical: a naive `JSON.stringify` inlined into HTML is
 * an XSS vector. This is the escaping-unit-test anchor.
 */
export function renderStateScript(state: InlineUiState): string {
  return notImplemented("renderStateScript", { state })
}

/** Insert the state script into the served HTML (before `</head>`). */
export function injectInlineState(html: string, state: InlineUiState): string {
  return notImplemented("injectInlineState", { html, state })
}
