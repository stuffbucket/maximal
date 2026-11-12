import { expect, test } from "@playwright/test"

const BASE = process.env.UI_HARNESS_URL ?? "http://127.0.0.1:4747"
const SETTINGS = `${BASE}/ui/settings/#dashboard`

test.use({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 })

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${BASE}/__harness/scenario`, {
    data: { id: "live-sessions" },
  })
  expect(response.ok(), `UI harness not reachable at ${BASE}`).toBe(true)
})

test("signed-out Usage Quotas renders one Account prerequisite without metrics", async ({
  page,
}) => {
  await page.route("**/usage", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      json: {
        error: "not_authenticated",
        hint: "Open Settings → Account to sign in.",
      },
    })
  })

  await page.goto(SETTINGS)
  await page.addStyleTag({
    content: "#__harness { display: none !important; }",
  })
  const frame = page.frameLocator("[data-dashboard-frame]")
  const accountState = frame.locator(".usage-signed-out")
  await expect(accountState).toBeVisible()
  await expect(accountState).toHaveAttribute("role", "status")
  await expect(accountState.locator(".callout__icon svg")).toBeVisible()
  await expect(accountState).toContainText("Sign-in to retrieve usage quotas.")
  const accountAction = accountState.getByRole("button", {
    name: "Open Account settings",
  })
  await expect(accountAction).toBeVisible()
  await expect(accountAction).toHaveClass(/\bbtn--primary\b/u)
  await expect(accountState).not.toContainText("Account setup required")
  await expect(accountState).not.toContainText("Sign in to GitHub")
  await expect(accountState.locator('[data-lucide="settings"]')).toHaveCount(0)
  await expect(frame.locator("#live-metrics")).toBeHidden()
  await expect(frame.locator("#quota-metrics")).toBeHidden()
  await expect(frame.locator(".usage-status")).toHaveCount(0)
  await expect(frame.locator("body")).not.toContainText(
    "GitHub token not found",
  )
  await expect(frame.locator("#live-sessions")).toBeVisible()

  await frame.locator('[data-usage-action="open-account-settings"]').click()
  await expect(page).toHaveURL(/#account$/u)
  await expect(page.locator('[data-section="account"]')).toBeVisible()
})
