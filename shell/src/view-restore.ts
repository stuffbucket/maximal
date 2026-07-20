/**
 * Restore-on-reopen decision (spec §1.4) — DOM-free and unit-testable.
 *
 * When a tray click surfaces the app by closing a not-in-front tab and opening a
 * fresh one (§1.2), the fresh tab should land where the user left off. The sidecar
 * inlines the last-reported section + scroll as `window.__STATE__.restoreView`;
 * this picks the section (and scroll) to show on load from that plus the URL hash.
 *
 * Precedence: an explicit, valid `#section` in the URL is a deliberate deep-link
 * (or a tray open AT a section) and WINS — fresh intent, no scroll restore. Else a
 * present `restoreView` is honored. Else the caller's default, at the top.
 */
import type { ViewState } from "../../src/lib/ws/feed-types"

import { isSectionId, type SectionId } from "./router"

export interface InitialView {
  readonly section: SectionId
  /** Scroll offset (px) to restore into the section's scroll container; 0 = top. */
  readonly scrollY: number
}

export function pickInitialView(
  rawHash: string,
  restoreView: ViewState | null | undefined,
  fallback: SectionId,
): InitialView {
  const hashSection = rawHash.replace(/^#/, "")
  // A valid hash is an explicit intent (deep-link / tray-at-section) → it wins,
  // and we do NOT restore scroll (the user asked for this section fresh).
  if (isSectionId(hashSection)) {
    return { section: hashSection, scrollY: 0 }
  }
  // No explicit section: restore the prior view if the sidecar inlined one.
  if (restoreView && isSectionId(restoreView.section)) {
    return {
      section: restoreView.section,
      scrollY: Math.max(0, restoreView.scrollY),
    }
  }
  return { section: fallback, scrollY: 0 }
}
