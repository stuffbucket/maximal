// Playwright checks for the Dashboard's live sessions: the live card beside the
// quotas, the session table, and how the two link up. They run against the UI
// harness (mock backend) rather than a real proxy:
//
//   bun run ui:harness -- --port 4747      # in another terminal
//   bunx playwright test tests/e2e/dashboard-live.spec.ts
//
// Set UI_HARNESS_URL for a harness on another port. Each test switches the
// harness to its `live-sessions` scenario first. Screenshots are written under
// test-results/ for a person to look at; they are not compared to baselines.
//
// The callbacks passed to page.evaluate run in the browser, so they are written
// as strings: the root tsconfig has no DOM types.
import { type Page, type Route, expect, test } from "@playwright/test"

import type {
  SessionView,
  SessionsResponse,
} from "../../src/lib/token-usage/sessions-schema"

const BASE = process.env.UI_HARNESS_URL ?? "http://127.0.0.1:4747"
const DASHBOARD = `${BASE}/ui/dashboard/`
const SESSIONS = "**/token-usage/sessions"

test.use({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 })

test.beforeEach(async ({ request }) => {
  const res = await request.post(`${BASE}/__harness/scenario`, {
    data: { id: "live-sessions" },
  })
  expect(res.ok(), `UI harness not reachable at ${BASE}`).toBe(true)
})

/** Open the Dashboard and wait for the table rows and the traces. */
async function open(page: Page): Promise<Array<string>> {
  const errors: Array<string> = []
  page.on("pageerror", (error) => errors.push(String(error)))
  await page.goto(DASHBOARD)
  // The harness's scenario switcher floats over the bottom-right corner.
  await page.addStyleTag({
    content: "#__harness { display: none !important; }",
  })
  await expect(page.locator(".session-row").first()).toBeVisible()
  await expect(
    page.locator(".live__trace .live__line[d]").first(),
  ).toBeAttached()
  return errors
}

/** Row ids in table order, with "|" where the divider sits. */
async function tableOrder(page: Page): Promise<Array<string>> {
  return page.evaluate<Array<string>>(
    `[...document.querySelectorAll("#sessions-table tbody tr")].map((tr) =>
      tr.classList.contains("session-divider") ? "|" : tr.dataset.sessionId)`,
  )
}

/** Serve the sessions endpoint from `edit` applied to the harness's live payload. */
async function routeSessions(
  page: Page,
  edit: (view: SessionsResponse) => SessionsResponse,
): Promise<void> {
  await page.route(SESSIONS, async (route: Route) => {
    const res = await route.fetch()
    const view = (await res.json()) as SessionsResponse
    await route.fulfill({ response: res, json: edit(view) })
  })
}

test("the live card sits beside the quotas, and nothing overflows", async ({
  page,
}) => {
  const errors = await open(page)
  // The border turns while tokens flow (the reduced-motion test stops it).
  await expect(page.locator(".live--border")).toHaveCSS(
    "animation-name",
    "live-border-spin",
  )
  const live = await page.locator(".live").boundingBox()
  const quota = await page
    .locator("#usage-quotas .dashboard-bento__body")
    .boundingBox()
  expect(live).not.toBeNull()
  expect(quota).not.toBeNull()
  if (!live || !quota) return
  expect(Math.abs(live.y - quota.y)).toBeLessThanOrEqual(2)
  expect(live.height).toBeGreaterThanOrEqual(quota.height - 2)

  // The session table comes after the bento and before the per-request table.
  const table = await page.locator("#sessions").boundingBox()
  const events = await page.locator("#token-usage").boundingBox()
  expect(
    table && events && table.y > live.y + live.height && table.y < events.y,
  ).toBe(true)

  for (const width of [900, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const overflow = await page.evaluate<number>(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    )
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0)
  }
  expect(errors).toEqual([])
})

