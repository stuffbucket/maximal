import { expect, test, type Page } from "@playwright/test"

/**
 * Settings in a plain browser against a headless Maximal that requires API
 * keys (#672). Key enforcement is modelled at the network boundary against
 * the real built Settings UI; the server's own enforcement and origin checks
 * are covered by tests/request-auth*.test.ts and tests/events-route.test.ts.
 */

const BASE = process.env.UI_HARNESS_URL ?? "http://127.0.0.1:4747"
const SETTINGS = `${BASE}/ui/settings/#connectors/workiq`
const KEY = "browser-auth-test-key"
const STORAGE_KEY = "maximal.browserApiKey"
const CHALLENGE = { "www-authenticate": 'Bearer realm="copilot-api"' }

async function enforceKey(
  page: Page,
  allowed: () => boolean = () => true,
): Promise<void> {
  await page.route("**/settings/api/**", async (route) => {
    const url = new URL(route.request().url())
    const authenticated =
      route.request().headers()["x-api-key"] === KEY
      || (url.pathname === "/settings/api/events"
        && url.searchParams.get("key") === KEY)
    await (allowed() && authenticated ?
      route.fallback()
    : route.fulfill({
        status: 401,
        headers: CHALLENGE,
        json: {
          error: { message: "Unauthorized", type: "authentication_error" },
        },
      }))
  })
}

const access = (page: Page) =>
  page.getByRole("dialog", { name: "Connect this browser to Maximal" })
const workiq = (page: Page) =>
  page.getByRole("dialog", { name: "Work IQ", exact: true })
const topbarAccess = (page: Page, name: string) =>
  page.locator("#browser-auth-root").getByRole("button", { name, exact: true })
const storedKey = (page: Page) =>
  page.evaluate((k) => sessionStorage.getItem(k), STORAGE_KEY)

async function connect(page: Page): Promise<void> {
  await access(page).getByLabel("Maximal API key", { exact: true }).fill(KEY)
  await access(page)
    .getByRole("button", { name: "Connect browser", exact: true })
    .click()
  await expect(access(page)).not.toBeVisible()
  await expect(workiq(page)).toBeVisible()
}

test.use({
  viewport: { width: 1100, height: 900 },
  contextOptions: { reducedMotion: "reduce" },
})

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${BASE}/__harness/scenario`, {
    data: { id: "connectors-detail-ready" },
  })
  expect(response.ok()).toBe(true)
})

test("401 prompts for access, rejects a bad key, and connects without losing the deep link", async ({
  page,
}) => {
  await enforceKey(page)
  await page.goto(SETTINGS)
  await expect(access(page)).toBeVisible()
  const field = access(page).getByLabel("Maximal API key", { exact: true })
  await expect(field).toBeFocused()
  await expect(field).toHaveAttribute("type", "password")
  await expect(access(page).locator("code")).toHaveText(
    "maximal api claude-code",
  )
  await field.fill("not-a-valid-key")
  await access(page)
    .getByRole("button", { name: "Connect browser", exact: true })
    .click()
  await expect(access(page).getByRole("alert")).toContainText(
    "That key was not accepted",
  )
  await expect(field).toHaveAttribute("aria-invalid", "true")
  await expect(field).toBeFocused()
  expect(await storedKey(page)).toBeNull()
  await page.screenshot({ path: "test-results/browser-auth-prompt.png" })

  await connect(page)
  await expect(page).toHaveURL(SETTINGS)
  expect(await storedKey(page)).toBe(KEY)
  expect(
    await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY),
  ).toBeNull()
  await page.reload()
  await expect(workiq(page)).toBeVisible()
  await expect(access(page)).not.toBeVisible()
  await page.screenshot({ path: "test-results/browser-auth-connected.png" })
})

test("an authenticated browser saves a tool permission and sees it after reload", async ({
  page,
}) => {
  await enforceKey(page)
  await page.goto(SETTINGS)
  await connect(page)
  const blocked = page
    .locator(".tool")
    .first()
    .getByRole("radio", { name: "Blocked", exact: true })
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/tool-permissions")
      && response.request().method() === "PUT",
  )
  await blocked.click()
  expect((await saved).status()).toBe(200)
  await expect(blocked).toBeChecked()
  await page.reload()
  await expect(blocked).toBeChecked()
})

test("a refused mutation is not replayed after reconnecting", async ({
  page,
}) => {
  await enforceKey(page)
  await page.goto(SETTINGS)
  await connect(page)
  let writes = 0
  await page.route(
    "**/settings/api/plugins/workiq/tool-permissions",
    async (route) => {
      writes++
      await route.fulfill({
        status: 401,
        headers: CHALLENGE,
        json: { error: { message: "Unauthorized" } },
      })
    },
  )
  await page
    .locator(".tool")
    .first()
    .getByRole("radio", { name: "Blocked", exact: true })
    .click()
  await expect(access(page)).toBeVisible()
  await connect(page)
  expect(writes).toBe(1)
})

test("live updates send the key in headers, never in a request URL", async ({
  page,
}) => {
  await enforceKey(page)
  const urls: Array<string> = []
  page.on("request", (request) => urls.push(request.url()))
  await page.goto(SETTINGS)
  const stream = page.waitForRequest(
    (request) =>
      request.url().endsWith("/settings/api/events")
      && request.headers()["x-api-key"] === KEY,
  )
  await connect(page)
  const request = await stream
  expect(request.url()).not.toContain("?")
  expect(urls.some((url) => url.includes(KEY))).toBe(false)
})

test("disconnect clears the tab's key without signing out of anything", async ({
  page,
}) => {
  await enforceKey(page)
  const signOuts: Array<string> = []
  page.on("request", (request) => {
    if (/sign-?out|logout/.test(request.url())) signOuts.push(request.url())
  })
  await page.goto(SETTINGS)
  await connect(page)
  await workiq(page).getByRole("button", { name: "Close", exact: true }).click()
  await topbarAccess(page, "Disconnect browser").click()
  await expect(access(page)).toBeVisible()
  expect(await storedKey(page)).toBeNull()
  expect(signOuts).toEqual([])
})

test("a revoked key is cleared and prompts again, rather than suggesting a restart", async ({
  page,
}) => {
  let allowed = true
  await enforceKey(page, () => allowed)
  await page.goto(SETTINGS)
  await connect(page)
  allowed = false
  await page.reload()
  await expect(access(page)).toBeVisible()
  expect(await storedKey(page)).toBeNull()
  await expect(
    page.getByText("Restarting Maximal reconnects them."),
  ).toHaveCount(0)
})

test("a cancelled prompt can be reopened from the title bar and from a problem", async ({
  page,
}) => {
  await enforceKey(page)
  await page.goto(`${BASE}/ui/settings/#connectors`)
  await expect(access(page)).toBeVisible()
  await access(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click()
  await expect(access(page)).not.toBeVisible()
  await expect(
    page.getByText("This browser isn't connected to Maximal").first(),
  ).toBeVisible()
  await page.screenshot({ path: "test-results/browser-auth-problem.png" })
  await topbarAccess(page, "Connect browser").click()
  await expect(access(page)).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(access(page)).not.toBeVisible()
  await page
    .locator(".callout")
    .getByRole("button", { name: "Connect browser", exact: true })
    .first()
    .click()
  await expect(access(page)).toBeVisible()
})

