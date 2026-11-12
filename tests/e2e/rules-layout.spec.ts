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
    /maximal-activity-7d-by-model\.csv/,
  )
})

// Activity: any range, every grouping, the Dashboard's measures.
test("activity opens on seven days and shows the Dashboard's measures", async ({
  page,
}) => {
  const range = page.getByRole("group", { name: "Range" })
  await expect(range.getByRole("button", { name: "7 days" })).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  const totals = page.locator(".budget-totals")
  for (const label of [
    "Total tokens",
    "Input",
    "Output",
    "Cache Read",
    "Cache Write",
    "Requests",
    "Cost",
  ]) {
    await expect(totals).toContainText(label)
  }
  await expect(page.locator(".budget-table thead th")).toHaveText([
    "Model",
    "Requests",
    "Input",
    "Output",
    "Cache Read",
    "Cache Write",
    "Cost",
  ])
})

test("picking a range, grouping by hour or choosing two days refetches and renames the file", async ({
  page,
}) => {
  const range = page.getByRole("group", { name: "Range" })
  await range.getByRole("button", { name: "24 hours" }).click()
  await page.locator("#budget-group").selectOption("hour")
  await expect(page.locator(".budget-columns")).toBeVisible()
  await expect(page.locator(".budget-table thead th").first()).toHaveText(
    "Hour",
  )
  const button = page.getByRole("button", {
    name: "Download activity statement (CSV)",
  })
  await expect(button).toHaveAttribute(
    "title",
    /maximal-activity-24h-by-hour\.csv/,
  )
  // Custom asks for two days and says so when they run backwards.
  await range.getByRole("button", { name: "Custom" }).click()
  const from = page.locator("#budget-activity-range-from")
  const to = page.locator("#budget-activity-range-to")
  await expect(from).toBeVisible()
  await from.fill("2026-01-10")
  await to.fill("2026-01-05")
  await expect(page.locator(".range-picker .budget-field__error")).toBeVisible()
  await expect(page.locator(".budget-totals")).toBeHidden()
  await expect(button).toBeDisabled()
  await from.fill("2026-01-01")
  await expect(page.locator(".range-picker .budget-field__error")).toBeHidden()
  await expect(button).toHaveAttribute(
    "title",
    /maximal-activity-2026-01-01_to_2026-01-05-by-hour\.csv/,
  )
})

test("the activity table stays inside a 640px window with every measure", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 480 })
  const fits = await page.evaluate<boolean>(
    `(() => { const t = document.querySelector(".budget-table"); const p = document.getElementById("pane"); return t.scrollWidth <= t.clientWidth && p.scrollWidth <= p.clientWidth })()`,
  )
  expect(fits).toBe(true)
  await page.locator(".budget-table").scrollIntoViewIfNeeded()
  await page.screenshot({ path: "test-results/rules-activity-640x480.png" })
})

test("a failed activity load says so, with another try, and shows no stale figures", async ({
  page,
}) => {
  await page.route("**/settings/api/budget/activity?*", (route) =>
    route.fulfill({ status: 500, body: '{"error":{"message":"boom"}}' }),
  )
  await page
    .getByRole("group", { name: "Range" })
    .getByRole("button", { name: "30 days" })
    .click()
  await expect(
    page.locator(".budget-block").nth(1).locator(".callout"),
  ).toBeVisible()
  await expect(page.locator(".budget-totals")).toBeHidden()
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

// How each rule performs: a sparkline on the row opens its history.
test("every rule row has a sparkline that opens its history", async ({
  page,
}) => {
  await expect(page.locator(".limit__perf")).toHaveCount(4)
  await expect(page.locator(".limit__perf .spark")).toHaveCount(4)
  const button = page.locator(".limit__perf").first()
  await expect(button).toHaveAttribute("aria-expanded", "false")
  await button.focus()
  await page.keyboard.press("Enter")
  await expect(button).toHaveAttribute("aria-expanded", "true")
  const detail = page.getByRole("region", { name: /How .* is performing/ })
  await expect(detail).toBeVisible()
  for (const label of [
    "Spent",
    "Requests",
    "Periods crossed",
    "Requests refused",
  ]) {
    await expect(detail.locator(".budget-totals__parts")).toContainText(label)
  }
  await expect(detail.locator(".timeline__plot")).toBeVisible()
  await expect(detail.locator(".timeline__limit")).toHaveCount(1)
  await expect(detail.locator(".timeline__warn")).toHaveCount(1)
  await expect(detail.locator(".timeline__legend li")).toHaveCount(3)
  await expect(detail.locator(".rule-detail__periods table")).toBeVisible()
  // It opens in place and closes again.
  await page.keyboard.press("Enter")
  await expect(detail).toBeHidden()
})

test("a spent rule marks where it warned, reached its limit and refused", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: /^Show how Client codex is performing/ })
    .click()
  const detail = page.getByRole("region", {
    name: "How Client codex is performing",
  })
  await expect(
    detail.locator(".timeline__marker .marker--warned").first(),
  ).toBeVisible()
  await expect(
    detail.locator(".timeline__marker .marker--crossed").first(),
  ).toBeVisible()
  await expect(
    detail.locator(".timeline__marker .marker--refused").first(),
  ).toBeVisible()
  await expect(detail.locator(".timeline__tag--limit")).toContainText(
    "Limit $1.80",
  )
  const refused =
    (await detail
      .locator(".timeline__legend li")
      .nth(2)
      .locator("strong")
      .textContent()) ?? ""
  expect(Number(refused.replaceAll(",", ""))).toBeGreaterThan(0)
  // The same figure is the totals' "Requests refused".
  await expect(detail.locator(".budget-totals__parts")).toContainText(refused)
})

