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
import { createRouter, type Router, type RouterHandlers } from "./router";
import { notImplemented } from "./dev/not-implemented";

let active: Router | null = null;

/** Construct the router from the live `window`, wire click delegation, and start it. */
export function initRouter(handlers: RouterHandlers): Router {
  // TODO(single-window §1.4): createRouter({ history: window.history,
  // location: window.location, handlers }); delegate [data-nav] clicks to
  // router.navigate (preventDefault, NEVER assign location.hash); router.start().
  return notImplemented("initRouter", { handlers, createRouter, active });
}

/** The active router instance (for nav-link handlers created after boot). */
export function activeRouter(): Router | null {
  return active;
}
