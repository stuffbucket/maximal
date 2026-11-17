import { type Page, expect, test } from "@playwright/test"

/**
 * The update entry points — the title bar's icon and System → Version and
 * updates' button — against the UI harness. A small stand-in for the Tauri
 * IPC bridge records what the page asks the shell to do, so the in-place,
 * download-page and apt hand-offs are observed rather than inferred.
 */

const BASE = process.env.UI_HARNESS_URL ?? "http://127.0.0.1:4747"
const SYSTEM = `${BASE}/ui/settings/#system`
const ACCOUNT = `${BASE}/ui/settings/#account`
const ICON = '[data-update-action] [data-action="open-update"]'
const SYSTEM_BUTTON = '[data-system-update] [data-action="system-update"]'
const VERSION = "0.4.40"

// Any Settings width can be checked: UI_VIEWPORT_WIDTH=772 (the minimum) or wider.
test.use({
  viewport: {
    width: Number(process.env.UI_VIEWPORT_WIDTH ?? 960),
    height: 760,
  },
  deviceScaleFactor: 1,
})

type Scenario = "signed-in" | "update-available" | "update-available-apt"

interface ShellCall {
  cmd: string
  args?: Record<string, unknown>
}

async function useScenario(
  page: Page,
  scenario: Scenario,
  shell: { inPlace: boolean; pendingUpdateRequest?: boolean } | null,
): Promise<void> {
  const response = await page.request.post(`${BASE}/__harness/scenario`, {
    data: { id: scenario },
  })
  expect(response.ok(), `UI harness not reachable at ${BASE}`).toBe(true)
  if (!shell) return
  await page.addInitScript(
    ({
      inPlace,
      pendingUpdateRequest,
    }: {
      inPlace: boolean
      pendingUpdateRequest: boolean
    }) => {
      type Callback = (message: unknown) => void
      const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = []
      const callbacks = new Map<number, Callback>()
      const listeners = new Map<string, Array<number>>()
      let nextId = 1
      let pendingRequest = pendingUpdateRequest
      const w = globalThis as unknown as Record<string, unknown>
      w.__shellCalls = calls
      const emit = (event: string): void => {
        for (const id of listeners.get(event) ?? []) {
          callbacks.get(id)?.({ event, id: 0, payload: null })
        }
      }
      // What the tray's "Update with apt…" does: queue the request, open
      // Settings at System, and signal an already-open window.
      w.__shellRequestUpdate = (): void => {
        pendingRequest = true
        ;(
          globalThis as unknown as { location: { hash: string } }
        ).location.hash = "diagnostics"
        emit("app://update-requested")
      }
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
      w.__TAURI_INTERNALS__ = {
        transformCallback(callback: Callback) {
          const id = nextId++
          callbacks.set(id, callback)
          return id
        },
        unregisterCallback(id: number) {
          callbacks.delete(id)
        },
        invoke(cmd: string, args: Record<string, unknown> = {}) {
          if (cmd === "plugin:event|listen") {
            const event = String(args.event)
            listeners.set(event, [
              ...(listeners.get(event) ?? []),
              Number(args.handler),
            ])
            return Promise.resolve(nextId++)
          }
          if (cmd === "plugin:event|unlisten") return Promise.resolve()
          if (cmd === "take_update_request") {
            calls.push({ cmd })
            const taken = pendingRequest
            pendingRequest = false
            return Promise.resolve(taken)
          }
          if (cmd === "update_installs_in_place") {
            calls.push({ cmd })
            return Promise.resolve(inPlace)
          }
          if (cmd === "install_update") {
            calls.push({ cmd, args: { version: args.version } })
            const channel = args.onStep as { id: number }
            return new Promise((resolve) => {
              w.__shellInstall = {
                downloading: () =>
                  callbacks.get(channel.id)?.({
                    index: 0,
                    message: "downloading",
                  }),
                finish: resolve,
              }
            })
          }
          if (cmd === "plugin:opener|open_url") {
            calls.push({ cmd, args })
            return Promise.resolve()
          }
          // Everything else behaves as in a plain browser.
          return Promise.reject(new Error(`not in this stand-in: ${cmd}`))
        },
      }
    },
    {
      inPlace: shell.inPlace,
      pendingUpdateRequest: shell.pendingUpdateRequest ?? false,
    },
  )
}