test("clicking a trace selects its row and brings it into view", async ({
  page,
}) => {
  await open(page)
  // Shrink the window so the table starts below the fold.
  await page.setViewportSize({ width: 1100, height: 420 })
  const hit = await firstTracePoint(page)
  const row = page.locator(`.session-row[data-session-id="${hit.id}"]`)
  await expect(row).not.toBeInViewport()
  await page.mouse.click(hit.x, hit.y)
  const id = hit.id
  await expect(row).toHaveClass(/session-row--selected/)
  await expect(row).toBeInViewport()
  await expect(
    page.locator(`.live__trace[data-session-id="${id}"]`),
  ).toHaveClass(/live__trace--selected/)
  // Only this row is selected.
  await expect(page.locator(".session-row--selected")).toHaveCount(1)
})

test("Escape and a click on empty plot space clear the selection", async ({
  page,
}) => {
  await open(page)
  await page.locator(".session-row").first().click()
  await expect(page.locator(".session-row--selected")).toHaveCount(1)
  await page.keyboard.press("Escape")
  await expect(page.locator(".session-row--selected")).toHaveCount(0)

  await page.locator(".session-row").first().focus()
  await page.keyboard.press("Enter")
  await expect(page.locator(".session-row--selected")).toHaveCount(1)
  // The plot's top-left corner: above every trace (the busiest one peaks
  // at the right edge in the harness data).
  const plot = await page.locator(".live__plot").boundingBox()
  if (!plot) throw new Error("no plot")
  await page.mouse.click(plot.x + 2, plot.y + 2)
  await expect(page.locator(".session-row--selected")).toHaveCount(0)
})

test("a selection and the open quota section survive a poll and a full re-render", async ({
  page,
}) => {
  await open(page)
  const id = await clickFirstTrace(page)
  await page.locator("details[data-quota-more] > summary").click()
  expect(await detailsOpen(page)).toBe(true)

  // One sessions poll comes and goes.
  await page.waitForResponse((res) =>
    res.url().endsWith("/token-usage/sessions"),
  )
  await page.waitForTimeout(300)
  await page.evaluate(
    `window.postMessage({ type: "maximal:set-locale" }, location.origin)`,
  )
  await page.waitForTimeout(300)

  await expect(
    page.locator(`.session-row[data-session-id="${id}"]`),
  ).toHaveClass(/session-row--selected/)
  await expect(
    page.locator(`.live__trace[data-session-id="${id}"]`),
  ).toHaveClass(/live__trace--selected/)
  expect(await detailsOpen(page)).toBe(true)
})

test("a countdown that reaches zero moves its row below the line", async ({
  page,
}) => {
  test.setTimeout(60_000)
  // One payload, captured once: the harness regenerates its data per poll,
  // so its near-cold session would never actually run out.
  const frozen: { view?: Promise<SessionsResponse> } = {}
  await page.route(SESSIONS, async (route: Route) => {
    frozen.view ??= route
      .fetch()
      .then((res) => res.json() as Promise<SessionsResponse>)
    await route.fulfill({ json: await frozen.view })
  })
  await open(page)
  if (!frozen.view) throw new Error("sessions were never fetched")
  const view = await frozen.view
  const now = Date.now()
  const nearCold = view.sessions.find(
    (s: SessionView) =>
      s.state === "warm"
      && s.cache.expires_at_ms !== null
      && s.cache.expires_at_ms - now < 25_000,
  )
  if (!nearCold) throw new Error("the harness has no session about to go cold")

  const position = async (): Promise<"above" | "below"> => {
    const order = await tableOrder(page)
    return (
        order.indexOf(nearCold.id) > order.indexOf("|") && order.includes("|")
      ) ?
        "below"
      : "above"
  }
  expect(await position()).toBe("above")
  await expect
    .poll(position, { timeout: 25_000, intervals: [500] })
    .toBe("below")
  await expect(
    page.locator(`.live__trace[data-session-id="${nearCold.id}"]`),
  ).toHaveCount(0)
})

