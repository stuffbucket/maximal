import { expect, test } from "@playwright/test"

const BASE = process.env.UI_HARNESS_URL ?? "http://127.0.0.1:4747"
const SYSTEM = `${BASE}/ui/settings/#system`
const ROOT = '[data-section="diagnostics"]'

// Any Settings width can be checked: UI_VIEWPORT_WIDTH=772 (the minimum) or wider.
test.use({
  viewport: {
    width: Number(process.env.UI_VIEWPORT_WIDTH ?? 960),
    height: 900,
  },
  deviceScaleFactor: 1,
})

test.beforeEach(async ({ page, request }) => {
  const response = await request.post(`${BASE}/__harness/scenario`, {
    data: { id: "signed-in" },
  })
  expect(response.ok(), `UI harness not reachable at ${BASE}`).toBe(true)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(SYSTEM)
  await page.addStyleTag({
    content: "#__harness { display: none !important; }",
  })
  await expect(
    page.locator(`${ROOT} [data-diagnostics-root][aria-busy="false"]`),
  ).toBeVisible()
})

test("System is one section with a single display heading and no separate Logs section", async ({
  page,
}) => {
  await expect(page.locator('[data-section="logs"]')).toHaveCount(0)
  const visible = page.locator("[data-section]:not([hidden])")
  await expect(visible).toHaveCount(1)

  const title = page.locator(`${ROOT} h2.section__title`)
  await expect(title).toHaveCount(1)
  await expect(title).toHaveText("System")
  await expect(title).toHaveCSS("font-family", /Fraunces/)

  // Every step below the display heading is body type, never a second one.
  const steps = page.locator(`${ROOT} h3`)
  await expect(steps).toHaveText([
    "Version and updates",
    "Troubleshooting",
    "Uninstall",
  ])
  for (const step of await steps.all()) {
    await expect(step).not.toHaveCSS("font-family", /Fraunces/)
  }

  // The outline stays flat with the disclosure open: nothing inside it is a
  // heading that would nest under Troubleshooting.
  await page.locator(`${ROOT} details[data-system-details] summary`).click()
  await expect(page.locator(ROOT).getByRole("heading")).toHaveText([
    "System",
    "Version and updates",
    "Troubleshooting",
    "Uninstall",
  ])
})

test("everyday version, update and troubleshooting controls come first and stay visible", async ({
  page,
}) => {
  const section = page.locator(ROOT)
  await expect(section.getByText("Proxy version")).toBeVisible()
  await expect(section.getByText("Update check", { exact: true })).toBeVisible()
  const checkNow = section.getByRole("button", { name: "Check now" })
  const copy = section.getByRole("button", { name: "Copy debug bundle" })
  const logs = section.locator('[data-action="reveal-logs"]')
  const config = section.locator('[data-action="reveal-config"]')
  for (const control of [checkNow, copy, logs, config]) {
    await expect(control).toBeVisible()
  }

  // Low-level runtime values are closed behind the disclosure.
  const details = section.locator("details[data-system-details]")
  await expect(details).not.toHaveAttribute("open")
  await expect(section.getByText("Git SHA", { exact: true })).toBeHidden()
  await expect(section.getByText("Sidecar PID", { exact: true })).toBeHidden()
  await expect(section.getByText("Retention", { exact: true })).toBeHidden()

  // Reading order: status, actions, then the disclosure.
  const top = async (locator: typeof copy): Promise<number> =>
    (await locator.boundingBox())?.y ?? Number.NaN
  expect(await top(checkNow)).toBeLessThan(await top(copy))
  expect(await top(copy)).toBeLessThan(await top(details.locator("summary")))
})

test("the folder buttons read Open Logs and Open Config on every OS, on the same hooks", async ({
  page,
}) => {
  for (const platform of ["macOS", "Windows", "Linux"]) {
    await page.evaluate((value) => {
      Object.defineProperty(navigator, "userAgentData", {
        configurable: true,
        value: { platform: value },
      })
    }, platform)
    // Re-render the catalog sweep for the OS the page now reports.
    await page.locator("[data-locale-select]").selectOption("en-GB")
    await page.locator("[data-locale-select]").selectOption("en")
    await expect(
      page.locator(`${ROOT} [data-action="reveal-logs"]`),
    ).toHaveText("Open Logs")
    await expect(
      page.locator(`${ROOT} [data-action="reveal-config"]`),
    ).toHaveText("Open Config")
  }
  await expect(
    page.locator(ROOT).getByRole("button", { name: /Finder|Explorer|Files/u }),
  ).toHaveCount(0)
})

test("the technical details disclosure opens and closes from the keyboard", async ({
  page,
}) => {
  const details = page.locator(`${ROOT} details[data-system-details]`)
  const summary = details.locator("summary")
  await expect(summary).toContainText("Technical details")

  // Reach the summary the way a keyboard user does: Tab from the last
  // everyday button (the disabled Restart button is skipped).
  await page.locator(`${ROOT} [data-action="reveal-config"]`).focus()
  for (let step = 0; step < 3; step += 1) {
    if (
      (await page.evaluate("document.activeElement?.tagName")) === "SUMMARY"
    ) {
      break
    }
    await page.keyboard.press("Tab")
  }
  await expect(summary).toBeFocused()
  // The ring is really drawn, not just declared.
  await expect(summary).toHaveCSS("outline-style", "solid")
  await expect(summary).not.toHaveCSS("outline-width", "0px")
  await page.keyboard.press("Enter")
  await expect(details).toHaveAttribute("open", "")
  for (const label of [
    "Git SHA",
    "Launched from",
    "Sidecar PID",
    "Models cached",
    "Retention",
    "Where logs live",
  ]) {
    await expect(details.getByText(label, { exact: true })).toBeVisible()
  }

  await page.keyboard.press("Space")
  await expect(details).not.toHaveAttribute("open")
  await expect(details.getByText("Git SHA", { exact: true })).toBeHidden()
})

test("Uninstall sits apart from the diagnostics stack and an old #logs link lands on System", async ({
  page,
}) => {
  const uninstall = page.locator(`${ROOT} [data-uninstall-card]`)
  await expect(
    uninstall.getByRole("heading", { name: "Uninstall" }),
  ).toBeVisible()
  await expect(
    page.locator(`${ROOT} [data-diagnostics-root] [data-uninstall-body]`),
  ).toHaveCount(0)
  await expect(
    uninstall.getByRole("button", { name: /Uninstall Maximal/ }),
  ).toBeVisible()

  const stack = await page
    .locator(`${ROOT} [data-diagnostics-root]`)
    .boundingBox()
  const apart = await uninstall.boundingBox()
  expect(stack).not.toBeNull()
  expect(apart).not.toBeNull()
  if (!stack || !apart) return
  expect(apart.y).toBeGreaterThanOrEqual(stack.y + stack.height)
  await expect(uninstall).toHaveCSS("border-top-style", "solid")

  await page.goto(`${BASE}/ui/settings/#logs`)
  await expect(page.locator(ROOT)).toBeVisible()
  await expect.poll(() => new URL(page.url()).hash).toBe("#diagnostics")
})
