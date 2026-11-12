import {
  type APIRequestContext,
  type Page,
  expect,
  test,
} from "@playwright/test"

const BASE = process.env.UI_HARNESS_URL ?? "http://127.0.0.1:4747"
const SETTINGS = `${BASE}/ui/settings/#connectors`

test.use({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 })

async function selectScenario(
  request: APIRequestContext,
  id: string,
): Promise<void> {
  const response = await request.post(`${BASE}/__harness/scenario`, {
    data: { id },
  })
  expect(response.ok(), `UI harness not reachable at ${BASE}`).toBe(true)
}

async function openConnectors(page: Page): Promise<void> {
  await page.goto(SETTINGS)
  await page.addStyleTag({
    content: "#__harness { display: none !important; }",
  })
  await expect(page.getByRole("button", { name: "Work IQ" })).toBeVisible()
}

test("opens plugin details over the list and restores focus on Escape", async ({
  page,
  request,
}) => {
  await selectScenario(request, "connectors-detail-ready")
  await openConnectors(page)

  const opener = page.getByRole("button", { name: "Work IQ", exact: true })
  await opener.click()

  const dialog = page.getByRole("dialog", { name: "Work IQ" })
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(/#connectors\/workiq$/)
  await expect(opener).toBeVisible()
  await expect(dialog.getByRole("heading", { name: "Work IQ" })).toBeFocused()
  await expect
    .poll(() =>
      dialog
        .locator(".connector-detail__body")
        .evaluate(
          (body: { scrollHeight: number; clientHeight: number }) =>
            body.scrollHeight > body.clientHeight,
        ),
    )
    .toBe(true)

  await page.keyboard.press("Escape")

  await expect(dialog).not.toBeVisible()
  await expect(page).toHaveURL(/#connectors$/)
  await expect(opener).toBeFocused()
})

test("deep-links to extension details without connector-only sections", async ({
  page,
  request,
}) => {
  await selectScenario(request, "figjam-ready")
  await page.goto(`${BASE}/ui/settings/#connectors/figjam`)
  await page.addStyleTag({
    content: "#__harness { display: none !important; }",
  })

  const dialog = page.getByRole("dialog", { name: "FigJam" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText("Ready for FigJam panels")).toBeVisible()
  await expect(
    dialog.getByRole("heading", { name: "Connect", exact: true }),
  ).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: /Copy/ })).toHaveCount(0)

  await dialog.getByRole("button", { name: "Close" }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page).toHaveURL(/#connectors$/)
})

test("closes a detail whose plugin disappears on refresh", async ({
  page,
  request,
}) => {
  await selectScenario(request, "figjam-ready")
  await page.goto(`${BASE}/ui/settings/#connectors/figjam`)
  const dialog = page.getByRole("dialog", { name: "FigJam" })
  await expect(dialog).toBeVisible()

  await selectScenario(request, "connectors-list")

  await expect(dialog).not.toBeVisible()
  await expect(page).toHaveURL(/#connectors$/)
})

test("stacks action confirmation above plugin details", async ({
  page,
  request,
}) => {
  await selectScenario(request, "connectors-detail-ready")
  await openConnectors(page)
  await page.getByRole("button", { name: "Work IQ" }).click()

  const details = page.getByRole("dialog", { name: "Work IQ" })
  const action = details.getByRole("button", { name: "Sign out" })
  await action.click()

  const confirmation = page.getByRole("dialog", { name: "Sign out?" })
  await expect(confirmation).toBeVisible()
  await expect(page.locator("dialog[open]")).toHaveCount(2)

  await page.keyboard.press("Escape")

  await expect(confirmation).not.toBeVisible()
  await expect(details).toBeVisible()
  await expect(action).toBeFocused()
})
