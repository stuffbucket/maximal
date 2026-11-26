import { type Page, expect, test } from "@playwright/test"

const BASE = process.env.UI_HARNESS_URL ?? "http://127.0.0.1:4747"
const APPS = `${BASE}/ui/settings/#apps`
const DESKTOP_TOGGLE = "**/settings/api/apps/claude-desktop/toggle"
const TITLE = "Restart Claude"
const RELAUNCH = "Quit and reopen Claude for this change to take effect."
const SIGN_IN_NOTE =
  "If Claude asks you to sign in and sign-in doesn’t complete, leave the integration enabled, quit Claude completely, reopen it, and try again."

// Any Settings width can be checked: UI_VIEWPORT_WIDTH=772 (the minimum) or wider.
test.use({
  viewport: {
    width: Number(process.env.UI_VIEWPORT_WIDTH ?? 960),
    height: 720,
  },
  deviceScaleFactor: 1,
})

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${BASE}/__harness/scenario`, {
    data: { id: "signed-in" },
  })
  expect(response.ok(), `UI harness not reachable at ${BASE}`).toBe(true)
})

async function openApps(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(APPS)
  await page.addStyleTag({
    content: "#__harness { display: none !important; }",
  })
  await expect(page.locator('[data-app-id="claude-desktop"]')).toBeVisible()
}

function card(page: Page, id: "claude-desktop" | "claude-code") {
  return page.locator(`[data-app-id="${id}"]`)
}

function toggle(page: Page, id: "claude-desktop" | "claude-code") {
  return card(page, id).locator("label.switch")
}

const dialog = (page: Page) => page.locator("dialog[open]")

/** Fulfil the Desktop toggle with `body` (status 200 unless given). */
async function answerToggle(
  page: Page,
  body: Record<string, unknown>,
  status = 200,
): Promise<void> {
  await page.route(DESKTOP_TOGGLE, (route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    }),
  )
}

const DESKTOP_ENTRY = {
  id: "claude-desktop",
  name: "Claude Desktop",
  kind: "config",
  status: "ready",
  installs: [],
  install: null,
}

test("after enabling: a restart dialog with the sign-in note; Got it dismisses and returns focus", async ({
  page,
}) => {
  await openApps(page)
  const desktop = card(page, "claude-desktop")
  await expect(desktop.getByRole("checkbox")).not.toBeChecked()
  await expect(dialog(page)).toHaveCount(0)

  const enable = page.waitForResponse(DESKTOP_TOGGLE)
  await toggle(page, "claude-desktop").click()
  await enable
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).getByRole("heading")).toHaveText(TITLE)
  await expect(dialog(page)).toHaveAccessibleName(TITLE)
  await expect(dialog(page)).toContainText(RELAUNCH)
  await expect(dialog(page)).toContainText(SIGN_IN_NOTE)
  // Informational: one action, no Cancel, no rollback.
  await expect(dialog(page).getByRole("button")).toHaveCount(1)
  const gotIt = dialog(page).getByRole("button", { name: "Got it" })
  await expect(gotIt).toBeFocused()
  await expect(gotIt).toHaveClass(/btn--primary/u)
  // The change was already applied before the dialog appeared.
  await expect(desktop.getByRole("checkbox")).toBeChecked()

  await page.screenshot({ path: "test-results/desktop-restart-enabled.png" })
  await gotIt.click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(desktop.getByRole("checkbox")).toBeChecked()
  await expect(desktop.getByRole("checkbox")).toBeFocused()
  // Nothing is left inline in the card.
  await expect(desktop.getByText(RELAUNCH)).toHaveCount(0)
})

test("after disabling: the same dialog without the sign-in note; Escape dismisses", async ({
  page,
}) => {
  await openApps(page)
  const desktop = card(page, "claude-desktop")

  await toggle(page, "claude-desktop").click()
  await expect(dialog(page)).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog(page)).toHaveCount(0)
  await expect(desktop.getByRole("checkbox")).toBeChecked()

  const disable = page.waitForResponse(DESKTOP_TOGGLE)
  await toggle(page, "claude-desktop").click()
  await disable
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).getByRole("heading")).toHaveText(TITLE)
  await expect(dialog(page)).toContainText(RELAUNCH)
  await expect(dialog(page)).not.toContainText("sign in")
  await expect(dialog(page).getByRole("button")).toHaveCount(1)
  await page.screenshot({ path: "test-results/desktop-restart-disabled.png" })
  await page.keyboard.press("Escape")
  await expect(dialog(page)).toHaveCount(0)
  await expect(desktop.getByRole("checkbox")).not.toBeChecked()
  await expect(desktop.getByRole("checkbox")).toBeFocused()
})

test("a click on the backdrop dismisses it", async ({ page }) => {
  await openApps(page)
  await toggle(page, "claude-desktop").click()
  await expect(dialog(page)).toBeVisible()
  await page.mouse.click(5, 700)
  await expect(dialog(page)).toHaveCount(0)
  await expect(card(page, "claude-desktop").getByRole("checkbox")).toBeChecked()
  await expect(card(page, "claude-desktop").getByRole("checkbox")).toBeFocused()
})

test("no dialog when enabling is refused", async ({ page }) => {
  await answerToggle(page, {
    ...DESKTOP_ENTRY,
    enabled: false,
    conflict: "foreign-gateway-profile",
  })
  await openApps(page)
  const desktop = card(page, "claude-desktop")

  await toggle(page, "claude-desktop").click()
  // The refusal turns the row's switch into Connect, which explains it.
  await expect(desktop.getByRole("button", { name: "Connect" })).toBeVisible()
  await expect(desktop.getByRole("checkbox")).toHaveCount(0)
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.getByText(RELAUNCH)).toHaveCount(0)
})

/**
 * Claude Desktop starts owned by another Maximal profile, so its row offers
 * Connect; confirming it is applied by the harness and the restart dialog
 * opens. Returns the Desktop row.
 */
async function connectOverOtherProfile(page: Page) {
  // The list says another Maximal profile owns Claude Desktop until this
  // page connects it; the harness then answers the toggle as applied.
  let connected = false
  await page.route("**/settings/api/apps", (route) => {
    if (connected || route.request().method() !== "GET") return route.fallback()
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apps: [
          {
            ...DESKTOP_ENTRY,
            enabled: false,
            conflict: "other-maximal-config",
          },
        ],
      }),
    })
  })
  await page.route(DESKTOP_TOGGLE, (route) => {
    connected = true
    return route.fallback()
  })
  await openApps(page)
  const desktop = card(page, "claude-desktop")

  await desktop.getByRole("button", { name: "Connect" }).click()
  const connect = dialog(page)
  await expect(connect).toHaveAccessibleName(
    "Connect Claude to this Maximal profile?",
  )
  const applied = page.waitForResponse(DESKTOP_TOGGLE)
  await connect.getByRole("button", { name: "Connect" }).click()
  await applied

  await expect(dialog(page)).toHaveCount(1)
  await expect(dialog(page)).toHaveAccessibleName(TITLE)
  await expect(dialog(page)).toContainText(RELAUNCH)
  await expect(dialog(page)).toContainText(SIGN_IN_NOTE)
  await expect(
    dialog(page).getByRole("button", { name: "Got it" }),
  ).toBeFocused()
  return desktop
}

// The Connect button that opened all this is gone once the change applies;
// however the restart dialog is dismissed, focus goes to the switch that
// replaced it rather than falling back to the page.
test("after connecting over another Maximal profile: the enable dialog; Got it puts focus on the switch", async ({
  page,
}) => {
  const desktop = await connectOverOtherProfile(page)
  await dialog(page).getByRole("button", { name: "Got it" }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(desktop.getByRole("checkbox")).toBeChecked()
  await expect(desktop.getByRole("checkbox")).toBeFocused()
})

test("after connecting over another Maximal profile: Escape puts focus on the switch", async ({
  page,
}) => {
  const desktop = await connectOverOtherProfile(page)
  await page.keyboard.press("Escape")
  await expect(dialog(page)).toHaveCount(0)
  await expect(desktop.getByRole("checkbox")).toBeChecked()
  await expect(desktop.getByRole("checkbox")).toBeFocused()
})

test("after connecting over another Maximal profile: a backdrop click puts focus on the switch", async ({
  page,
}) => {
  const desktop = await connectOverOtherProfile(page)
  await page.mouse.click(5, 700)
  await expect(dialog(page)).toHaveCount(0)
  await expect(desktop.getByRole("checkbox")).toBeChecked()
  await expect(desktop.getByRole("checkbox")).toBeFocused()
})

test("a refused transfer keeps the dialog open and the next step carries both confirmed overrides", async ({
  page,
}) => {
  const sent: Array<Record<string, unknown>> = []
  await page.route(DESKTOP_TOGGLE, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    sent.push(body)
    const both =
      body.overrideOtherMaximal === true && body.overrideForeignGateway === true
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...DESKTOP_ENTRY,
        enabled: both,
        conflict: both ? null : "foreign-gateway-profile",
      }),
    })
  })
  await page.route("**/settings/api/apps", (route) =>
    route.request().method() === "GET" ?
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          apps: [
            {
              ...DESKTOP_ENTRY,
              enabled: false,
              conflict: "other-maximal-config",
            },
          ],
        }),
      })
    : route.fallback(),
  )
  await openApps(page)
  const desktop = card(page, "claude-desktop")

  await desktop.getByRole("button", { name: "Connect" }).click()
  const refused = page.waitForResponse(DESKTOP_TOGGLE)
  await dialog(page).getByRole("button", { name: "Connect" }).click()
  await refused
  // Still open: nothing changed, and the gateway that's left is explained.
  await expect(dialog(page)).toHaveAccessibleName("Connect Claude")
  await expect(dialog(page)).toContainText("Nothing was changed.")
  await expect(page.getByText(RELAUNCH)).toHaveCount(0)

  const applied = page.waitForResponse(DESKTOP_TOGGLE)
  await dialog(page).getByRole("button", { name: "Take over" }).click()
  await applied
  expect(sent).toEqual([
    { enabled: true, overrideOtherMaximal: true },
    { enabled: true, overrideOtherMaximal: true, overrideForeignGateway: true },
  ])
  await expect(dialog(page)).toHaveAccessibleName(TITLE)
})

test("a failed Take over keeps the dialog open with the error", async ({
  page,
}) => {
  await page.route("**/settings/api/apps", (route) =>
    route.request().method() === "GET" ?
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          apps: [
            {
              ...DESKTOP_ENTRY,
              enabled: false,
              conflict: "foreign-gateway-profile",
            },
          ],
        }),
      })
    : route.fallback(),
  )
  await answerToggle(page, { error: { message: "Disk is read-only" } }, 500)
  await openApps(page)
  const desktop = card(page, "claude-desktop")

  await desktop.getByRole("button", { name: "Connect" }).click()
  const failed = page.waitForResponse(DESKTOP_TOGGLE)
  await dialog(page).getByRole("button", { name: "Take over" }).click()
  await failed

  await expect(dialog(page)).toHaveAccessibleName("Connect Claude")
  await expect(dialog(page).getByRole("alert")).toContainText(
    "Couldn’t connect Claude",
  )
  await expect(
    dialog(page).getByRole("button", { name: "Take over" }),
  ).toBeEnabled()
  await expect(page.getByText(RELAUNCH)).toHaveCount(0)
})

test("an unreadable configuration offers no Take over", async ({ page }) => {
  await page.route("**/settings/api/apps", (route) =>
    route.request().method() === "GET" ?
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          apps: [
            {
              ...DESKTOP_ENTRY,
              enabled: false,
              conflict: "unreadable-profile",
            },
          ],
        }),
      })
    : route.fallback(),
  )
  await openApps(page)

  await card(page, "claude-desktop")
    .getByRole("button", { name: "Connect" })
    .click()
  await expect(dialog(page)).toContainText(
    "Maximal can’t read the configuration Claude is using",
  )
  await expect(dialog(page).getByRole("button")).toHaveText(["Close"])
})

/**
 * Claude Desktop is on a gateway Maximal didn't set up. Records every toggle
 * request body; the list says so until a Take over is applied.
 */
async function openTakeOver(page: Page) {
  const sent: Array<Record<string, unknown>> = []
  let taken = false
  await page.route("**/settings/api/apps", (route) => {
    if (taken || route.request().method() !== "GET") return route.fallback()
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apps: [
          {
            ...DESKTOP_ENTRY,
            enabled: false,
            conflict: "foreign-gateway-profile",
          },
        ],
      }),
    })
  })
  await page.route(DESKTOP_TOGGLE, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    sent.push(body)
    taken = body.overrideForeignGateway === true
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...DESKTOP_ENTRY,
        enabled: taken,
        conflict: taken ? null : "foreign-gateway-profile",
      }),
    })
  })
  await openApps(page)
  const desktop = card(page, "claude-desktop")
  await desktop.getByRole("button", { name: "Connect" }).click()
  await expect(dialog(page)).toHaveAccessibleName("Connect Claude")
  return { desktop, sent }
}

test("another gateway: Take over on the left, Close on the right and focused", async ({
  page,
}) => {
  await openTakeOver(page)
  const takeOver = dialog(page)

  await expect(takeOver).toContainText(
    "Maximal found another gateway in Claude and didn’t change it.",
  )
  await expect(takeOver).not.toContainText("Cowork")
  await expect(takeOver.getByRole("button")).toHaveText(["Take over", "Close"])
  await expect(takeOver.getByRole("button", { name: "Close" })).toBeFocused()
  const [left, right] = await Promise.all([
    takeOver.getByRole("button", { name: "Take over" }).boundingBox(),
    takeOver.getByRole("button", { name: "Close" }).boundingBox(),
  ])
  expect(left?.x ?? Number.POSITIVE_INFINITY).toBeLessThan(right?.x ?? 0)
  await page.screenshot({ path: "test-results/desktop-take-over-dialog.png" })
})

test("another gateway: Enter and Escape close without taking over", async ({
  page,
}) => {
  const { desktop, sent } = await openTakeOver(page)
  await page.keyboard.press("Enter")
  await expect(dialog(page)).toHaveCount(0)

  await desktop.getByRole("button", { name: "Connect" }).click()
  await expect(dialog(page)).toHaveAccessibleName("Connect Claude")
  await page.keyboard.press("Escape")
  await expect(dialog(page)).toHaveCount(0)

  expect(sent).toEqual([])
  await expect(desktop.getByRole("button", { name: "Connect" })).toBeVisible()
})

test("another gateway: Take over asks for exactly that override and the restart dialog follows", async ({
  page,
}) => {
  const { desktop, sent } = await openTakeOver(page)
  const applied = page.waitForResponse(DESKTOP_TOGGLE)
  await dialog(page).getByRole("button", { name: "Take over" }).click()
  await applied

  expect(sent).toEqual([{ enabled: true, overrideForeignGateway: true }])
  await expect(dialog(page)).toHaveAccessibleName(TITLE)
  await dialog(page).getByRole("button", { name: "Got it" }).click()
  await expect(desktop.getByRole("checkbox")).toBeChecked()
})

test("no dialog when the request fails", async ({ page }) => {
  await answerToggle(page, { error: { message: "boom" } }, 500)
  await openApps(page)
  const desktop = card(page, "claude-desktop")

  const failed = page.waitForResponse(DESKTOP_TOGGLE)
  await toggle(page, "claude-desktop").click()
  await failed
  await expect(desktop.getByRole("checkbox")).not.toBeChecked()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.getByText(RELAUNCH)).toHaveCount(0)
})

test("no dialog when the server comes back in a different state than asked", async ({
  page,
}) => {
  await answerToggle(page, { ...DESKTOP_ENTRY, enabled: false, conflict: null })
  await openApps(page)

  const unapplied = page.waitForResponse(DESKTOP_TOGGLE)
  await toggle(page, "claude-desktop").click()
  await unapplied
  await expect(
    card(page, "claude-desktop").getByRole("checkbox"),
  ).not.toBeChecked()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.getByText(RELAUNCH)).toHaveCount(0)
})

test("the Claude Code Windows restart dialog is unchanged and carries no Desktop guidance", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgentData", {
      configurable: true,
      value: { platform: "Windows" },
    })
  })
  await openApps(page)
  const code = card(page, "claude-code")
  await expect(code.getByRole("checkbox")).toBeChecked()

  await toggle(page, "claude-code").click()
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).getByRole("heading")).toHaveText(
    "Restart Claude Code to finish",
  )
  await expect(dialog(page)).not.toContainText(RELAUNCH)
  await expect(dialog(page)).not.toContainText(SIGN_IN_NOTE)
  await expect(
    dialog(page).getByRole("button", { name: "Keep on" }),
  ).toBeFocused()
  await expect(dialog(page).getByRole("button")).toHaveCount(2)

  await dialog(page).getByRole("button", { name: "Disable routing" }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(code.getByRole("checkbox")).not.toBeChecked()
  await expect(page.getByText(RELAUNCH)).toHaveCount(0)
})
