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
  /**
   * `document.hasFocus()` as last reported by the tab. `visible` means "not buried
   * in its own window"; `focused` means "its window is key AND the browser is the
   * frontmost app." Only `visible && focused` is truly in front of the user — a
   * visible-but-unfocused tab (backgrounded browser / non-key window) is not.
   */
  readonly focused: boolean
}

/**
 * A tab's live presence (visibility + focus), minus its identity. Bundled because
 * the two always change on the same user action (switching tab/window/app) and
 * travel together through the registry's `register`/`updateVisibility`.
 */
export type TabPresence = Omit<RegisteredTab, "tabId">

/**
 * What the sidecar should do when the tray is clicked, computed from presence.
 * - `noop`            — a visible AND focused tab is in front; nothing to do.
 * - `open`            — no tabs at all; open one fresh foreground tab.
 * - `close-then-open` — tab(s) exist but none is in front (buried, or
 *                       visible-but-unfocused); command each to `window.close()`
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
  // A tab that is both visible AND OS-focused is genuinely in front of the user,
  // so there is nothing to do. `visible` alone is NOT enough: the browser reports
  // `visibilityState: "visible"` for a backgrounded browser and for the active tab
  // of a non-key window — neither is in front, and a browser tab can't raise itself
  // (`window.focus()` is a no-op [spike]), so those must fall through to a reopen.
  if (tabs.some((tab) => tab.visibility === "visible" && tab.focused)) {
    return { kind: "noop" }
  }
  // No tabs at all → open one fresh foreground tab.
  if (tabs.length === 0) return { kind: "open" }
  // Tab(s) exist but none is in front (buried, or visible-but-unfocused): tell each
  // to self-close, then open one fresh focused tab (§1.2).
  return {
    kind: "close-then-open",
    closeTabIds: tabs.map((tab) => tab.tabId),
  }
}
