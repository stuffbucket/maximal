// Layout contracts for the Rules surface (called Budget before). These run
// against the shared UI harness (scenario `budget-limits`: rules that are fine,
// nearly spent and spent, with a week of activity).
import { type Page, expect, test } from "@playwright/test"

const BASE = process.env.UI_HARNESS_URL ?? "http://127.0.0.1:4747"
const RULES = `${BASE}/ui/settings/#rules`
const LEGACY_BUDGET = `${BASE}/ui/settings/#budget`

test.beforeEach(async ({ page, request }) => {
  const res = await request.post(`${BASE}/__harness/scenario`, {
    data: { id: "budget-limits" },
  })
  expect(res.ok(), `UI harness not reachable at ${BASE}`).toBe(true)
  await page.goto(RULES)
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

test("the old #budget link lands on Rules and rewrites itself to #rules", async ({
  page,
}) => {
  const landedOnRules = async () => {
    await expect(page.locator('[data-surface-target="rules"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await expect(page.locator(".budget h2").first()).toHaveText("Rules")
    expect(new URL(page.url()).hash).toBe("#rules")
  }
  // Followed inside the open window (a hashchange)...
  await page.goto(`${BASE}/ui/settings/#account`)
  await page.goto(LEGACY_BUDGET)
  await landedOnRules()
  // ...and opened cold (the boot path).
  await page.goto("about:blank")
  await page.goto(LEGACY_BUDGET)
  await landedOnRules()
})

test("the top bar keeps four surface buttons and hides the Settings tabs", async ({
  page,
}) => {
  await expect(page.locator("[data-surface-target]")).toHaveCount(4)
  await expect(page.locator('[data-surface-target="rules"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await expect(page.locator("[data-settings-nav]")).toBeHidden()
})

test("has one display heading and sections in order: rules, activity, settings", async ({
  page,
}) => {
  await expect(page.locator(".budget .section__title")).toHaveCount(1)
  const titles = await page.locator(".budget h2").allTextContents()
  expect(titles).toEqual(["Rules", "Activity", "Settings"])
  // The switch lives under Settings, below the rules and activity.
  const limitsBox = await page.locator("#budget-limits-title").boundingBox()
  const enforceBox = await page.locator("#budget-enforce").boundingBox()
  expect(limitsBox && enforceBox && limitsBox.y < enforceBox.y).toBe(true)
})

test("a one-line status above the rules keeps the switch state in view", async ({
  page,
}) => {
  const status = page.locator("#budget-status")
  await expect(status).toBeVisible()
  await expect(status).toContainText(/Enforcing|Not enforcing/)
  await expect(status).toContainText(/\d+ rules?/)
  const statusBox = await status.boundingBox()
  const limitsBox = await page.locator("#budget-limits-title").boundingBox()
  expect(statusBox && limitsBox && statusBox.y < limitsBox.y).toBe(true)
})

test("the export button says what it downloads", async ({ page }) => {
  const button = page.getByRole("button", {
    name: "Download activity statement (CSV)",
  })
  await expect(button).toBeVisible()
  await expect(button).toHaveAttribute(
    "title",
    /maximal-activity-week-by-model\.csv/,
  )
})

test("rule meters name their figures and a spent rule says so", async ({
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
    dialog.getByRole("button", { name: "Save rule" }),
  ).toBeInViewport()
  await page.screenshot({ path: "test-results/rules-editor-640x480.png" })
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
  await page.screenshot({ path: "test-results/rules-list.png" })
})

// The rule editor never throws away what was typed.
async function openAddDialog(page: Page) {
  await page.setViewportSize({ width: 900, height: 700 })
  await page.locator(".budget-block__head .btn").first().click()
  const dialog = page.locator("dialog.budget-editor[open]")
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveCSS("opacity", "1")
  return dialog
}

test("a bad amount keeps the editor open with every value, and names the problem", async ({
  page,
}) => {
  const dialog = await openAddDialog(page)
  await dialog.getByLabel("Name").fill("My cap")
  const amount = dialog.locator("#budget-field-amount")
  await amount.fill("lots")
  await dialog.getByRole("button", { name: "Save rule" }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog.locator(".budget-field__error")).toContainText(
    "Enter an amount like 100 or $100",
  )
  await expect(dialog.locator(".budget-field__error")).not.toContainText(
    "above zero",
  )
  await expect(amount).toHaveValue("lots")
  await expect(dialog.getByLabel("Name")).toHaveValue("My cap")
  await expect(amount).toBeFocused()
  // Zero is a different problem and says so.
  await amount.fill("0")
  await dialog.getByRole("button", { name: "Save rule" }).click()
  await expect(dialog.locator(".budget-field__error")).toContainText(
    "above zero",
  )
  await expect(dialog).toBeVisible()
})

test("a click on the backdrop or Escape leaves an edited editor open", async ({
  page,
}) => {
  const dialog = await openAddDialog(page)
  const amount = dialog.locator("#budget-field-amount")
  await amount.fill("lots")
  // The corner of the window is the backdrop.
  await page.mouse.click(4, 4)
  await expect(dialog).toBeVisible()
  await expect(amount).toHaveValue("lots")
  // So is the dialog's own padding.
  const box = await dialog.boundingBox()
  if (!box) throw new Error("no dialog box")
  await page.mouse.click(box.x + 3, box.y + 3)
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  await expect(amount).toHaveValue("lots")
  // Fixing the amount and saving still works, with the unit typed in.
  await amount.fill("$100")
  await dialog.getByRole("button", { name: "Save rule" }).click()
  await expect(dialog).toBeHidden()
})

test("an untouched editor closes on the backdrop and on Escape, and Cancel always closes", async ({
  page,
}) => {
  let dialog = await openAddDialog(page)
  await page.mouse.click(4, 4)
  await expect(dialog).toBeHidden()
  dialog = await openAddDialog(page)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  dialog = await openAddDialog(page)
  await dialog.locator("#budget-field-amount").fill("5")
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toBeHidden()
})

test("the amount field carries its unit", async ({ page }) => {
  const dialog = await openAddDialog(page)
  await expect(dialog.locator(".input-adorn__text")).toHaveText("$")
})
