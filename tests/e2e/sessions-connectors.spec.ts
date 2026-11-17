// Connector activity in the Sessions view: Work IQ and FigJam in use show as
// compact rows after the live sessions and before the cold ones. They are not
// sessions, so they have no selection, preview or context meter.
import { expect, test } from "@playwright/test"

const BASE = process.env.UI_HARNESS_URL ?? "http://127.0.0.1:4747"
const SESSIONS = `${BASE}/ui/dashboard/?surface=sessions`

test.use({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 1 })

test.beforeEach(async ({ page, request }) => {
  const res = await request.post(`${BASE}/__harness/scenario`, {
    data: { id: "connector-activity" },
  })
  expect(res.ok(), `UI harness not reachable at ${BASE}`).toBe(true)
  await page.goto(SESSIONS)
  await page.addStyleTag({
    content: "#__harness { display: none !important; }",
  })
  await expect(page.locator(".connector-row").first()).toBeVisible()
})

test("connector rows follow the live sessions and precede the cold divider", async ({
  page,
}, testInfo) => {
  const rows = page.locator("#sessions-table tbody > tr")
  const kinds: Array<string> = []
  for (let i = 0; i < (await rows.count()); i += 1) {
    const row = rows.nth(i)
    const classes = (await row.getAttribute("class")) ?? ""
    if (classes.includes("connector-row")) kinds.push("connector")
    else if (classes.includes("session-divider")) kinds.push("divider")
    else if (classes.includes("session-more")) kinds.push("more")
    else
      kinds.push(
        (await row.getAttribute("data-session-state")) === "cold" ?
          "cold"
        : "live",
      )
  }
  const firstConnector = kinds.indexOf("connector")
  expect(firstConnector).toBeGreaterThan(0)
  expect(kinds.slice(0, firstConnector).every((k) => k === "live")).toBe(true)
  expect(kinds.slice(firstConnector, firstConnector + 2)).toEqual([
    "connector",
    "connector",
  ])
  expect(kinds[firstConnector + 2]).toBe("divider")

  const workiq = page.locator('.connector-row[data-connector="workiq"]')
  await expect(workiq).toContainText("Work IQ")
  await expect(workiq).toContainText("2 tool calls running")
  await expect(workiq).toContainText("search_mail")
  const figjam = page.locator('.connector-row[data-connector="figjam"]')
  await expect(figjam).toContainText("FigJam")
  await expect(figjam).toContainText("Used")

  // Not sessions: nothing to select, no context meter, no session id.
  await expect(page.locator(".connector-row .meter")).toHaveCount(0)
  await expect(page.locator(".connector-row[tabindex]")).toHaveCount(0)
  await workiq.click()
  await expect(page.locator(".session-row--selected")).toHaveCount(0)

  // The session count and totals do not include them.
  await expect(page.locator(".session-row")).toHaveCount(
    kinds.filter((k) => k === "live" || k === "cold").length,
  )
  await page.screenshot({
    path: testInfo.outputPath("sessions-connectors-1100.png"),
    fullPage: true,
  })
})

test("connector rows reflow without horizontal overflow", async ({
  page,
}, testInfo) => {
  for (const width of [900, 640, 390]) {
    await page.setViewportSize({ width, height: 720 })
    const overflow = await page.evaluate<number>(
      `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
    )
    expect(overflow, `page overflow at ${width}px`).toBeLessThanOrEqual(0)
  }
  await page.screenshot({
    path: testInfo.outputPath("sessions-connectors-390.png"),
    fullPage: true,
  })
})
