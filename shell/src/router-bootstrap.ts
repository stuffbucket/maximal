/**
 * Browser wiring for the single-history router (spec §1.4, ADR-0020).
 *
 * This is the DOM glue: it reads `window.history` / `window.location`, binds
 * delegated nav-link clicks, and hands the real context to the DOM-free
 * `createRouter` core. It is intentionally thin — all logic lives in `router.ts`
 * so it can be unit-tested without a DOM. This file is covered by the source-grep
 * gate (`tests/single-history-invariant.test.ts`), which bans `pushState` and
 * `location.hash =` in the routing sources.
 *
 * Registers NO `hashchange`/`popstate` listener: single-history means there is no
 * back/forward to react to (that is the whole point of the invariant).
 */
import {
  createRouter,
  isSectionId,
  type Router,
  type RouterHandlers,
} from "./router"

let active: Router | null = null

/** Construct the router from the live `window`, wire click delegation, and start it. */
export function initRouter(handlers: RouterHandlers): Router {
  const router = createRouter({
    history: globalThis.history,
    location: globalThis.location,
    handlers,
  })

  // Delegated nav: a single listener handles every `[data-nav="<section>"]` link,
  // routing through `router.navigate` (which uses replaceState) instead of letting
  // the anchor assign `location.hash` — assigning hash accrues history and breaks
  // stale-tab self-close (§1.4/ADR-0020). An optional `data-project` scopes the
  // Projects master-detail (§2.5).
  document.addEventListener("click", (event: MouseEvent) => {
    const origin =
      event.target instanceof Element ?
        event.target.closest<HTMLElement>("[data-nav]")
      : null
    if (!origin) return
    const id = origin.dataset.nav
    if (!id || !isSectionId(id)) return
    event.preventDefault()
    router.navigate(id, { project: origin.dataset.project })
  })

  router.start()
  active = router
  return router
}

/** The active router instance (for nav-link handlers created after boot). */
export function activeRouter(): Router | null {
  return active
}