async function open(page: Page, url: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(url)
  await page.addStyleTag({
    content: "#__harness { display: none !important; }",
  })
}

const shellCalls = (page: Page): Promise<Array<ShellCall>> =>
  page.evaluate(
    () =>
      ((globalThis as unknown as Record<string, unknown>).__shellCalls
        ?? []) as Array<ShellCall>,
  )

const handoffs = async (page: Page): Promise<Array<ShellCall>> =>
  (await shellCalls(page)).filter(
    (c) => c.cmd === "install_update" || c.cmd === "plugin:opener|open_url",
  )

const dialog = (page: Page) => page.locator("dialog[open]")

test("without an update there is no title-bar icon and no System update button", async ({
  page,
}) => {
  await useScenario(page, "signed-in", null)
  await open(page, SYSTEM)
  await expect(
    page.locator('[data-section="diagnostics"] [data-field="update_status"]'),
  ).toHaveText("Up to date")
  await expect(page.locator(ICON)).toBeHidden()
  await expect(page.locator(SYSTEM_BUTTON)).toBeHidden()
  await expect(page.getByRole("button", { name: "Check now" })).toBeVisible()
})

test("the title-bar control is a compact, icon-only button named for the version", async ({
  page,
}) => {
  await useScenario(page, "update-available", null)
  await open(page, ACCOUNT)
  const icon = page.locator(ICON)
  await expect(icon).toBeVisible()
  await expect(icon).toHaveAccessibleName(`Update Maximal to ${VERSION}`)
  await expect(icon).toHaveAttribute("title", `Update Maximal to ${VERSION}`)
  await expect(icon).toHaveText("")
  await expect(icon.locator("svg[aria-hidden='true']")).toHaveCount(1)
  await expect(icon).toHaveClass(/btn--primary/u)
  // Square: the same footprint as the surface switcher's buttons.
  const box = await icon.boundingBox()
  const mode = await page.locator(".topbar__mode-btn").first().boundingBox()
  expect(box && mode).toBeTruthy()
  if (!box || !mode) return
  expect(Math.round(box.width)).toBe(Math.round(box.height))
  expect(Math.round(box.width)).toBe(Math.round(mode.width))
})

test("System shows a primary Update button beside the quiet Check now", async ({
  page,
}) => {
  await useScenario(page, "update-available", null)
  await open(page, SYSTEM)
  const update = page.locator(SYSTEM_BUTTON)
  await expect(update).toBeVisible()
  await expect(update).toHaveText(`Update to ${VERSION}`)
  await expect(update).toHaveClass(/btn--primary/u)
  const check = page.getByRole("button", { name: "Check now" })
  await expect(check).toHaveClass(/btn--ghost/u)
  await expect(check).not.toHaveClass(/btn--primary/u)
  // The old text link is gone.
  await expect(page.locator('[data-field="update_status"] a')).toHaveCount(0)
})