test("the history's range picker refetches, and the history fits a 640px window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 480 })
  await page
    .getByRole("button", { name: /^Show how Client codex is performing/ })
    .click()
  const detail = page.getByRole("region", {
    name: "How Client codex is performing",
  })
  await expect(detail.locator(".timeline__plot")).toBeVisible()
  await detail.getByRole("button", { name: "7 days" }).click()
  await expect(detail.getByRole("button", { name: "7 days" })).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await expect(
    detail.locator(".timeline__columns .timeline__column").first(),
  ).toBeVisible()
  const overflow = await page.evaluate<boolean>(
    `(() => { const pane = document.getElementById("pane"); return pane.scrollWidth > pane.clientWidth })()`,
  )
  expect(overflow).toBe(false)
  await detail.scrollIntoViewIfNeeded()
  await page.screenshot({ path: "test-results/rules-history-640x480.png" })
})

test("a failed history load says so with a retry, and leaves the rule alone", async ({
  page,
}) => {
  await page.route("**/limits/key-codex-weekly/timeline?*", (route) =>
    route.fulfill({ status: 500, body: '{"error":{"message":"boom"}}' }),
  )
  await page
    .getByRole("button", { name: /^Show how Client codex is performing/ })
    .click()
  const detail = page.getByRole("region", {
    name: "How Client codex is performing",
  })
  await expect(detail.locator(".callout")).toBeVisible()
  await expect(detail.locator(".timeline__plot")).toBeHidden()
  await expect(page.locator(".limit").nth(3)).toContainText("$2.02 of $1.80")
})

// What if: the rule being typed, replayed over past usage.
async function openAddWithDraft(page: Page, amount: string) {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.locator(".budget-block__head .btn").first().click()
  const dialog = page.locator("dialog.budget-editor[open]")
  await expect(dialog).toBeVisible()
  await dialog.locator("#budget-field-scope").selectOption("key")
  await dialog.locator("#budget-field-target").selectOption("codex")
  await dialog.locator("#budget-field-amount").fill(amount)
  return dialog
}

