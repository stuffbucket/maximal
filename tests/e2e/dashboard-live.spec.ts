// Playwright checks for the Dashboard's live sessions: the live card beside the
// quotas, the session table, and how the two link up. They run against the UI
// harness (mock backend) rather than a real proxy:
//
//   bun run ui:harness -- --port 4747      # in another terminal
//   bun run test:e2e
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

const isSessions = (url: string): boolean =>
  url.endsWith("/token-usage/sessions")

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

  // At this width the session table fits its frame without scrolling.
  const tableOverflow = await page.evaluate<number>(
    `(() => { const s = document.querySelector("#sessions-table .overflow-auto"); return s.scrollWidth - s.clientWidth })()`,
  )
  expect(
    tableOverflow,
    "session table scrolls sideways at 1100px",
  ).toBeLessThanOrEqual(0)

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
  // Escape meant for a form control (the language menu) leaves it alone.
  await page.locator("#locale-select").focus()
  await page.keyboard.press("Escape")
  await expect(page.locator(".session-row--selected")).toHaveCount(1)
  await page.locator(".session-row").first().focus()
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

  // A sessions poll is applied: the next one is only asked for once the
  // previous answer has been drawn.
  await page.waitForResponse((res) => isSessions(res.url()))
  await page.waitForRequest((req) => isSessions(req.url()))

  // A full re-render: render() rebuilds the quota column from strings, so a
  // marker left on it is gone once it has run.
  await page.evaluate(
    `document.querySelector("#usage-quotas .dashboard-bento__body").setAttribute("data-sentinel", "")`,
  )
  await page.evaluate(
    `window.postMessage({ type: "maximal:set-locale" }, location.origin)`,
  )
  await expect
    .poll(() => page.locator("#usage-quotas [data-sentinel]").count())
    .toBe(0)

  await expect(
    page.locator(`.session-row[data-session-id="${id}"]`),
  ).toHaveClass(/session-row--selected/)
  await expect(
    page.locator(`.live__trace[data-session-id="${id}"]`),
  ).toHaveClass(/live__trace--selected/)
  expect(await detailsOpen(page)).toBe(true)
})

test("the context meter warns from 75%, turns critical from 90%, and Other requests has none", async ({
  page,
}) => {
  await open(page)
  const context = (id: string) =>
    page.locator(`.session-row[data-session-id="${id}"] .session-context`)

  // The harness's streaming session is 78% full, its Codex session 93%,
  // and one Claude session 30%.
  const warning = context("4f1c9a52-7d3e-4b08-9a61-2c5e8d7f0b13")
  await expect(warning.locator(".meter")).toHaveClass(/meter--low/)
  await expect(warning.locator(".meter-state")).toHaveClass(/meter-state--low/)
  await expect(warning.locator(".session-context__icon svg")).toBeVisible()
  await expect(warning).toContainText("78%")

  const critical = context("0c8d3e17-9b42-4f6a-a1d5-7e3b2f8c9d04")
  await expect(critical.locator(".meter")).toHaveClass(/meter--out/)
  await expect(critical.locator(".meter-state")).toHaveClass(/meter-state--out/)
  await expect(critical.locator(".session-context__icon svg")).toBeVisible()
  await expect(critical).toContainText("93%")

  const fine = context("b7e20d64-1a95-4c3f-8e72-5f9a0c4d6e21")
  await expect(fine.locator(".meter")).toHaveClass(/meter--ok/)
  await expect(fine.locator(".session-context__icon")).toBeHidden()

  const other = context("other:claude-desktop")
  await expect(other.locator(".meter")).toBeHidden()
  await expect(other).toHaveText("—")
})