for (const entry of ["title bar", "System"] as const) {
  test(`${entry}: opens the update confirmation; Not now, Escape and the backdrop do nothing and return focus`, async ({
    page,
  }) => {
    await useScenario(page, "update-available", { inPlace: true })
    await open(page, SYSTEM)
    const opener = page.locator(entry === "title bar" ? ICON : SYSTEM_BUTTON)
    await expect(opener).toBeVisible()

    // Not now.
    await opener.click()
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page).getByRole("heading")).toHaveText(
      "Update Maximal?",
    )
    await expect(dialog(page)).toContainText(
      `Maximal will download and install ${VERSION}, then restart. Requests in progress will stop.`,
    )
    await expect(
      dialog(page).getByRole("button", { name: "Not now" }),
    ).toBeFocused()
    await dialog(page).getByRole("button", { name: "Not now" }).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(opener).toBeFocused()

    // Escape.
    await opener.click()
    await expect(dialog(page)).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(dialog(page)).toHaveCount(0)
    await expect(opener).toBeFocused()

    // Backdrop.
    await opener.click()
    await expect(dialog(page)).toBeVisible()
    await page.mouse.click(5, 700)
    await expect(dialog(page)).toHaveCount(0)
    await expect(opener).toBeFocused()

    expect(await handoffs(page)).toEqual([])
    await expect(opener).toBeEnabled()
  })
}

test("both entry points open the same confirmation", async ({ page }) => {
  await useScenario(page, "update-available", { inPlace: true })
  await open(page, SYSTEM)
  const texts: Array<string> = []
  for (const selector of [ICON, SYSTEM_BUTTON]) {
    await page.locator(selector).click()
    await expect(dialog(page)).toBeVisible()
    texts.push((await dialog(page).textContent()) ?? "")
    await page.keyboard.press("Escape")
    await expect(dialog(page)).toHaveCount(0)
  }
  expect(texts[0]).toBe(texts[1])
})

test("in place: Install and restart asks the shell once, with no second confirmation, and both entry points stay busy", async ({
  page,
}) => {
  await useScenario(page, "update-available", { inPlace: true })
  await open(page, SYSTEM)
  await page.locator(SYSTEM_BUTTON).click()
  await dialog(page)
    .getByRole("button", { name: "Install and restart" })
    .click()
  await expect(dialog(page)).toHaveCount(0)
  await expect
    .poll(() => handoffs(page))
    .toEqual([{ cmd: "install_update", args: { version: VERSION } }])

  await page.evaluate(() =>
    (
      (globalThis as unknown as Record<string, unknown>).__shellInstall as {
        downloading: () => void
      }
    ).downloading(),
  )
  const icon = page.locator(ICON)
  const system = page.locator(SYSTEM_BUTTON)
  await expect(system).toHaveText("Downloading…")
  await expect(system).toBeDisabled()
  await expect(icon).toBeDisabled()
  await expect(icon).toHaveText("")
  await expect(icon).toHaveAccessibleName("Downloading update…")
  await expect(icon).toHaveAttribute("title", "Downloading update…")

  // A second start can't happen: both are disabled, and a forced click
  // opens no dialog and asks the shell for nothing more.
  await icon.click({ force: true })
  await system.click({ force: true })
  await expect(dialog(page)).toHaveCount(0)
  expect(await handoffs(page)).toHaveLength(1)

  // The shell gave up (the user was told natively): both come back.
  await page.evaluate(() =>
    (
      (globalThis as unknown as Record<string, unknown>).__shellInstall as {
        finish: (outcome: string) => void
      }
    ).finish("failed"),
  )
  await expect(system).toHaveText(`Update to ${VERSION}`)
  await expect(system).toBeEnabled()
  await expect(icon).toBeEnabled()
  expect(await handoffs(page)).toHaveLength(1)
})

