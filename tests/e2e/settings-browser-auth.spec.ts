import { expect, test, type Page } from "@playwright/test"

const BASE = process.env.UI_HARNESS_URL ?? "http://127.0.0.1:4747"
const SETTINGS = `${BASE}/ui/settings/#connectors/workiq`
const KEY = "browser-auth-test-key"
const STORAGE_KEY = "maximal.browserApiKey"

// Model enforcement at the network boundary, against the real built Settings UI.
// Backend enforcement and origin checks are separately covered by request-auth
// and settings-origin tests; these tests exercise the actual browser behavior.
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
        headers: { "www-authenticate": 'Bearer realm="copilot-api"' },
        json: {
          error: { message: "Unauthorized", type: "authentication_error" },
        },
      }))
  })
}

const access = (page: Page) =>
  page.getByRole("dialog", { name: "Connect this browser to Maximal" })

async function connect(page: Page): Promise<void> {
  await access(page).getByLabel("Maximal API key", { exact: true }).fill(KEY)
  await access(page)
    .getByRole("button", { name: "Connect browser", exact: true })
    .click()
  await expect(access(page)).not.toBeVisible()
  await expect(
    page.getByRole("dialog", { name: "Work IQ", exact: true }),
  ).toBeVisible()
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
  await expect(field).toBeFocused()
  expect(
    await page.evaluate((k) => sessionStorage.getItem(k), STORAGE_KEY),
  ).toBeNull()
  await page.screenshot({ path: "test-results/browser-auth-prompt.png" })

  await connect(page)
  await expect(page).toHaveURL(SETTINGS)
  expect(
    await page.evaluate((k) => sessionStorage.getItem(k), STORAGE_KEY),
  ).toBe(KEY)
  expect(
    await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY),
  ).toBeNull()
  await page.reload()
  await expect(
    page.getByRole("dialog", { name: "Work IQ", exact: true }),
  ).toBeVisible()
  await expect(access(page)).not.toBeVisible()
  await page.screenshot({ path: "test-results/browser-auth-connected.png" })
})

test("authenticated browser saves a tool permission and sees it after reload", async ({
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
        headers: { "www-authenticate": 'Bearer realm="copilot-api"' },
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

test("live updates send the key in headers, never in the request URL", async ({
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

test("disconnect clears the tab credential without changing GitHub sign-in", async ({
  page,
}) => {
  await enforceKey(page)
  const signOuts: Array<string> = []
  page.on("request", (request) => {
    if (request.url().includes("sign-out")) signOuts.push(request.url())
  })
  await page.goto(SETTINGS)
  await connect(page)
  await page
    .getByRole("dialog", { name: "Work IQ", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click()
  await page
    .getByRole("button", { name: "Disconnect browser", exact: true })
    .click()
  await expect(access(page)).toBeVisible()
  expect(
    await page.evaluate((k) => sessionStorage.getItem(k), STORAGE_KEY),
  ).toBeNull()
  expect(signOuts).toEqual([])
})

test("a revoked key is cleared and prompts again, rather than suggesting restart", async ({
  page,
}) => {
  let allowed = true
  await enforceKey(page, () => allowed)
  await page.goto(SETTINGS)
  await connect(page)
  allowed = false
  await page.reload()
  await expect(access(page)).toBeVisible()
  expect(
    await page.evaluate((k) => sessionStorage.getItem(k), STORAGE_KEY),
  ).toBeNull()
  await expect(
    page.getByText("Restarting Maximal reconnects them."),
  ).toHaveCount(0)
})

test("cancelled login can be reopened", async ({ page }) => {
  await enforceKey(page)
  await page.goto(SETTINGS)
  await expect(access(page)).toBeVisible()
  await access(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click()
  await expect(access(page)).not.toBeVisible()
  await page
    .locator("#browser-auth-root")
    .getByRole("button", { name: "Connect browser", exact: true })
    .click()
  await expect(access(page)).toBeVisible()
})

test("a browser with enforcement off needs no access dialog", async ({
  page,
}) => {
  await page.goto(SETTINGS)
  await expect(
    page.getByRole("dialog", { name: "Work IQ", exact: true }),
  ).toBeVisible()
  await expect(access(page)).not.toBeVisible()
  await expect(
    page.getByRole("button", { name: "Disconnect browser", exact: true }),
  ).toHaveCount(0)
})

test("native shell still supplies its own key and never offers browser login", async ({
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
  await expect(
    page.getByRole("dialog", { name: "Work IQ", exact: true }),
  ).toBeVisible()
  expect((await live).status()).toBe(200)
  await expect(page.locator("#browser-auth-root")).toBeHidden()
  await expect(access(page)).toHaveCount(0)
  expect(
    await page.evaluate((k) => sessionStorage.getItem(k), STORAGE_KEY),
  ).toBeNull()
})

for (const enforced of [true, false]) {
  test(`upstream 401 preserves browser access with enforcement ${enforced ? "on" : "off"}`, async ({
    page,
  }) => {
    if (enforced) await enforceKey(page)
    await page.goto(SETTINGS)
    await (enforced ?
      connect(page)
    : expect(
        page.getByRole("dialog", { name: "Work IQ", exact: true }),
      ).toBeVisible())
    await page.goto(`${BASE}/ui/settings/#models`)
    await page.route("**/settings/api/models/refresh", (route) =>
      route.fulfill({ status: 401, json: { error: "not_authenticated" } }),
    )
    await page.getByRole("button", { name: "Refresh now" }).click()
    await expect(
      page.getByText("You're not signed in to GitHub Copilot", { exact: true }),
    ).toBeVisible()
    await expect(access(page)).not.toBeVisible()
    expect(
      await page.evaluate((k) => sessionStorage.getItem(k), STORAGE_KEY),
    ).toBe(enforced ? KEY : null)
  })
}

test("missing browser access is not rendered as a failed GitHub sign-in", async ({
  page,
}) => {
  await enforceKey(page)
  await page.goto(`${BASE}/ui/settings/#account`)
  await expect(access(page)).toBeVisible()
  await access(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click()
  await expect(page.locator('[data-state-account="error"]')).toBeHidden()
  await expect(
    page.getByText("Failed to load auth status", { exact: false }),
  ).toHaveCount(0)
})

test("blocked session storage gives an actionable error instead of a reload loop", async ({
  page,
}) => {
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
