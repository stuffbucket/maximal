import { expect, test } from "@playwright/test"

import { stubDiagnostics } from "./fixture.diagnostics"

// Layout + visual test for a settings section. Copy this per section and adapt
// SECTION, ROOT, the invariants, and the expected style-hook selectors. These
// are computed-layout facts a real browser can assert but happy-dom cannot.

const BASE = process.env.UI_HARNESS_URL ?? "http://127.0.0.1:4747"
const SECTION = "diagnostics"
const ROOT = '[data-section="diagnostics"]'

// Selectors that MUST style this view — if any matches zero elements, a hook
// was dropped in a markup rewrite (the silent-CSS-drift bug).
const REQUIRED_HOOKS = [
  "[data-diagnostics-root]",
  "[data-uninstall-body]",
  ".uninstall-options",
]

test.describe(`${SECTION} island — layout`, () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await stubDiagnostics(page) // deterministic data
    await page.goto(`${BASE}/ui/settings/#${SECTION}`)
    await expect(
      page.locator(`${ROOT} [data-diagnostics-root][aria-busy="false"]`),
    ).toBeVisible()
  })

  test("computed layout invariants", async ({ page }) => {
    // (1) the selected layout root establishes its intended rhythm.
    await expect(page.locator(ROOT)).toHaveCSS("row-gap", "24px")

    // (2) the uninstall body is a flex column with the --space-3 gap.
    const body = page.locator(`${ROOT} [data-uninstall-body]`)
    await expect(body).toHaveCSS("display", "flex")
    await expect(body).toHaveCSS("row-gap", "12px")

    // (3) no jam: the option row and the action button are actually separated
    //     (this distance was ~0 on the regressed build).
    const optionsBox = await page
      .locator(`${ROOT} .uninstall-options`)
      .boundingBox()
    const actionsBox = await page
      .locator(`${ROOT} [data-uninstall-body] .actions`)
      .boundingBox()
    expect(optionsBox).not.toBeNull()
    expect(actionsBox).not.toBeNull()
    if (!optionsBox || !actionsBox) throw new Error("layout rows not visible")
    expect(
      Math.round(actionsBox.y - (optionsBox.y + optionsBox.height)),
    ).toBeGreaterThan(6)
  })

  test("no dropped style hooks", async ({ page }) => {
    for (const sel of REQUIRED_HOOKS) {
      expect(
        await page.locator(`${ROOT} ${sel}`).count(),
        `required style hook matched nothing: ${sel}`,
      ).toBeGreaterThan(0)
    }
  })

  test("captures visual evidence", async ({ page }) => {
    // Repository E2E screenshots are inspection artifacts, not baselines. Open
    // this file and look at it after the run. Settings scrolls `.pane` inside a
    // viewport-height shell, so expand it to capture off-screen section content.
    await page.addStyleTag({
      content: `
        html, body { height: auto !important; overflow: visible !important; }
        .app { height: auto !important; overflow: visible !important; }
        .shell { flex: none !important; min-height: auto !important; }
        .pane { flex: none !important; overflow: visible !important; }
      `,
    })
    await page.screenshot({
      path: `test-results/${SECTION}.png`,
      animations: "disabled",
      fullPage: true,
    })
  })
})
