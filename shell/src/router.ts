/**
 * Single-history router core (spec §1.4, ADR-0020) — DOM-FREE and testable.
 *
 * HARD INVARIANT: `history.length === 1`. All in-app navigation goes through
 * `createRouter(...).navigate(id)` using `history.replaceState` — NEVER
 * `pushState`, NEVER `location.hash =` (both accrue history; a second entry makes
 * a stale tab's `window.close()` silently no-op in Safari and Edge, breaking tray
 * dedup §1.2).
 *
 * This file references NO `window`/DOM globals — it takes injected `HistoryLike`
 * / `LocationLike` context so `tests/spa-router.test.ts` can drive it against a
 * fake `History` and assert `length === 1` / `pushes === 0` (the repo has no
 * jsdom harness — DOM-free cores are unit-tested, DOM glue is source-grepped).
 * The real `window` wiring lives in `shell/src/router-bootstrap.ts`.
 *
 * Replaces the hash-driven routing in `main.ts` (`wireNav`/`navLink`/`syncFromHash`
 * + the `hashchange` listener). `navigate` ABSORBS the side effects that listener
 * drove (section load/refresh, auth-event stream lifecycle, ADR-0002's api-clients
 * `selectMode` reset), delivered via `RouterHandlers`.
 */

// Single source of truth: the tuple carries no payload types, so the union is
// derived losslessly — adding/renaming a section can't drift the two apart.
// TODO(single-window §7): `main.ts` still holds file-private `SectionId` /
// `SECTIONS` / `isSectionId` copies. Collapse them into these exports once
// `isSectionId` below has a real body (importing a stubbed `isSectionId` would
// break main.ts's live routing until then).
export const SECTIONS = [
  "account",
  "usage",
  "projects",
  "endpoint",
  "api-clients",
  "apps",
  "models",
  "general",
  "logs",
  "diagnostics",
] as const;

export type SectionId = (typeof SECTIONS)[number];

/** Structural subset of `window.history` — only what the router is allowed to use. */
export interface HistoryLike {
  readonly length: number;
  replaceState(data: unknown, unused: string, url?: string): void;
}

/** Structural subset of `window.location` (read-only; the router never assigns it). */
export interface LocationLike {
  readonly hash: string;
  readonly search: string;
  readonly pathname: string;
}

/** Default landing is dynamic: Account signed-out, Usage signed-in (§2.3, D1). */
export function defaultSection(signedIn: boolean): SectionId {
  return signedIn ? "usage" : "account";
}

export function isSectionId(value: string): value is SectionId {
  return (SECTIONS as readonly string[]).includes(value);
}

/** Read the initial section from `#hash` (boot/deep-link only — never re-read). */
export function readSectionFromLocation(location: LocationLike): SectionId {
  const raw = location.hash.replace(/^#/, "");
  // An unknown/empty hash falls back to the signed-out default; the caller
  // (bootstrap) can re-navigate once it knows the auth state (§2.3, D1).
  return isSectionId(raw) ? raw : "account";
}

/** Optional open-time project scope for a project detail view (§2.4/§2.5). */
export function readProjectSlug(location: LocationLike): string | null {
  const slug = new URLSearchParams(location.search).get("project");
  return slug && slug.length > 0 ? slug : null;
}

/** Compute the target URL for `replaceState` (path + optional `?project=`). Pure. */
export function targetUrl(id: SectionId, project: string | null): string {
  // Relative URL: `?project=…` scopes the Projects master-detail (§2.5), `#id`
  // keeps the deep-link contract WITHOUT assigning `location.hash` (which would
  // accrue a history entry and break stale-tab self-close — §1.4).
  const query = project ? `?project=${encodeURIComponent(project)}` : "";
  return `${query}#${id}`;
}

export interface NavigateOptions {
  /** Project slug for the Projects master-detail (`?project=<slug>`), stable API-key label. */
  readonly project?: string | null;
}

/** Side effects the old `hashchange` handler drove, now owned by the router. */
export interface RouterHandlers {
  /** Show/hide panes + active-nav state for the target section. */
  readonly showSection: (id: SectionId, project: string | null) => void;
  /** Per-section load/refresh (apps/models refresh events, diagnostics/general fetch). */
  readonly onEnter: (id: SectionId, project: string | null) => void;
  /** Auth-event stream lifecycle (open on account, close elsewhere) — now the WS feed. */
  readonly onLeave: (previous: SectionId) => void;
}

/** Everything the router needs from its host, injected so it stays DOM-free. */
export interface RouterContext {
  readonly history: HistoryLike;
  readonly location: LocationLike;
  readonly handlers: RouterHandlers;
}

export interface Router {
  /**
   * The ONLY navigation entry point. Updates the URL via `replaceState` (never
   * pushes), runs leave/enter side effects. Idempotent for the same (id, project).
   */
  navigate(id: SectionId, options?: NavigateOptions): void;
  /** Resolve the boot section from location and perform the initial `navigate`. */
  start(): void;
  /** The section currently shown (for the caller's active-nav bookkeeping). */
  current(): SectionId;
}

/**
 * Build a router bound to an injected context. The browser calls this from
 * `router-bootstrap.ts` with real `window` bindings; tests call it with fakes.
 */
export function createRouter(context: RouterContext): Router {
  // Seed the current section from the boot location so `navigate` has a valid
  // "previous" before `start()` runs, and `current()` is never undefined.
  let current = readSectionFromLocation(context.location);
  let currentProject = readProjectSlug(context.location);

  // Enter a section: the ONLY writer of history, and it ALWAYS uses replaceState
  // (never pushState / `location.hash =`) so `history.length` stays 1 (§1.4).
  // Does NOT fire `onLeave` — that is the departing section's concern, handled by
  // `navigate`; `start()` enters the boot section with no prior section to leave.
  const enter = (id: SectionId, project: string | null): void => {
    current = id;
    currentProject = project;
    context.history.replaceState(null, "", targetUrl(id, project));
    context.handlers.showSection(id, project);
    context.handlers.onEnter(id, project);
  };

  return {
    navigate(id: SectionId, options?: NavigateOptions): void {
      const project = options?.project ?? null;
      // Idempotent: re-navigating to the same (id, project) is a no-op, so a
      // repeated nav click doesn't churn history or re-run side effects.
      if (id === current && project === currentProject) return;
      context.handlers.onLeave(current);
      enter(id, project);
    },
    start(): void {
      enter(
        readSectionFromLocation(context.location),
        readProjectSlug(context.location),
      );
    },
    current(): SectionId {
      return current;
    },
  };
}