test("download page: Open mxml.sh opens the page once and installs nothing", async ({
  page,
}) => {
  await useScenario(page, "update-available", { inPlace: false })
  await open(page, ACCOUNT)
  await page.locator(ICON).click()
  await expect(dialog(page).getByRole("heading")).toHaveText("Update Maximal?")
  await expect(dialog(page)).toContainText(VERSION)
  await expect(dialog(page)).not.toContainText("restart")
  await dialog(page).getByRole("button", { name: "Open mxml.sh" }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect
    .poll(() => handoffs(page))
    .toEqual([
      { cmd: "plugin:opener|open_url", args: { url: "https://mxml.sh/" } },
    ])
})

test("apt: Show command focuses the command to copy, and runs nothing", async ({
  page,
}) => {
  await useScenario(page, "update-available-apt", { inPlace: false })
  await open(page, ACCOUNT)
  await page.locator(ICON).click()
  await expect(dialog(page).getByRole("heading")).toHaveText("Update Maximal?")
  await expect(dialog(page)).toContainText(VERSION)
  await expect(dialog(page)).toContainText("terminal")
  await expect(dialog(page)).not.toContainText("restart")
  await dialog(page).getByRole("button", { name: "Show command" }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.locator('[data-section="diagnostics"]')).toBeVisible()
  await expect(
    page.locator('[data-update-apt] [data-action="copy-update-command"]'),
  ).toBeFocused()
  // Revealing navigated to System; that must not ask a second time.
  await expect(dialog(page)).toHaveCount(0)
  expect(await handoffs(page)).toEqual([])
})

test("apt: cancelling leaves focus on the opener and does not move to the command", async ({
  page,
}) => {
  await useScenario(page, "update-available-apt", { inPlace: false })
  await open(page, SYSTEM)
  await page.locator(SYSTEM_BUTTON).click()
  await page.keyboard.press("Escape")
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.locator(SYSTEM_BUTTON)).toBeFocused()
  expect(await handoffs(page)).toEqual([])
})

const COPY_COMMAND = '[data-update-apt] [data-action="copy-update-command"]'

const takes = async (page: Page): Promise<number> =>
  (await shellCalls(page)).filter((c) => c.cmd === "take_update_request").length

test("tray apt request, window already open: asks, then reveals the command", async ({
  page,
}) => {
  await useScenario(page, "update-available-apt", { inPlace: false })
  await open(page, ACCOUNT)
  await expect(page.locator(ICON)).toBeVisible()
  await page.evaluate("window.__shellRequestUpdate()")
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page)).toContainText("terminal")
  await expect(page.locator(COPY_COMMAND)).not.toBeFocused()
  await dialog(page).getByRole("button", { name: "Show command" }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.locator(COPY_COMMAND)).toBeFocused()
  expect(await handoffs(page)).toEqual([])
})

test("tray apt request, window created by it: asks once on load, then reveals the command", async ({
  page,
}) => {
  await useScenario(page, "update-available-apt", {
    inPlace: false,
    pendingUpdateRequest: true,
  })
  await open(page, `${BASE}/ui/settings/#diagnostics`)
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).getByRole("heading")).toHaveText("Update Maximal?")
  await dialog(page).getByRole("button", { name: "Show command" }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.locator(COPY_COMMAND)).toBeFocused()
  expect(await handoffs(page)).toEqual([])
})

test("a normal System location never asks: no request, no dialog", async ({
  page,
}) => {
  await useScenario(page, "update-available-apt", { inPlace: false })
  // A persisted or bookmarked #diagnostics, and moving there by hash.
  await open(page, `${BASE}/ui/settings/#diagnostics`)
  await expect(page.locator(ICON)).toBeVisible()
  await expect(page.locator(SYSTEM_BUTTON)).toBeVisible()
  await page.evaluate('window.location.hash = "account"')
  await page.evaluate('window.location.hash = "diagnostics"')
  await page.evaluate('window.location.hash = "system"')
  await page.waitForTimeout(500)
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.locator(COPY_COMMAND)).not.toBeFocused()
  // The page asked the shell once on load and found nothing queued.
  expect(await takes(page)).toBe(1)
})

