// Layout contracts for the Sessions peer surface. These run against the shared
// UI harness so the list contains realistic live, warm, and cold rows.
import { expect, test } from "@playwright/test"

const BASE = process.env.UI_HARNESS_URL ?? "http://127.0.0.1:4747"
const SESSIONS = `${BASE}/ui/dashboard/?surface=sessions`

test.use({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 1 })

test.beforeEach(async ({ page, request }) => {
  const res = await request.post(`${BASE}/__harness/scenario`, {
    data: { id: "live-sessions" },
  })
  expect(res.ok(), `UI harness not reachable at ${BASE}`).toBe(true)
  await page.goto(SESSIONS)
  await page.addStyleTag({
    content: "#__harness { display: none !important; }",
  })
  await expect(page.locator(".session-row").first()).toBeVisible()
})

test("Sessions uses compact sticky rows and reflows without an inner scroller", async ({
  page,
}, testInfo) => {
  await expect(page.locator("#sessions-table .overflow-auto")).toHaveCount(0)
  await expect(page.locator(".session-table__head")).toHaveCSS(
    "position",
    "sticky",
  )

  const desktopRowHeight = await page.evaluate<number>(
    `document.querySelector(".session-row").getBoundingClientRect().height`,
  )
  expect(desktopRowHeight, "desktop session rows are too tall").toBeLessThan(50)
  await page.screenshot({
    path: testInfo.outputPath("sessions-layout-1100.png"),
    fullPage: true,
  })

  await page.setViewportSize({ width: 1100, height: 320 })
  await page.evaluate("window.scrollTo(0, 160)")
  const stickyTop = await page.evaluate<number>(
    `document.querySelector(".session-table__head").getBoundingClientRect().top`,
  )
  expect(stickyTop, "session headings disappear while scrolling").toBe(0)
  await page.evaluate("window.scrollTo(0, 0)")

  for (const width of [1100, 900, 640, 390]) {
    await page.setViewportSize({ width, height: 720 })
    const [pageOverflow, listOverflow] = await page.evaluate<
      [number, number]
    >(`[
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.querySelector(".session-list").scrollWidth - document.querySelector(".session-list").clientWidth,
    ]`)
    expect(pageOverflow, `page overflow at ${width}px`).toBeLessThanOrEqual(0)
    expect(
      listOverflow,
      `session list overflow at ${width}px`,
    ).toBeLessThanOrEqual(0)
  }

  await expect(page.locator(".session-table__head")).toBeHidden()
  await expect(
    page
      .locator(".session-row")
      .first()
      .locator(".session-cell--state .session-cell__label"),
  ).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath("sessions-layout-390.png"),
    fullPage: true,
  })

  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.screenshot({
    path: testInfo.outputPath("sessions-layout-1100-dark.png"),
    fullPage: true,
  })
})
