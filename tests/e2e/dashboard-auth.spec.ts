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

test("signed-out remote quotas render an account state while local usage remains available", async ({
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
  await expect(frame.locator(".usage-signed-out")).toBeVisible()
  await expect(frame.locator(".usage-signed-out")).toContainText(
    "Not signed in",
  )
  await expect(frame.locator(".usage-status")).toHaveCount(0)
  await expect(frame.locator("body")).not.toContainText(
    "GitHub token not found",
  )
  await expect(frame.locator("#token-usage")).toBeVisible()
  await expect(frame.locator("#live-sessions")).toBeVisible()

  await frame.locator('[data-usage-action="open-settings"]').click()
  await expect(page).toHaveURL(/#account$/u)
  await expect(page.locator('[data-section="account"]')).toBeVisible()
})
