import { expect, test } from "@playwright/test"

const BASE = process.env.UI_HARNESS_URL ?? "http://127.0.0.1:4747"
const LABEL = "UI harness — mock backend"

test.use({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 })

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${BASE}/__harness/scenario`, {
    data: { id: "signed-in" },
  })
  expect(response.ok(), `UI harness not reachable at ${BASE}`).toBe(true)
})

test("Settings owns one chooser and its embedded Dashboard shares the scenario", async ({
  page,
}) => {
  await page.goto(`${BASE}/ui/settings/#dashboard`)

  const chooser = page.locator("#__harness")
  await expect(chooser).toHaveCount(1)
  await expect(page.getByText(LABEL, { exact: false })).toHaveCount(1)

  const dashboard = page.frameLocator("[data-dashboard-frame]")
  await expect(dashboard.locator("#__harness")).toHaveCount(0)
  await expect(dashboard.getByText(LABEL, { exact: false })).toHaveCount(0)

  const reloaded = page.waitForEvent("framenavigated", {
    predicate: (frame) => frame === page.mainFrame(),
  })
  await chooser.locator("select").selectOption("signed-out")
  await reloaded

  await expect(page.locator("#__harness")).toHaveCount(1)
  await expect(page.locator("#__harness select")).toHaveValue("signed-out")
  await expect(dashboard.locator("#__harness")).toHaveCount(0)
  await expect(dashboard.locator(".usage-signed-out")).toBeVisible()
})

test("standalone Dashboard and Sessions previews each own one chooser", async ({
  page,
}) => {
  for (const path of ["/ui/dashboard/", "/ui/dashboard/?surface=sessions"]) {
    await page.goto(`${BASE}${path}`)
    await expect(page.locator("#__harness")).toHaveCount(1)
    await expect(page.getByText(LABEL, { exact: false })).toHaveCount(1)
  }
})
