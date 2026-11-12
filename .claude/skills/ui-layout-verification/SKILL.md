---
name: ui-layout-verification
description: >-
  Use when changing settings UI components, markup, or CSS where real browser
  layout, selector hooks, and screenshots must be verified before completion.
---

# UI layout verification

## Why this exists (read once)

Our unit tests run on **happy-dom, which has no layout engine** — it builds a
DOM tree but never computes flex/grid/gap/box-model. So "is there 24px between
these blocks?" is unanswerable there, and **global CSS fails silently** when a
selector matches nothing. Markup and CSS can therefore drift while unit tests,
`tsc`, and lint stay green. Real-browser checks verify that the rendered DOM
still satisfies the CSS's structural assumptions. See
`references/what-professionals-do.md` for the testing layers and trade-offs.

## When to use

- Porting a vanilla section to a React island (the migration).
- Changing any component in `shell/src/ui/components/**` or its CSS.
- Any edit to `shell/src/ui/styles/styles.css` or the settings markup.
- Before you say a UI change is done. Green unit tests are necessary, **not
  sufficient**, for a visual/layout change.

## One-time setup

Install the committed dependencies and a headless browser:

```bash
bun install
bunx playwright install chromium
```

## The workflow

1. **Boot an isolated preview** (never touches a running app — own port, temp
   config). It starts a long-lived server, so launch it in the **background**
   (an agent must use its background/async runner, not a blocking call):
   ```bash
   bash .claude/skills/ui-layout-verification/scripts/preview.sh 4199
   # → http://127.0.0.1:4199/ui/settings/
   ```
2. **Inspect the rendered section** — computed gaps, orphaned selectors, and a
   screenshot you actually look at:
   ```bash
   bun .claude/skills/ui-layout-verification/scripts/inspect.ts \
     http://127.0.0.1:4199/ui/settings/#diagnostics \
     --root '[data-section="diagnostics"]' --out /tmp/diag.png \
     --ready '[data-diagnostics-root][aria-busy="false"]' \
     --expect '[data-diagnostics-root],[data-uninstall-body],.uninstall-options'
   ```
   `--ready` names the section-specific signal that asynchronous rendering has
   finished; adapt it with the other selectors. Read the printed report; open
   the PNG (or Read it) and **look**. A lost gap
   shows as `row-gap: normal`/`0px`; a dropped hook shows in the orphaned-selector
   list; a jam shows as a ~0px inter-row distance.
3. **Codify the invariants** as a committed Playwright test. Copy the spec and
   fixture module, then adapt the copied spec's selectors and expected gaps. Use
   the repository's existing UI harness and Playwright command so the test stays
   part of `bun run test:e2e`:
   ```bash
   cp .claude/skills/ui-layout-verification/templates/island.spec.ts \
     tests/e2e/<section>.spec.ts
   cp .claude/skills/ui-layout-verification/templates/fixture.diagnostics.ts \
     tests/e2e/fixture.<section>.ts
   # Update the copied spec's fixture import to the section-specific filename.
   # Terminal A
   bun run ui:harness -- --port 4747
   # Terminal B
   bun run test:e2e -- tests/e2e/<section>.spec.ts
   ```
4. **Tear down** when done: `bash .claude/skills/ui-layout-verification/scripts/preview.sh --stop 4199`.

## Definition of done (a UI change isn't finished until all pass)

- [ ] Behavior: unit tests green (`cd shell && bun test`).
- [ ] Layout invariants: the section's key containers resolve their intended
      `gap`/`display` (step 2/3), and required style hooks match inside the
      selected section.
- [ ] No jam: measured vertical distance between adjacent rows is > 0 and matches
      the token (e.g. `--space-3` = 12px).
- [ ] Screenshot: you (or the reviewer) looked at the rendered output.
- [ ] Determinism (if committing a screenshot): data stubbed, motion disabled,
      dynamic regions masked. See `references/what-professionals-do.md`.

## Determinism rules (screenshots)

Stub the data boundary (`page.route('**/settings/api/**', …)` with a fixture —
see `templates/fixture.diagnostics.ts`), disable animation +
`prefers-reduced-motion`, `mask:` anything still live (PID, uptime, git SHA), and
pin the browser+OS in CI (`mcr.microsoft.com/playwright`). Never baseline from a
dev laptop.

## Files in this skill

- `scripts/preview.sh` — boot / stop an isolated `maximal start` for previewing.
- `scripts/inspect.ts` — ad-hoc: computed gaps + orphaned-selector report + PNG.
- `templates/island.spec.ts` — a section layout+screenshot test (validated shape).
- `templates/fixture.diagnostics.ts` — route-stub fixture for deterministic data.
- `references/what-professionals-do.md` — the testing pyramid + tools + why.
