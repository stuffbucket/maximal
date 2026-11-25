# What professionals do (and why)

The core discipline: **the right tool per question.** "Does it behave?" and
"does it look right?" are different questions with different tools; asking one to
answer the other is how layout bugs ship past green tests.

## The UI testing pyramid

| Layer | Tool | Answers | Cost |
|---|---|---|---|
| Logic / unit | Testing Library + jsdom/**happy-dom** | behavior: state, events, ARIA, data flow | ms, many |
| Component-in-browser | Vitest browser mode, Playwright / Cypress Component Testing | layout of one component in a *real* engine | fast |
| Served / E2E | **Playwright** | the app wired together, real layout + interaction | seconds |
| Visual regression | **Chromatic**, Percy, Playwright `toHaveScreenshot`, Argos | "does it look right" — the unknowns you can't name | slower |
| Workbench | **Storybook** | every component/state, feeds VR + interaction tests | — |

Additive, not substitutive: unit tests stay the bulk; the browser layers are a
thin, targeted guard.

## Why happy-dom/jsdom can't do layout

They implement the DOM API but **no layout engine** — no flex/grid resolution,
no box model, no `getComputedStyle` cascade for visual props, no paint. They're
built for speed and behavior. So spacing, overflow, `:focus-visible`, media
queries, and "is this on screen" are all out of scope *by design*. Keep them for
behavior; never expect them to catch a visual/layout regression.

## The tools people actually reach for

- **Storybook** — the de-facto component workbench for design-system teams. Each
  component + state is a "story" (hot-reload while authoring = the human "during
  generation" loop), and stories feed both interaction tests (play functions)
  and visual regression.
- **Chromatic** (by the Storybook team) — hosted screenshot diffing over
  stories, with a review UX for approving intended changes. The default for
  design systems.
- **Percy** / **Argos** / **reg-suit** / **BackstopJS** — other visual-diff
  services/tools.
- **Playwright `toHaveScreenshot()`** — free, in-repo baselines, deterministic;
  good when you don't want a hosted service.
- **axe-core** — accessibility-tree assertions (adjacent to layout).
- **Preview deploys** (Vercel/Netlify PR URLs) — a human still eyeballs; tooling
  shrinks the surface that needs it, doesn't eliminate it.

## The hard-won principles

1. **Baseline-and-diff for the unknowns.** You can't write an assertion for
   "some spacing, some none" — but a screenshot diff catches it. That's *why*
   visual regression exists; targeted assertions catch what you thought to name,
   screenshots catch the rest.
2. **Determinism is the real cost of screenshots.** Flaky diffs come from font
   antialiasing across OSes, animations, and live data. Mitigate: pin the
   browser+OS (Docker `mcr.microsoft.com/playwright`), disable animation +
   `prefers-reduced-motion`, **stub the data boundary** (don't just mask), bundle
   fonts, and update baselines only via an explicit reviewed step. Hosted tools
   (Chromatic) exist largely to manage this + the review workflow.
3. **Push failures left.** Prefer compile-time (typed CSS) > CI check
   (dead-selector) > screenshot diff > human review. Cheaper and earlier wins.
4. **Green unit tests are necessary, not sufficient**, for a visual change. The
   definition of done for UI includes *looking at the rendered output*.

## For this repo

- **Playwright served-UI tests** (`tests/e2e/`) exercise layout, hit targets, and
  timing against the UI harness. `bun run test:e2e` runs them; screenshots land
  in the gitignored `test-results/` directory for inspection, not baseline
  comparison.
- **Storybook** is the component catalog. `bun run storybook:check` validates
  story props and fixtures against current contracts.
- **This skill's inspector and templates** add computed-style, dead-hook, and
  screenshot checks for settings sections whose layout changes.
- `scripts/check-design-tokens.ts` prevents token-value drift; browser layout
  checks catch the separate structural drift between markup and global CSS.
