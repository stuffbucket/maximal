// Layout contracts for the Budget surface. These run against the shared UI
// harness (scenario `budget-limits`: limits that are fine, nearly spent and
// spent, with a week of activity).
import { expect, test } from "@playwright/test"

const BASE = process.env.UI_HARNESS_URL ?? "http://127.0.0.1:4747"
const BUDGET = `${BASE}/ui/settings/#budget`

test.beforeEach(async ({ page, request }) => {
  const res = await request.post(`${BASE}/__harness/scenario`, {
    data: { id: "budget-limits" },
  })
  expect(res.ok(), `UI harness not reachable at ${BASE}`).toBe(true)
  await page.goto(BUDGET)
  await page.addStyleTag({
    content: "#__harness { display: none !important; }",
  })
  await expect(page.locator(".limit").first()).toBeVisible()
  await expect(page.locator(".budget-table")).toBeVisible()
})

for (const [width, height] of [
  [640, 480],
  [1100, 720],
] as const) {
  test(`has no horizontal overflow at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    const overflow = await page.evaluate<boolean>(
      `(() => { const pane = document.getElementById("pane"); return pane.scrollWidth > pane.clientWidth })()`,
    )
    expect(overflow).toBe(false)
  })
}

test("the top bar keeps four surface buttons and hides the Settings tabs", async ({
  page,
}) => {
  await expect(page.locator("[data-surface-target]")).toHaveCount(4)
  await expect(page.locator('[data-surface-target="budget"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await expect(page.locator("[data-settings-nav]")).toBeHidden()
})

test("has one display heading and sections in order", async ({ page }) => {
  await expect(page.locator(".budget .section__title")).toHaveCount(1)
  const titles = await page.locator(".budget h2").allTextContents()
  expect(titles).toEqual(["Overview", "Limits", "Activity"])
})

test("limit meters name their figures and a spent limit says so", async ({
  page,
}) => {
  const meters = page.locator(".limit [role=meter]")
  await expect(meters).toHaveCount(4)
  await expect(meters.first()).toHaveAttribute("aria-valuetext", /of/)
  await expect(page.locator(".limit__state--exhausted")).toContainText("Spent")
  await expect(page.locator(".limit__state--warning")).toContainText(
    "Nearly spent",
  )
})

test("the editor dialog fits a short window and keeps its buttons reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 480 })
  await page.locator(".budget-block__head .btn").first().click()
  const dialog = page.locator("dialog.budget-editor[open]")
  await expect(dialog).toBeVisible()
  // Let the open animation finish before measuring or taking the picture.
  await expect(dialog).toHaveCSS("opacity", "1")
  const box = await dialog.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(480)
  await expect(
    dialog.getByRole("button", { name: "Save limit" }),
  ).toBeInViewport()
  await page.screenshot({ path: "test-results/budget-editor-640x480.png" })
})

test("a change from elsewhere arrives without reloading", async ({
  page,
  request,
}) => {
  const before = await page.locator(".limit").count()
  const put = await request.put(
    `${BASE}/settings/api/budget/limits/key-claude-desktop-daily`,
    {
      data: {
        scope: { kind: "key", id: "claude-desktop" },
        amount: 5,
        limit_reset: "daily",
        action: "block",
      },
    },
  )
  expect(put.ok()).toBe(true)
  await expect(page.locator(".limit")).toHaveCount(before + 1)
  await page.screenshot({ path: "test-results/budget-limits.png" })
})