test("what if says what a typed rule would have done, after a pause", async ({
  page,
}) => {
  const dialog = await openAddWithDraft(page, "1")
  const panel = dialog.locator(".whatif")
  await expect(panel).toContainText("What if")
  await expect(panel.locator(".whatif__facts")).toContainText(
    "Would have warned",
  )
  await expect(panel.locator(".whatif__facts")).toContainText(
    "Requests refused",
  )
  await expect(panel.locator(".whatif__facts")).toContainText(
    /\d+ requests? \(\$/,
  )
  await expect(panel.locator(".whatif__suggested strong")).toContainText(
    "Suggested: $",
  )
  // A loose cap would never have tripped.
  await dialog.locator("#budget-field-amount").fill("500")
  await expect(panel.locator(".whatif__facts dd").nth(1)).toHaveText("Never")
  await expect(panel.locator(".whatif__facts dd").nth(2)).toHaveText("None")
})

test("what if is quiet until the form is a rule, and never touches what was typed", async ({
  page,
}) => {
  const dialog = await openAddWithDraft(page, "")
  const panel = dialog.locator(".whatif")
  await expect(panel).toContainText("Enter an amount")
  await dialog.getByLabel("Name").fill("Codex cap")
  await dialog.locator("#budget-field-amount").fill("lots")
  await expect(panel).toContainText("Enter an amount")
  await expect(dialog.locator("#budget-field-amount")).toHaveValue("lots")
  await expect(dialog.getByLabel("Name")).toHaveValue("Codex cap")
  // Changing its range keeps the form as it was.
  await panel.getByRole("button", { name: "90 days" }).click()
  await expect(dialog.getByLabel("Name")).toHaveValue("Codex cap")
  await expect(dialog.locator("#budget-field-amount")).toHaveValue("lots")
})

test("using the suggestion fills the amount and keeps every other field", async ({
  page,
}) => {
  const dialog = await openAddWithDraft(page, "1")
  await dialog.getByLabel("Name").fill("Codex cap")
  const suggested = dialog.locator(".whatif__suggested strong")
  await expect(suggested).toContainText("Suggested: $")
  const text = ((await suggested.textContent()) ?? "").replace(
    "Suggested: $",
    "",
  )
  await dialog.getByRole("button", { name: /^Use \$/ }).click()
  await expect(dialog.locator("#budget-field-amount")).toHaveValue(text)
  await expect(dialog.getByLabel("Name")).toHaveValue("Codex cap")
  await expect(dialog.locator("#budget-field-target")).toHaveValue("codex")
  // The amount now is the suggestion, so there is nothing left to apply.
  await expect(dialog.getByRole("button", { name: /^Use \$/ })).toBeDisabled()
  await expect(dialog).toBeVisible()
})

test("a failed replay leaves the form usable and offers another try", async ({
  page,
}) => {
  await page.route("**/settings/api/budget/simulate", (route) =>
    route.fulfill({ status: 500, body: '{"error":{"message":"boom"}}' }),
  )
  const dialog = await openAddWithDraft(page, "1")
  await expect(dialog.locator(".whatif .callout")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Save rule" })).toBeEnabled()
  await expect(dialog.locator("#budget-field-amount")).toHaveValue("1")
})

test("the editor with what if still fits a short window and keeps Save reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 480 })
  await page.locator(".budget-block__head .btn").first().click()
  const dialog = page.locator("dialog.budget-editor[open]")
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveCSS("opacity", "1")
  const box = await dialog.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  expect(box.y + box.height).toBeLessThanOrEqual(480)
  await expect(
    dialog.getByRole("button", { name: "Save rule" }),
  ).toBeInViewport()
  await dialog.locator(".whatif").scrollIntoViewIfNeeded()
  await page.screenshot({ path: "test-results/rules-whatif-640x480.png" })
})

// Create rules from sessions: pick sessions, suggest, review, add.
async function openSessionsDialog(page: Page) {
  await page.setViewportSize({ width: 900, height: 900 })
  await page
    .getByRole("button", { name: "Create rules from sessions" })
    .first()
    .click()
  const dialog = page.locator("dialog.budget-sessions[open]")
  await expect(dialog).toBeVisible()
  await expect(dialog.locator(".session-row").first()).toBeVisible()
  return dialog
}

test("the sessions picker lists what each session cost and the models it used", async ({
  page,
}) => {
  const dialog = await openSessionsDialog(page)
  const first = dialog.locator(".session-row").first()
  await expect(first.locator(".session-row__cost")).toContainText("$")
  await expect(first.locator(".session-row__meta").first()).toContainText(
    /requests? ·/,
  )
  await expect(first.locator(".session-row__meta").nth(1)).toContainText("%")
  // The biggest spender is first.
  const costs = await dialog.locator(".session-row__cost").allTextContents()
  const amounts = costs.map((cost) => Number(cost.replaceAll(/[^0-9.]/g, "")))
  expect(amounts).toEqual([...amounts].sort((a, b) => b - a))
})

test("picking sessions changes what the button will size from, and survives a change of range", async ({
  page,
}) => {
  const dialog = await openSessionsDialog(page)
  const suggest = dialog.locator(".confirm-dialog__actions .btn--primary")
  await expect(suggest).toHaveText("Suggest rules from all usage in this range")
  await dialog.locator(".session-row__box").nth(0).check()
  await dialog.locator(".session-row__box").nth(1).check()
  await expect(suggest).toHaveText("Suggest rules from 2 sessions")
  await expect(dialog.locator(".session-footer__sum")).toContainText(
    "2 sessions picked",
  )
  // Another range: what was picked stays picked, and says so when it is out of view.
  await dialog.getByRole("button", { name: "24 hours" }).click()
  await expect(suggest).toHaveText("Suggest rules from 2 sessions")
  // Clearing the picks goes back to all usage in the range.
  await dialog.getByRole("button", { name: "Clear 2 picked" }).click()
  await expect(suggest).toHaveText("Suggest rules from all usage in this range")
})

test("a suggestion shows each rule with what it would have done, and adding keeps the list", async ({
  page,
}) => {
  const before = await page.locator(".limit").count()
  const dialog = await openSessionsDialog(page)
  await dialog.locator(".session-row__box").nth(0).check()
  await dialog.locator(".confirm-dialog__actions .btn--primary").click()
  const drafts = dialog.locator(".draft")
  await expect(drafts.first()).toBeVisible()
  await expect(dialog.locator(".form__hint").first()).toContainText(
    "Sized from 1 session",
  )
  // Each draft says what it would have done and how it was sized.
  await expect(drafts.first()).toContainText(
    /it would (have been reached|never have been reached)/,
  )
  await expect(drafts.first()).toContainText(/sized to/i)
  // Adding one leaves the list in place and the row says so.
  await drafts.first().getByRole("button", { name: /^Add / }).click()
  await expect(
    drafts.first().getByRole("button", { name: /is added$/ }),
  ).toBeDisabled()
  await expect(page.locator(".limit")).toHaveCount(before + 1)
  await expect(drafts.first()).toBeVisible()
})

test("a short history says so and suggests no weekly rule", async ({
  page,
}) => {
  const dialog = await openSessionsDialog(page)
  await dialog.locator(".confirm-dialog__actions .btn--primary").click()
  await expect(dialog.locator(".draft").first()).toBeVisible()
  await expect(dialog.locator(".callout")).toContainText("less than two weeks")
  await expect(dialog.locator(".draft")).not.toContainText("Weekly cap")
})

test("with enough history there is a weekly rule too, and add all adds the rest", async ({
  page,
}) => {
  const before = await page.locator(".limit").count()
  const dialog = await openSessionsDialog(page)
  await dialog.getByRole("button", { name: "30 days" }).click()
  await dialog.locator(".confirm-dialog__actions .btn--primary").click()
  await expect(dialog.locator(".draft").first()).toBeVisible()
  await expect(dialog.locator(".callout")).toHaveCount(0)
  await expect(dialog.locator(".draft")).toContainText([
    "Daily cap",
    "Weekly cap",
  ])
  const count = await dialog.locator(".draft").count()
  await dialog.getByRole("button", { name: /^Add all/ }).click()
  await expect(dialog.getByRole("button", { name: "Added" })).toHaveCount(count)
  await expect(page.locator(".limit")).toHaveCount(before + count)
})

test("open in editor shows the draft filled in; a rolling draft can only be added", async ({
  page,
}) => {
  let dialog = await openSessionsDialog(page)
  await dialog.locator(".confirm-dialog__actions .btn--primary").click()
  const first = dialog.locator(".draft").first()
  await expect(first).toBeVisible()
  const name = (await first.locator(".limit__name").textContent()) ?? ""
  await first.getByRole("button", { name: "Open in editor" }).click()
  const editor = page.locator(
    "dialog.budget-editor:not(.budget-sessions)[open]",
  )
  await expect(editor).toBeVisible()
  await expect(editor.getByLabel("Name")).toHaveValue(name)
  await expect(editor.locator("#budget-field-amount")).not.toHaveValue("")
  await expect(editor.locator(".whatif")).toBeVisible()
  await expect(editor).toContainText("Suggested from your sessions")
  await editor.getByRole("button", { name: "Cancel" }).click()
  await expect(editor).toBeHidden()
  // Back in the suggestion, nothing was lost.
  await expect(first).toBeVisible()
  // A rolling rule is one the editor can't set yet.
  await dialog.getByRole("button", { name: "Back" }).click()
  await dialog
    .locator("#budget-sessions-persona")
    .selectOption("heavy-agent-use")
  await dialog.locator(".confirm-dialog__actions .btn--primary").click()
  const rolling = dialog.locator(".draft").first()
  await expect(rolling).toContainText("Rolling 5 hours")
  await expect(
    rolling.getByRole("button", { name: "Open in editor" }),
  ).toBeDisabled()
  dialog = page.locator("dialog.budget-sessions[open]")
  await expect(dialog).toBeVisible()
})

test("the sessions dialog keeps what was picked: backdrop and Escape do nothing until it is untouched", async ({
  page,
}) => {
  const dialog = await openSessionsDialog(page)
  await dialog.locator(".session-row__box").first().check()
  await page.mouse.click(4, 4)
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  await expect(dialog.locator(".session-row__box").first()).toBeChecked()
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toBeHidden()
  // Untouched, it closes on either.
  const again = await openSessionsDialog(page)
  await page.mouse.click(4, 4)
  await expect(again).toBeHidden()
})

test("the sessions dialog fits a short window with its buttons reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 480 })
  await page
    .getByRole("button", { name: "Create rules from sessions" })
    .first()
    .click()
  const dialog = page.locator("dialog.budget-sessions[open]")
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveCSS("opacity", "1")
  const box = await dialog.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  expect(box.y + box.height).toBeLessThanOrEqual(480)
  await expect(
    dialog.locator(".confirm-dialog__actions .btn--primary"),
  ).toBeInViewport()
  await page.screenshot({ path: "test-results/rules-sessions-640x480.png" })
})