test("the context meter marks a lower ceiling and the compaction point, and its tooltip credits each number", async ({
  page,
}) => {
  await open(page)
  // The harness's warm Codex session: Codex's window 272,000, Copilot's
  // ceiling 128,000, compaction at 115,200, 119,000 used.
  const codex = page.locator(
    '.session-row[data-session-id="0c8d3e17-9b42-4f6a-a1d5-7e3b2f8c9d04"] .session-context',
  )
  await expect(codex).toHaveAttribute(
    "title",
    "119,000 of 128,000, Copilot's limit (272,000 is the size Codex uses for this model)\nCompacts at 115,200",
  )
  await expect(codex).toContainText("93%")

  /** Where a tick's centre sits along its meter, from 0 to 1. */
  const along = async (tick: "ceiling" | "compact"): Promise<number> => {
    const meter = await codex.locator(".meter").boundingBox()
    const mark = await codex.locator(`.meter__tick--${tick}`).boundingBox()
    if (!meter || !mark) throw new Error(`no ${tick} tick`)
    return (mark.x + mark.width / 2 - meter.x) / meter.width
  }
  await expect(codex.locator(".meter__tick--ceiling")).toBeVisible()
  await expect(codex.locator(".meter__tick--compact")).toBeVisible()
  expect(await along("ceiling")).toBeCloseTo(128_000 / 272_000, 1)
  expect(await along("compact")).toBeCloseTo(115_200 / 272_000, 1)
  // The fill ends between the two: past compaction, short of the ceiling.
  const fill = await codex.locator(".meter__fill").boundingBox()
  const meter = await codex.locator(".meter").boundingBox()
  if (!fill || !meter) throw new Error("no meter")
  expect(fill.width / meter.width).toBeCloseTo(119_000 / 272_000, 1)

  // A Claude session whose window is the ceiling: no ticks, one source.
  const claude = page.locator(
    '.session-row[data-session-id="b7e20d64-1a95-4c3f-8e72-5f9a0c4d6e21"] .session-context',
  )
  await expect(claude).toHaveAttribute(
    "title",
    "60,000 of 200,000 (the size Maximal lists for this model)",
  )
  await expect(claude.locator(".meter__tick--ceiling")).toBeHidden()
  await expect(claude.locator(".meter__tick--compact")).toBeHidden()
})

test("past 20 cold sessions the rest fold under Show N more, which survives a poll", async ({
  page,
}) => {
  await routeSessions(page, (view) => {
    const template = view.sessions.find(
      (s) => s.state === "cold" && !s.id.startsWith("other:"),
    )
    if (!template) throw new Error("the harness has no cold session")
    const extra = Array.from({ length: 30 }, (_, i) => ({
      ...template,
      id: `cold-extra-${String(i).padStart(2, "0")}`,
      last_request_at_ms: template.last_request_at_ms - (i + 1) * 60_000,
    }))
    return { ...view, sessions: [...view.sessions, ...extra] }
  })
  await open(page)

  /** Session rows below the divider (the button's row has no session id). */
  const coldShown = async (): Promise<number> => {
    const order = await tableOrder(page)
    return order.slice(order.indexOf("|") + 1).filter(Boolean).length
  }
  // The harness has three cold rows of its own: 33 in all.
  const more = page.locator(".session-more__button")
  await expect(more).toHaveText("Show 13 more")
  expect(await coldShown()).toBe(20)

  // A poll later it's the same.
  await page.waitForResponse((res) => isSessions(res.url()))
  await page.waitForTimeout(200)
  await expect(more).toHaveText("Show 13 more")
  expect(await coldShown()).toBe(20)

  await more.focus()
  await page.keyboard.press("Enter")
  await expect(more).toHaveCount(0)
  expect(await coldShown()).toBe(33)
  // The first row it revealed has the focus.
  const order = await tableOrder(page)
  const firstRevealed = order[order.indexOf("|") + 21]
  expect(
    await page.evaluate<string | undefined>(
      "document.activeElement?.dataset?.sessionId",
    ),
  ).toBe(firstRevealed)
})

test("a long cache countdown reads in hours and a time from another day names the day", async ({
  page,
}) => {
  const now = Date.now()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  await routeSessions(page, (view) => ({
    ...view,
    sessions: view.sessions.map((s) =>
      s.id === "e92a5b08-3c71-4d0e-b6f4-8a1d7c2e5f39" ?
        {
          ...s,
          // A 24-hour Responses retention, two minutes in.
          cache: {
            ...s.cache,
            ttl_s: 86_400,
            expires_at_ms: now + 86_400_000 - 120_000,
          },
          started_at_ms: yesterday.getTime(),
        }
      : s,
    ),
  }))
  await open(page)
  const row = page.locator(
    '.session-row[data-session-id="e92a5b08-3c71-4d0e-b6f4-8a1d7c2e5f39"]',
  )
  await expect(row.locator(".session-cell--state")).toContainText(
    "Warm, cold in about 24 hr",
  )
  const day = new Intl.DateTimeFormat("en", { weekday: "short" }).format(
    yesterday,
  )
  await expect(row).toContainText(`started ${day} `)
})

test("a read that hangs is given up, reported, and the polling carries on", async ({
  page,
}) => {
  test.setTimeout(45_000)
  let requests = 0
  await page.route(SESSIONS, async (route: Route) => {
    requests += 1
    // The second read never answers; the others go through.
    if (requests !== 2) await route.continue()
  })
  await open(page)

  const error = page.locator(".live__error")
  await expect(error).toBeVisible({ timeout: 20_000 })
  await expect(error).toContainText("An Error Occurred")
  // What's shown stays, and the next read clears the error.
  await expect(page.locator(".session-row").first()).toBeVisible()
  await expect(error).toBeHidden({ timeout: 10_000 })
  expect(requests).toBeGreaterThanOrEqual(3)
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