test("the access icon never pushes the Settings tabs out of a narrow window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 860, height: 700 })
  await enforceKey(page)
  await page.goto(`${BASE}/ui/settings/#account`)
  await access(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click()
  const icon = topbarAccess(page, "Connect browser")
  await expect(icon).toBeVisible()
  await expect(icon).toHaveAttribute("title", "Connect browser")
  const overflow = await page.evaluate<number>(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  )
  expect(overflow).toBe(0)
  await expect(
    page.locator('[data-settings-nav] [aria-current="page"]'),
  ).toBeInViewport()
  await page.screenshot({ path: "test-results/browser-auth-topbar.png" })
})

test("a browser with enforcement off needs no access dialog", async ({
  page,
}) => {
  await page.goto(SETTINGS)
  await expect(workiq(page)).toBeVisible()
  await expect(access(page)).not.toBeVisible()
  await expect(page.locator("[data-browser-access]")).toHaveCount(0)
})

test("the native shell still supplies its own key and never offers browser access", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    Object.assign(globalThis, {
      __TAURI_INTERNALS__: {
        invoke: (command: string) =>
          Promise.resolve(command === "get_shell_api_key" ? key : null),
      },
    })
  }, KEY)
  await enforceKey(page)
  const live = page.waitForResponse((response) =>
    response.url().includes("/settings/api/events?key="),
  )
  await page.goto(SETTINGS)
  await expect(workiq(page)).toBeVisible()
  expect((await live).status()).toBe(200)
  await expect(page.locator("#browser-auth-root")).toBeHidden()
  await expect(access(page)).toHaveCount(0)
  expect(await storedKey(page)).toBeNull()
})

for (const enforced of [true, false]) {
  test(`an upstream 401 keeps browser access with enforcement ${enforced ? "on" : "off"}`, async ({
    page,
  }) => {
    if (enforced) await enforceKey(page)
    await page.goto(SETTINGS)
    await (enforced ? connect(page) : expect(workiq(page)).toBeVisible())
    await page.goto(`${BASE}/ui/settings/#models`)
    await page.route("**/settings/api/models/refresh", (route) =>
      route.fulfill({ status: 401, json: { error: "not_authenticated" } }),
    )
    await page.getByRole("button", { name: "Refresh now" }).click()
    await expect(
      page.getByText("You're not signed in to GitHub Copilot", { exact: true }),
    ).toBeVisible()
    await expect(access(page)).not.toBeVisible()
    expect(await storedKey(page)).toBe(enforced ? KEY : null)
  })
}

test("missing browser access is not shown as a failed GitHub sign-in", async ({
  page,
}) => {
  await enforceKey(page)
  await page.goto(`${BASE}/ui/settings/#account`)
  await expect(access(page)).toBeVisible()
  await access(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click()
  await expect(page.locator('[data-state-account="error"]')).toBeHidden()
})

test("blocked session storage says so instead of looping", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage disabled", "SecurityError")
    }
  })
  await enforceKey(page)
  await page.goto(SETTINGS)
  await access(page).getByLabel("Maximal API key", { exact: true }).fill(KEY)
  await access(page)
    .getByRole("button", { name: "Connect browser", exact: true })
    .click()
  await expect(access(page).getByRole("alert")).toContainText(
    "Allow session storage",
  )
})