// Models: a shield on the models a rule names, which opens those rules.
async function openModels(page: Page) {
  const reply = await page.request.post(`${BASE}/__harness/scenario`, {
    data: { id: "budget-filters" },
  })
  expect(reply.ok()).toBe(true)
  // The page is already loaded for another scenario: start over so it reads this one.
  await page.goto("about:blank")
  await page.goto(`${BASE}/ui/settings/#models`)
  await page.addStyleTag({
    content: "#__harness { display: none !important; }",
  })
  await expect(page.locator(".model-row").first()).toBeVisible()
}

test("the Models list marks the models a rule names, and says once what covers everything", async ({
  page,
}) => {
  await openModels(page)
  const rowOf = (name: string) =>
    page.locator(".model-row", { hasText: name }).first()
  await expect(
    rowOf("Claude Haiku 5.5").locator(".model-row__rules"),
  ).toBeVisible()
  await expect(
    rowOf("Claude Sonnet 5.5").locator(".model-row__rules"),
  ).toBeVisible()
  await expect(rowOf("GPT-6.1 Sol").locator(".model-row__rules")).toBeVisible()
  // Named by no rule: no shield, however many cover everything.
  await expect(rowOf("GPT-5.6 Luna").locator(".model-row__rules")).toHaveCount(
    0,
  )
  await expect(page.locator(".models__rules-note")).toContainText(
    "1 rule covers everything",
  )
  await expect(
    rowOf("GPT-6.1 Sol").locator(".model-row__rules"),
  ).toHaveAttribute("aria-label", "Show the rule for GPT-6.1 Sol")
})

