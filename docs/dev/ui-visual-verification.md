# UI layout & visual verification — plan

Status: **planned.** Establishes an automated guard for the class of bug that
`tsc` / unit tests / lint are structurally blind to: **the rendered DOM not
satisfying the assumptions the CSS was written against.** Companion to the
React-island migration (PR #398) and encoded as the `ui-layout-verification`
skill (the *how*; this doc is the *why* + *what*).

## Context

Porting the diagnostics section to a React island introduced **two silent
layout regressions**, both invisible to our existing checks:

1. **Positional-gap loss.** `.section { gap: var(--space-5) }` spaces a section's
   *direct* children; the island nested content a level deeper, so the gap no
   longer reached it. The selector still matched — nothing was "wrong" statically.
2. **Dropped selector hook.** `[data-uninstall-body] { display:flex; gap }` keyed
   on an attribute the rewritten JSX omitted, so the rule matched *nothing*.

Both passed typecheck, 23 unit tests, and lint, and were caught only by eye.
Root cause of the blind spot: **happy-dom (our unit harness) has no layout
engine** — it builds a DOM tree but never computes flex/gap/box-model. "Is there
24px between these blocks?" is unanswerable there by design. Global CSS also
fails *silently* (a selector matching nothing throws no error), so JSX↔CSS drift
never surfaces until render.

**Intended outcome:** every ported section (and every component) has an
automated check that renders it in a *real* engine and asserts layout invariants
+ a masked screenshot, so a lost gap or dropped hook fails CI — not review.

## Strategy — the right tool per question

| Question | Tool | Status |
|---|---|---|
| Does it **behave**? (state, events, ARIA, data flow) | Testing Library + happy-dom | have it — keep |
| Does it **lay out** correctly? (gaps, structure, no orphaned selectors) | Playwright, computed-style + CSS coverage | **this plan** |
| Does it **look** right? (the unknowns you can't assert) | Playwright `toHaveScreenshot` (masked, stubbed) | **this plan** |
| Can it **drift** silently? | Typed CSS (CSS Modules) + component-owned layout (`Stack`) | directional |

Layers are additive, not replacements: unit tests stay the bulk (fast, many);
the browser layer is a thin, targeted guard over the islands.

## Deliverables

### 1. Playwright served-UI harness (`tests/e2e/`)
- A Playwright project (Chromium, Linux-pinned in CI for deterministic AA/fonts)
  that boots a `maximal start` instance on an ephemeral port with an isolated
  temp `COPILOT_API_HOME`/`CLAUDE_CONFIG_DIR` (the exact recipe already used for
  the manual preview), then drives `http://127.0.0.1:<port>/ui/settings/#<section>`.
- **Data is stubbed at the boundary** via `page.route('**/settings/api/**', …)`
  returning a fixed fixture — so dynamic fields (version, PID, uptime, git SHA,
  discovered upstream) are deterministic and screenshots are stable.
- Three assertion kinds per section:
  - **Layout invariants** (`getComputedStyle` / `toHaveCSS` / bounding-box math):
    e.g. the island root resolves `gap: var(--space-5)`; sibling blocks are
    evenly spaced; `.uninstall-body` resolves `display: flex`. These encode the
    exact two failures above so they can't recur.
  - **Orphaned-selector check** (`page.coverage.startCSSCoverage()`): fail if a
    project selector matched nothing on the rendered section — the "dropped
    hook" fingerprint, caught cheaply.
  - **Masked screenshot** (`toHaveScreenshot`, masking any still-dynamic region)
    for the unknowns you can't pre-name.

### 2. Dead-selector CI check
Fast lane derived from the CSS-coverage pass above (or a standalone Chromium
load). Runs on every PR touching `shell/` — catches the dropped-hook flavor in
seconds without the full screenshot suite.

### 3. Definition of Done for a ported/changed section
A section PR isn't done until: unit behavior tests pass **and** the Playwright
layout+screenshot check for that section is green (or its baseline is
intentionally updated and reviewed). Codified in the skill's checklist.

### 4. Determinism rules (the real cost of screenshots)
- Pin the browser+OS in CI (Docker/`mcr.microsoft.com/playwright`); never
  baseline from a dev laptop.
- `prefers-reduced-motion` + disable animations/transitions for the shot.
- Stub the data boundary; `mask:` anything still live.
- Freeze fonts (bundle, not system). Update baselines only via an explicit,
  reviewed step.

### 5. Prevention (directional, not gating)
New island styles lean toward **typed CSS Modules** so a missing class is a
`tsc` error, and toward **component-owned layout** (`Stack`, explicit classes on
rendered elements) so an ancestor gap can't be silently lost. Existing global
`styles.css` is migrated opportunistically, not wholesale.

## CI wiring & phasing
- **Phase A (this initiative):** the harness + the diagnostics section check +
  the dead-selector lane. Linux, every PR touching `shell/`. Non-required first
  (bed-in), then required.
- **Phase B:** a check per section as it's ported (account, endpoint, general,
  logs) — each inherits the template.
- **Phase C (optional):** Storybook + Chromatic for the component library
  (`Button`, `ConfirmDialog`, `Switch`…) as it grows.
- Windows visual runs stay nightly/on-label (cost), mirroring the existing
  `windows-*-dev.yml` posture.

## Validation of this plan
Feasibility confirmed against the repo:
- `maximal start` serves `/ui/settings` unauthenticated and `#diagnostics`
  mounts `#diagnostics-root` (verified live on the preview instance); Playwright
  can drive it with no auth plumbing.
- `/settings/api/diagnostics` is loopback-exempt and `page.route` stubbing works
  regardless — determinism is achievable.
- No existing Playwright/e2e to conflict with (greenfield `tests/e2e/`).
- Chromium `startCSSCoverage` reports used ranges → orphaned-selector detection
  is real, not aspirational.

**Proven, not just argued** — a throwaway Playwright spec was run against the live
diagnostics island and passed with the signals that matter:
- `#diagnostics-root > div` resolves `row-gap: 24px` (the `Stack` fix, read from
  computed layout — the invariant for regression #1).
- `.uninstall-body` resolves `display: flex; row-gap: 12px`, and the measured
  `.uninstall-options → .actions` distance is **12px** — on the regressed build
  this was ~0, so this assertion *would have failed* on the jam (regression #2).
- CSS coverage returned `9843/46081` bytes used across 2 sheets → the
  dead-selector diff is a real signal.
- Whole run: 2.2s. This is the acceptance proof that the guard catches exactly
  the two bugs that shipped past unit tests.

## Verification (once built)
- Re-introduce each bug on a scratch branch (nest the island content without
  `Stack`; drop `.uninstall-body`) → the harness must fail on the invariant and
  the screenshot. This is the acceptance test for the guard itself.
- `bunx playwright test tests/e2e/diagnostics.spec.ts` green on a clean tree.
- Baseline screenshots committed under `tests/e2e/__screenshots__/`.
