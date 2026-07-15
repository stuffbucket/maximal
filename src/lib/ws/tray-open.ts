/**
 * Pure tray-open decision (spec §1.2, §10 "tray-open dedup").
 *
 * This is deliberately a pure function over a registry snapshot: no I/O, no Bun
 * types. It is the unit + mutation-test anchor for the single-tab guarantee
 * (Verification table: "Registry identity-guard unit + mutation test" and the
 * per-workstream invariant "the sidecar opens exactly one tab and closes stale
 * ones"). Keep it dependency-free so `bun run mutate` can target it in isolation.
 */
/** Matches the browser `Document.visibilityState` the tab reports over the WS. */
export type TabVisibility = "visible" | "hidden" | "prerender"

/** One connected tab as seen by the presence registry (only connected tabs appear). */
export interface RegisteredTab {
  /** Client-generated id, persisted in the tab's `sessionStorage` (spec §1.2). */
  readonly tabId: string
  readonly visibility: TabVisibility
}

/**
 * What the sidecar should do when the tray is clicked, computed from presence.
 * - `noop`            — a visible tab already exists; nothing to do.
 * - `open`            — no tabs at all; open one fresh foreground tab.
 * - `close-then-open` — only buried tab(s); command each to `window.close()`
 *                       over the WS, then open one fresh foreground tab.
 */
export type TrayOpenAction =
  | { readonly kind: "noop" }
  | { readonly kind: "open" }
  | {
      readonly kind: "close-then-open"
      readonly closeTabIds: ReadonlyArray<string>
    }

export function decideTrayOpen(
  tabs: ReadonlyArray<RegisteredTab>,
): TrayOpenAction {
  // A visible tab is already shown, and a background one can't be raised
  // (`window.focus()` is a no-op [spike]) — so any visible tab means nothing to do.
  if (tabs.some((tab) => tab.visibility === "visible")) return { kind: "noop" }
  // No tabs at all → open one fresh foreground tab.
  if (tabs.length === 0) return { kind: "open" }
  // Only buried tab(s): tell each to self-close, then open one fresh (§1.2).
  return {
    kind: "close-then-open",
    closeTabIds: tabs.map((tab) => tab.tabId),
  }
}