test("past six live sessions, the seventh draws in neutral ink and has no swatch", async ({
  page,
}) => {
  await routeSessions(page, (view) => {
    const warm = view.sessions.filter((s) => s.state === "warm")
    const extra = [0, 1].map((i) => ({
      ...warm[i % warm.length],
      id: `extra-${i}`,
      rate_per_min: 10 + i,
    }))
    return { ...view, sessions: [...view.sessions, ...extra] }
  })
  await open(page)

  const live = await page.evaluate<Array<{ id: string; swatch: boolean }>>(
    `[...document.querySelectorAll(".session-row:not(.session-row--cold)")]
      .filter((tr) => !tr.dataset.sessionId.startsWith("other:"))
      .map((tr) => ({ id: tr.dataset.sessionId, swatch: !!tr.querySelector(".session-swatch") }))`,
  )
  expect(live).toHaveLength(7)
  const plain = live.filter((row) => !row.swatch)
  expect(plain).toHaveLength(1)

  const [neutral, stroke] = await page.evaluate<[string, string]>(`(() => {
    const probe = document.createElement("span")
    probe.style.color = "var(--border-strong)"
    document.body.append(probe)
    const neutral = getComputedStyle(probe).color
    probe.remove()
    const line = document.querySelector('.live__trace[data-session-id="${plain[0].id}"] .live__line')
    return [neutral, line ? getComputedStyle(line).stroke : ""]
  })()`)
  expect(stroke).toBe(neutral)

  // It is still clickable.
  await page.locator(`.session-row[data-session-id="${plain[0].id}"]`).click()
  await expect(
    page.locator(`.live__trace[data-session-id="${plain[0].id}"]`),
  ).toHaveClass(/live__trace--selected/)
})

for (const scheme of ["light", "dark"] as const) {
  test(`screenshot, ${scheme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" })
    await open(page)
    await page.locator(".session-row").nth(1).click()
    await page.waitForTimeout(1_000) // the traces' glide
    await page.screenshot({
      path: testInfo.outputPath(`dashboard-live-${scheme}.png`),
      fullPage: true,
      mask: [
        page.locator(".live__value"),
        page.locator(".live__counts"),
        page.locator(".session-cell--state"),
        page.locator(".session-cell--num"),
        page.locator("#token-usage-range"),
      ],
    })
  })
}

test("screenshot, phone width in German", async ({ page }, testInfo) => {
  await page.addInitScript(`localStorage.setItem("maximal.locale", "de")`)
  await page.setViewportSize({ width: 390, height: 1400 })
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
  await open(page)
  const overflow = await page.evaluate<number>(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  )
  expect(overflow).toBeLessThanOrEqual(0)
  await page.screenshot({
    path: testInfo.outputPath("dashboard-live-390-de.png"),
    fullPage: true,
  })
})

test("under reduced motion the border does not turn", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await open(page)
  // Tokens are flowing in the harness data, so the border would turn otherwise.
  await expect(page.locator(".live--flowing")).toBeAttached()
  await expect(page.locator(".live--border")).toHaveCSS(
    "animation-name",
    "none",
  )
})

/**
 * A point on the first trace's hit path (its wide transparent stroke) where
 * that trace is the top-most target, and the trace's session id.
 */
async function firstTracePoint(
  page: Page,
): Promise<{ id: string; x: number; y: number }> {
  const hit = await page.evaluate<{
    id: string
    x: number
    y: number
  } | null>(`(() => {
    const g = document.querySelector(".live__trace")
    const path = g.querySelector(".live__hit")
    const length = path.getTotalLength()
    const ctm = path.getScreenCTM()
    for (let i = 1; i < 40; i++) {
      const p = path.getPointAtLength((length * i) / 40).matrixTransform(ctm)
      const top = document.elementFromPoint(p.x, p.y)
      if (top && top.closest(".live__trace") === g) return { id: g.dataset.sessionId, x: p.x, y: p.y }
    }
    return null
  })()`)
  if (!hit) throw new Error("no clickable point on the first trace")
  return hit
}

/** Click the first trace on its hit path; returns its session id. */
async function clickFirstTrace(page: Page): Promise<string> {
  const hit = await firstTracePoint(page)
  await page.mouse.click(hit.x, hit.y)
  return hit.id
}

function detailsOpen(page: Page): Promise<boolean> {
  return page.evaluate<boolean>(
    `document.querySelector("details[data-quota-more]").open`,
  )
}