test("a double click opens one dialog that stays open, with Not now still focused, until an explicit answer", async ({
  page,
}) => {
  await useScenario(page, "update-available", { inPlace: true })
  // Count every time a dialog is opened.
  await page.addInitScript(`
    window.__dialogOpens = 0;
    const showModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () {
      window.__dialogOpens += 1;
      showModal.call(this);
    };
  `)
  await open(page, SYSTEM)
  for (const selector of [SYSTEM_BUTTON, ICON]) {
    await page.locator(selector).dblclick()
    // The second click of the double click must not dismiss (or answer) the
    // dialog the first click opened, nor move focus off the safe action.
    await page.waitForTimeout(700)
    await expect(dialog(page)).toHaveCount(1)
    await expect(dialog(page).getByRole("heading")).toHaveText(
      "Update Maximal?",
    )
    await expect(
      dialog(page).getByRole("button", { name: "Not now" }),
    ).toBeFocused()
    expect(await handoffs(page)).toEqual([])
    // Enter answers with the focused safe action.
    await page.keyboard.press("Enter")
    await expect(dialog(page)).toHaveCount(0)
  }
  expect(
    await page.evaluate(
      () => (globalThis as unknown as { __dialogOpens: number }).__dialogOpens,
    ),
  ).toBe(2)
  expect(await handoffs(page)).toEqual([])
  // A later single click on the backdrop still dismisses.
  await page.locator(SYSTEM_BUTTON).click()
  await expect(dialog(page)).toBeVisible()
  await page.waitForTimeout(700)
  await page.mouse.click(5, 700)
  await expect(dialog(page)).toHaveCount(0)
})

interface TopbarGeometry {
  navLeft: number
  navRight: number
  utilitiesLeft: number
  utilitiesRight: number
  lastTabRight: number
  viewport: number
  overflows: boolean
  clipped: Array<string>
  active: string
  activeLeft: number
  activeRight: number
  activeHit: boolean
  paddingLeft: string
  paddingRight: string
  utilitiesGap: string
}

const topbarGeometry = (page: Page): Promise<TopbarGeometry> =>
  page.evaluate(`(() => {
    const scroller = document.querySelector("[data-settings-nav]")
    const nav = scroller.getBoundingClientRect()
    const utilities = document.querySelector(".topbar__utilities")
    const util = utilities.getBoundingClientRect()
    const tabs = [...scroller.querySelectorAll("[data-nav]")]
    const active = scroller.querySelector('[aria-current="page"]')
    const a = active.getBoundingClientRect()
    const hit = document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2)
    const topbar = getComputedStyle(document.querySelector(".topbar"))
    return {
      navLeft: nav.left,
      navRight: nav.right,
      utilitiesLeft: util.left,
      utilitiesRight: util.right,
      lastTabRight: tabs.at(-1).getBoundingClientRect().right,
      viewport: window.innerWidth,
      overflows: scroller.scrollWidth > scroller.clientWidth,
      clipped: tabs
        .filter((t) => {
          const r = t.getBoundingClientRect()
          return r.left < nav.left - 0.5 || r.right > nav.right + 0.5
        })
        .map((t) => t.dataset.nav),
      active: active.dataset.nav,
      activeLeft: a.left,
      activeRight: a.right,
      activeHit: active.contains(hit),
      paddingLeft: topbar.paddingLeft,
      paddingRight: topbar.paddingRight,
      utilitiesGap: getComputedStyle(utilities).columnGap,
    }
  })()`)

const TABS = ["account", "integrations", "models-keys", "appearance", "system"]

/** Click a Settings tab and wait until it is the current one. */
async function selectTab(page: Page, tab: string): Promise<void> {
  const link = page.locator(`[data-settings-nav] [data-nav="${tab}"]`)
  await link.click()
  await expect(link).toHaveAttribute("aria-current", "page")
  await page.waitForTimeout(100)
}

async function useLocale(page: Page, locale: string): Promise<void> {
  await page.addInitScript(
    `try { localStorage.setItem("maximal.locale", ${JSON.stringify(locale)}) } catch {}`,
  )
}

async function openWithUpdate(
  page: Page,
  width: number,
  scenario: Scenario,
): Promise<TopbarGeometry> {
  await page.setViewportSize({ width, height: 760 })
  await useScenario(page, scenario, null)
  // System is the last tab: active before the icon appears.
  await open(page, SYSTEM)
  if (scenario !== "signed-in") await expect(page.locator(ICON)).toBeVisible()
  await page.waitForTimeout(200)
  return topbarGeometry(page)
}