test("a model's shield opens Rules filtered to its rules, with a chip that clears", async ({
  page,
}) => {
  await openModels(page)
  await page
    .locator(".model-row", { hasText: "Claude Haiku 5.5" })
    .first()
    .locator(".model-row__rules")
    .click()
  await expect(page.locator('[data-surface-target="rules"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  expect(new URL(page.url()).hash).toBe("#rules/model/claude-haiku-5-5")
  const chip = page.locator(".rules-filter")
  await expect(chip).toContainText("Showing rules for claude-haiku-5-5")
  await expect(chip).toContainText("2 of 6 rules")
  // The rules that apply to it: the one that covers everything and the Claude filter.
  await expect(page.locator(".limit")).toHaveCount(2)
  await expect(page.locator(".limits")).toContainText("Claude models per day")
  await expect(page.locator(".limits")).not.toContainText("Client codex")
  // Clearing shows every rule again and rewrites the address.
  await chip.getByRole("button", { name: "Show all rules" }).click()
  await expect(page.locator(".limit")).toHaveCount(6)
  await expect(chip).toBeHidden()
  expect(new URL(page.url()).hash).toBe("#rules")
})

test("a model no rule applies to says so, and the chip still clears", async ({
  page,
}) => {
  await page.request.post(`${BASE}/__harness/scenario`, {
    data: { id: "budget-no-limits" },
  })
  await page.goto("about:blank")
  await page.goto(`${BASE}/ui/settings/#rules/model/gpt-6.1-sol`)
  await expect(page.locator(".rules-filter")).toContainText("gpt-6.1-sol")
  await page.getByRole("button", { name: "Show all rules" }).click()
  await expect(page.locator(".rules-filter")).toBeHidden()
})
