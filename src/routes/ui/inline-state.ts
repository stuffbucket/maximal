/**
 * Instant paint via inlined `window.__STATE__` (spec §1.4).
 *
 * The sidecar inlines current state into the served `/ui/settings/index.html` so
 * the tab paints populated on the first frame; the WS then takes over. No
 * localStorage/indexedDB on the first-paint path (Safari ITP evicts them). This
 * ALSO carries the locale override (§1.4) and the per-version update-banner
 * dismissal (§3.2) that would otherwise live in evictable client storage.
 *
 * The inlined shape IS the `InlineUiState` (feed-types.ts) — the `LiveFeedSnapshot`
 * plus a few first-paint-only extras — so the first frame never disagrees with the
 * first WS frame. `serve()` in `src/routes/ui/route.ts` injects it into the settings
 * HTML; the shell reads it back via `readInlineState` (proxy/inline-state-client.ts).
 */
import type { InlineUiState } from "~/lib/ws/feed-types"

import { state } from "~/lib/runtime-state/state"
import { buildSnapshot } from "~/lib/ws/live-feed"

// Re-export the shared shape so existing importers of `~/routes/ui/inline-state`
// keep resolving it (the canonical declaration lives in feed-types.ts).
export type { InlineUiState } from "~/lib/ws/feed-types"

/**
 * Default locale for the inlined state. TODO(single-window §1.4): the chosen
 * locale must move OFF `localStorage["maximal.locale"]` (Safari ITP evicts it
 * before first paint) into server-side persistence; until that store exists, the
 * client falls back to `navigator.languages`, so inlining the base locale here is
 * a safe no-op rather than a wrong override.
 */
const DEFAULT_INLINE_LOCALE = "en"

/** Assemble the inline state for a served page load. */
export async function buildInlineUiState(): Promise<InlineUiState> {
  return {
    // §1.4: the inlined `__STATE__` IS the WS snapshot, so the first paint and the
    // first live frame never disagree — one builder, one shape.
    snapshot: await buildSnapshot(),
    // TODO(single-window §6.5/ADR-0003): mint a per-load session token instead of
    // reusing the per-launch shell key. Empty string when the sidecar wasn't
    // spawned by the shell (no key to hand off).
    sessionToken: state.shellApiKey ?? "",
    // TODO(single-window §1.4): source from server-side locale persistence.
    locale: DEFAULT_INLINE_LOCALE,
    boundPort: state.boundPort,
    // TODO(single-window §3.2): source the per-version dismissal from server-side
    // storage (not localStorage). Null = nothing dismissed yet.
    dismissedUpdateVersion: null,
    // §1.4 restore-on-reopen: the section + scroll the last tab reported, so a
    // tray-surfaced fresh tab keeps the user's place. Null until a tab reports one.
    restoreView: state.lastView ?? null,
  }
}

/** True for HTML responses that should receive the injected state. */
export function isHtmlResponse(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/html")
}

/**
 * Serialize state into a `<script>window.__STATE__=…</script>` tag, escaped
 * against a `</script>` breakout (the `<` in `</script>` and in `<!--` must be
 * neutralized). Security-critical: a naive `JSON.stringify` inlined into HTML is
 * an XSS vector. This is the escaping-unit-test anchor.
 */
export function renderStateScript(state: InlineUiState): string {
  // Escape every `<` to `<`: that single substitution neutralizes BOTH a
  // `</script>` breakout and an HTML-comment `<!--` opener, the only two ways to
  // escape an inline <script> context. U+2028/U+2029 are literal line terminators
  // inside a JS string, so escape them too. The result is valid JSON (JS reads it
  // back verbatim) and inert as HTML.
  const json = JSON.stringify(state)
    .replaceAll("<", String.raw`\u003c`)
    .replaceAll("\u2028", String.raw`\u2028`)
    .replaceAll("\u2029", String.raw`\u2029`)
  return `<script>window.__STATE__=${json}</script>`
}

/** Insert the state script into the served HTML (before `</head>`). */
export function injectInlineState(html: string, state: InlineUiState): string {
  const script = renderStateScript(state)
  // Prefer just before </head> so it runs before the app bundle. Fall back to
  // prepending if the document has no head (never drop the state silently).
  if (html.includes("</head>")) {
    return html.replace("</head>", `${script}</head>`)
  }
  return script + html
}
