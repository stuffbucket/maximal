import { expect, test } from "@playwright/test"

const BASE = process.env.UI_HARNESS_URL ?? "http://127.0.0.1:4747"
const SETTINGS = `${BASE}/ui/settings/#account`

test.use({ viewport: { width: 772, height: 720 }, deviceScaleFactor: 1 })

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${BASE}/__harness/scenario`, {
    data: { id: "signed-in" },
  })
  expect(response.ok(), `UI harness not reachable at ${BASE}`).toBe(true)
})

test("the Settings minimum keeps every tab on one row ahead of pinned utilities", async ({
  page,
}) => {
  await page.goto(SETTINGS)
  await page.addStyleTag({
    content: "#__harness { display: none !important; }",
  })

  const tabs = page.locator("[data-settings-nav] [data-nav]")
  await expect(tabs).toHaveCount(5)
  for (let index = 0; index < 5; index += 1) {
    await expect(tabs.nth(index)).toBeVisible()
  }

  const boxes = await page.evaluate<Array<{ top: number; right: number }>>(
    `[...document.querySelectorAll("[data-settings-nav] [data-nav]")].map((element) => {
      const rect = element.getBoundingClientRect()
      return { top: rect.top, right: rect.right }
    })`,
  )
  expect(new Set(boxes.map((box) => Math.round(box.top))).size).toBe(1)

  const utilities = await page.locator(".topbar__utilities").boundingBox()
  expect(utilities).not.toBeNull()
  if (!utilities) return
  const system = boxes.at(-1)
  expect(system).toBeDefined()
  if (!system) return
  expect(utilities.x - system.right).toBeGreaterThanOrEqual(16)
})