test("at the 772px minimum in English the whole tab row still fits beside the update icon", async ({
  page,
}) => {
  const before = await openWithUpdate(page, 772, "signed-in")
  await page.goto("about:blank")
  const g = await openWithUpdate(page, 772, "update-available")
  await page.screenshot({ path: "test-results/update-titlebar-772.png" })

  expect(g.overflows).toBe(false)
  expect(g.clipped).toEqual([])
  expect(g.utilitiesLeft - g.lastTabRight).toBeGreaterThanOrEqual(16)
  expect(g.utilitiesRight).toBeLessThanOrEqual(g.viewport)
  // The macOS traffic-light clearance is untouched.
  expect(g.paddingLeft).toBe(before.paddingLeft)

  for (const tab of TABS) {
    await selectTab(page, tab)
    const t = await topbarGeometry(page)
    expect(t.active, tab).toBe(tab)
    expect(t.activeHit, tab).toBe(true)
    expect(t.overflows, tab).toBe(false)
    expect(t.clipped, tab).toEqual([])
  }
})

test("at 1100px the title bar keeps its regular spacing with the update icon", async ({
  page,
}) => {
  const before = await openWithUpdate(page, 1100, "signed-in")
  await page.goto("about:blank")
  const g = await openWithUpdate(page, 1100, "update-available")
  await page.screenshot({ path: "test-results/update-titlebar-1100.png" })
  expect(g.overflows).toBe(false)
  expect(g.clipped).toEqual([])
  expect(g.paddingLeft).toBe(before.paddingLeft)
  expect(g.paddingRight).toBe(before.paddingRight)
  expect(g.utilitiesGap).toBe(before.utilitiesGap)
  expect(g.utilitiesLeft - g.lastTabRight).toBeGreaterThanOrEqual(16)
})

for (const locale of ["de", "ru"] as const) {
  test(`at 772px in ${locale} with the update icon the utilities stay pinned and the active tab usable`, async ({
    page,
  }) => {
    await useLocale(page, locale)
    const g = await openWithUpdate(page, 772, "update-available")
    await page.screenshot({
      path: `test-results/update-titlebar-772-${locale}.png`,
    })
    expect(g.utilitiesRight).toBeLessThanOrEqual(g.viewport)
    expect(g.utilitiesLeft - g.navRight).toBeGreaterThanOrEqual(0)
    for (const tab of TABS) {
      await selectTab(page, tab)
      const t = await topbarGeometry(page)
      expect(t.active, tab).toBe(tab)
      expect(t.activeLeft, tab).toBeGreaterThanOrEqual(t.navLeft - 0.5)
      expect(t.activeRight, tab).toBeLessThanOrEqual(t.navRight + 0.5)
      expect(t.activeHit, tab).toBe(true)
    }
  })

  test(`at 772px in ${locale} the System update labels never break mid-phrase`, async ({
    page,
  }) => {
    await useLocale(page, locale)
    await openWithUpdate(page, 772, "update-available")
    await expect(page.locator(SYSTEM_BUTTON)).toBeVisible()
    await page.screenshot({
      path: `test-results/update-system-row-772-${locale}.png`,
    })
    const lines = await page.evaluate(`(() => {
      const count = (el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size
      }
      const row = document.querySelector('[data-field="update_status"]').closest("dd")
      return {
        status: count(document.querySelector('[data-field="update_status"]')),
        update: count(document.querySelector('[data-action="system-update"]')),
        check: count(document.querySelector('[data-action="check-update"]')),
        wrap: getComputedStyle(row).flexWrap,
      }
    })()`)
    expect(lines).toEqual({ status: 1, update: 1, check: 1, wrap: "wrap" })
  })
}
