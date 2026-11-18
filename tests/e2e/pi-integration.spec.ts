import { type Page, expect, test } from "@playwright/test"
import { z } from "zod"

const BASE = process.env.UI_HARNESS_URL ?? "http://127.0.0.1:4747"
const TOGGLE = "**/settings/api/apps/pi/toggle"
const ENTRY = {
  id: "pi",
  name: "Pi",
  kind: "config",
  enabled: false,
  status: "ready",
  installs: [],
  install: null,
  conflict: null,
  config_directory: "/Users/you/.pi/agent",
}

test.use({ viewport: { width: 772, height: 720 } })
test.beforeEach(async ({ request }) => {
  expect(
    (
      await request.post(`${BASE}/__harness/scenario`, {
        data: { id: "signed-in" },
      })
    ).ok(),
  ).toBe(true)
})
async function open(page: Page, conflict?: string) {
  if (conflict)
    await page.route("**/settings/api/apps", (route) =>
      route.fulfill({ json: { apps: [{ ...ENTRY, conflict }] } }),
    )
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(`${BASE}/ui/settings/#apps`)
  await page.addStyleTag({
    content: "#__harness { display: none !important; }",
  })
  const row = page.locator('[data-app-id="pi"]')
  await row.getByRole("button", { name: "Connect", exact: true }).click()
  const dialog = page.locator("dialog[open]")
  await expect(dialog).toBeVisible()
  return { row, dialog }
}

test("fresh Pi setup is opt-in and returns focus to its enabled switch", async ({
  page,
}) => {
  const { row, dialog } = await open(page)
  await expect(dialog).toContainText(
    "Your default model and other providers stay unchanged",
  )
  await expect(dialog.getByLabel("Agent directory")).toBeHidden()
  await page.screenshot({ path: "/tmp/maximal-pi-setup.png" })
  const request = page.waitForRequest(TOGGLE)
  await dialog.getByRole("button", { name: "Connect", exact: true }).click()
  expect((await request).postDataJSON()).toEqual({
    enabled: true,
    configDirectory: ENTRY.config_directory,
  })
  await expect(row.getByRole("checkbox")).toBeChecked()
  await expect(row.getByRole("checkbox")).toBeFocused()
  await expect(dialog).toHaveCount(0)
  await row.locator("label.switch").click()
  await expect(
    row.getByRole("button", { name: "Connect", exact: true }),
  ).toBeVisible()
})

test("canceling setup does not send a mutation", async ({ page }) => {
  let mutations = 0
  page.on("request", (request) => {
    if (request.url().endsWith("/pi/toggle")) mutations += 1
  })
  const { row, dialog } = await open(page)
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(
    row.getByRole("button", { name: "Connect", exact: true }),
  ).toBeFocused()
  expect(mutations).toBe(0)
})

test("adopting an existing provider needs explicit confirmation", async ({
  page,
}) => {
  const { dialog } = await open(page, "existing-provider")
  await expect(dialog).toContainText(
    "disconnecting restores the original configuration",
  )
  const request = page.waitForRequest(TOGGLE)
  await dialog.getByRole("button", { name: "Connect", exact: true }).click()
  expect((await request).postDataJSON()).toMatchObject({
    enabled: true,
    adoptExisting: true,
  })
})

test("changing the agent directory invalidates adoption consent until the new target is confirmed", async ({
  page,
}) => {
  const bodies: Array<Record<string, unknown>> = []
  await page.route(TOGGLE, async (route) => {
    const body = z
      .record(z.string(), z.unknown())
      .parse(route.request().postDataJSON())
    bodies.push(body)
    await route.fulfill({
      json: {
        ...ENTRY,
        config_directory: "/tmp/another-pi",
        conflict: body.adoptExisting ? null : "existing-provider",
        enabled: body.adoptExisting === true,
      },
    })
  })
  const { dialog, row } = await open(page, "existing-provider")
  await dialog.getByText("Advanced", { exact: true }).click()
  await dialog.getByLabel("Agent directory").fill("/tmp/another-pi/")
  await page.screenshot({ path: "/tmp/maximal-pi-directory.png" })
  await dialog.getByRole("button", { name: "Connect", exact: true }).click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0].adoptExisting).toBeUndefined()
  await expect(dialog.getByLabel("Agent directory")).toHaveValue(
    "/tmp/another-pi",
  )
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(row.getByRole("checkbox")).toBeChecked()
  expect(bodies[1]).toMatchObject({
    configDirectory: "/tmp/another-pi",
    adoptExisting: true,
  })
})

test("edited provider data offers cleanup information, never a force action", async ({
  page,
}) => {
  const { dialog } = await open(page, "cleanup-required")
  await expect(dialog.getByRole("button")).toHaveCount(1)
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toBeVisible()
  await expect(dialog.getByText("Advanced", { exact: true })).toHaveCount(0)
})

test("a failed connection keeps the custom directory and shows the error in the dialog", async ({
  page,
}) => {
  await page.route(TOGGLE, (route) =>
    route.fulfill({
      status: 409,
      json: { error: { message: "Choose an absolute Pi agent directory" } },
    }),
  )
  const { dialog } = await open(page)
  await dialog.getByText("Advanced", { exact: true }).click()
  await dialog.getByLabel("Agent directory").fill("relative-path")
  await dialog.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(dialog.getByRole("alert")).toContainText(
    "Choose an absolute Pi agent directory",
  )
  await expect(dialog.getByLabel("Agent directory")).toHaveValue(
    "relative-path",
  )
})
