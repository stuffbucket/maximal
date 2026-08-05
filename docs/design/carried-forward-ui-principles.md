# UI / renderer principles carried forward (from the retired Tauri shell)

> **Status:** reference · **Date:** 2026-08-05

When the Tauri shell and the in-repo proxy core were retired — the core moved to
`@stuffbucket/maximal-core`, and the go-forward shell is the **Electron client**
in `maximal/client/` (see `research_log/2026-08-04-codex-od-learnings-for-electron-client.md`
and epic #417) — the shell-specific ADRs and PRDs were removed from the active
docs set. Git history and older releases retain the originals; this note preserves
the parts that **generalize** to the Electron client's renderer. Each item names
the removed doc it came from, for git-history lookup.

## Carried forward

1. **Isolated component islands over a monolith** *(from removed ADR-0002, ADR-0004).*
   Mount interactive control-surface views (account/auth, API clients, settings
   sections) as independent islands with their own state and lifecycle, not one
   monolithic render — so each section's loading/failure stays contained.

2. **Design tokens: a single source of truth** *(from removed ADR-0008).*
   One `tokens.css`; dark declared twice (`[data-theme=dark]` + `prefers-color-scheme`);
   the pre-hydration inline script and the runtime theming must encode **identical**
   ratios/color-space/default — guard with a computed-vars equality test. (This is
   already the go-forward guidance — see the learnings brief, rec 16.)

3. **State-matrix specs for critical flows** *(from removed ADR-0012).*
   Author a state matrix (states × transitions × entry points × test coverage) as
   the **binding** source of truth for each complex client flow — **sign-in / auth,
   account-switch, first-run, and now the sidecar-supervisor lifecycle** — that the
   discriminated union (ADR-0006), the controller, the renderer, and the tests all
   match. This discipline is what made the hard-won **auth** states tractable; it is
   the single most valuable thing to carry into the Electron client, especially for
   auth (the most use-case-sensitive area) and the new sidecar lifecycle.

4. **A read-only diagnostics/status surface that composes, not duplicates** *(from
   removed dashboard-window-prd).* Offer a read-only view answering "is it on, is it
   healthy, what's it doing, how do I connect?" by **composing existing endpoints**
   (health/status, **auth/token health**, a usage snapshot, a recent-activity feed)
   rather than reimplementing business logic. All writes live in settings; the view
   is read-only. Drive live status/activity over the stateless SSE feed (ADR-0023);
   keep usage a static snapshot (the upstream is itself rate-limited). This is the
   surface where **auth/token health is shown** read-only.

## Deliberately NOT carried forward

- **Single-history (replaceState-only) routing invariant** *(removed ADR-0020)* —
  its sole driver was stale-tab self-close for Tauri browser-tab delivery (removed
  ADR-0018/ADR-0019), which the Electron client's **native windows eliminate**. The
  Electron renderer chooses its own routing; single-history remains a sane default
  for an embedded-webview SPA but is no longer a hard invariant.
- **Tauri window / tray / icon / webview specifics** *(removed windows.md,
  single-window-scaffold.md, tauri-icons-prd, single-window-redesign)* — Electron has
  its own window and packaging model (see the learnings brief §3 and the client
  issues under epic #417).
