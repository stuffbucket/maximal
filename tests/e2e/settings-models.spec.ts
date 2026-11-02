import { type Page, expect, test } from "@playwright/test"

import type { ModelsListResponse } from "../../src/lib/config/settings-types"

const BASE = process.env.UI_HARNESS_URL ?? "http://127.0.0.1:4747"
const SETTINGS = `${BASE}/ui/settings/#models-keys`
const MODELS = "**/settings/api/models"
const UPDATE = "**/settings/api/models/claude-code-auto"

test.use({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 })

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${BASE}/__harness/scenario`, {
    data: { id: "signed-in" },
  })
  expect(response.ok(), `UI harness not reachable at ${BASE}`).toBe(true)
})

async function currentModels(page: Page): Promise<ModelsListResponse> {
  const response = await page.request.get(`${BASE}/settings/api/models`)
  expect(response.ok()).toBe(true)
  return response.json() as Promise<ModelsListResponse>
}

async function openModels(page: Page): Promise<void> {
  await page.goto(SETTINGS)
  await page.addStyleTag({
    content: "#__harness { display: none !important; }",
  })
  await expect(page.getByLabel("Fast and background work")).toBeVisible()
  await expect(page.getByLabel("Capable work")).toBeVisible()
}

test("renders accessible Automatic controls and preserves the other tier on save", async ({
  page,
}) => {
  const initial = await currentModels(page)
  await page.route(UPDATE, async (route) => {
    await route.fulfill({
      json: {
        ...initial,
        claude_code_auto: {
          ...initial.claude_code_auto,
          fast: {
            configured: "gpt-5.6-mini",
            effective: "gpt-5.6-mini",
            source: "maximal-override",
            status: "ready",
            reason: "override",
          },
        },
      } satisfies ModelsListResponse,
    })
  })

  await openModels(page)
  const fast = page.getByLabel("Fast and background work")
  const capable = page.getByLabel("Capable work")
  await expect(fast.locator("option").first()).toHaveText("Automatic")
  await expect(capable.locator("option").first()).toHaveText("Automatic")
  await expect(fast).toHaveValue("")
  await expect(capable).toHaveValue("")
  await expect(
    page.getByText("Using Claude Haiku 4.6 automatically"),
  ).toBeVisible()
  await expect(
    page.getByText("Using Claude Sonnet 4.7 automatically"),
  ).toBeVisible()

  const updateRequest = page.waitForRequest((request) =>
    request.url().endsWith("/settings/api/models/claude-code-auto"),
  )
  await fast.selectOption("gpt-5.6-mini")

  expect((await updateRequest).postDataJSON()).toEqual({
    fast: "gpt-5.6-mini",
    capable: null,
  })
  await expect(fast).toHaveValue("gpt-5.6-mini")
  await expect(capable).toHaveValue("")
})

test("renders GPT models chosen automatically when Claude tiers are absent", async ({
  page,
}) => {
  const initial = await currentModels(page)
  await page.route(MODELS, async (route) => {
    await route.fulfill({
      json: {
        ...initial,
        claude_code_auto: {
          ...initial.claude_code_auto,
          fast: {
            configured: null,
            effective: "gpt-5.6-mini",
            source: "automatic",
            status: "ready",
            reason: "small-gpt",
          },
          capable: {
            configured: null,
            effective: "gpt-5.6",
            source: "automatic",
            status: "ready",
            reason: "gpt",
          },
        },
      } satisfies ModelsListResponse,
    })
  })

  await openModels(page)
  await expect(page.getByText("Using GPT-5.6 Mini automatically")).toBeVisible()
  await expect(page.getByText("Using GPT-5.6 automatically")).toBeVisible()
})

test("disables both controls while a save is in flight", async ({ page }) => {
  const gate = { release: (): void => undefined }
  const waiting = new Promise<void>((resolve) => {
    gate.release = resolve
  })
  const initial = await currentModels(page)
  await page.route(UPDATE, async (route) => {
    await waiting
    await route.fulfill({ json: initial })
  })

  await openModels(page)
  const fast = page.getByLabel("Fast and background work")
  const capable = page.getByLabel("Capable work")
  const save = fast.selectOption("gpt-5.6-mini")
  await expect(fast).toBeDisabled()
  await expect(capable).toBeDisabled()
  gate.release()
  await save
})

test("keeps prior state and reports a failed save", async ({ page }) => {
  await page.route(UPDATE, async (route) => {
    await route.fulfill({
      status: 500,
      json: { error: { message: "Could not write config" } },
    })
  })

  await openModels(page)
  const fast = page.getByLabel("Fast and background work")
  await fast.selectOption("gpt-5.6-mini")

  await expect(fast).toHaveValue("")
  await expect(
    page.getByText("Maximal couldn't save that change"),
  ).toBeVisible()
})

test("shows an unavailable override without substituting it", async ({
  page,
}) => {
  const initial = await currentModels(page)
  await page.route(MODELS, async (route) => {
    await route.fulfill({
      json: {
        ...initial,
        claude_code_auto: {
          ...initial.claude_code_auto,
          fast: {
            configured: "gpt-retired",
            effective: null,
            source: "maximal-override",
            status: "unavailable",
            reason: "override-unavailable",
          },
        },
      } satisfies ModelsListResponse,
    })
  })

  await openModels(page)
  const fast = page.getByLabel("Fast and background work")
  await expect(fast).toHaveValue("gpt-retired")
  await expect(fast.getByText("gpt-retired (unavailable)")).toHaveCount(1)
  await expect(
    page.getByText("Your fast model is no longer available"),
  ).toBeVisible()
})

test("shows the no-match state without choosing an arbitrary model", async ({
  page,
}) => {
  const initial = await currentModels(page)
  const unresolved = {
    configured: null,
    effective: null,
    source: "none" as const,
    status: "unresolved" as const,
    reason: "no-match" as const,
  }
  await page.route(MODELS, async (route) => {
    await route.fulfill({
      json: {
        ...initial,
        claude_code_auto: {
          applied: true,
          options: [],
          fast: unresolved,
          capable: unresolved,
        },
      } satisfies ModelsListResponse,
    })
  })

  await openModels(page)
  await expect(page.getByLabel("Fast and background work")).toHaveValue("")
  await expect(
    page.getByText("No compatible model found—choose one"),
  ).toHaveCount(2)
})

test("keeps the Auto controls separated, focused, and within the narrow window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 900 })
  await openModels(page)
  await page.getByLabel("Fast and background work").focus()

  const layout = await page.evaluate<{
    autoDisplay: string
    autoGap: number
    focusOutline: string
    focusWidth: number
    overflow: number
    rootDisplay: string
    rootGap: number
    rowBorder: number
    rowDisplay: string
  }>(`(() => {
    const root = document.querySelector('.models')
    const auto = document.querySelector('.models-auto')
    const rows = [...document.querySelectorAll('.models-auto__row')]
    const select = document.querySelector('#models-auto-fast')
    const rootStyle = getComputedStyle(root)
    const autoStyle = getComputedStyle(auto)
    const rowStyle = getComputedStyle(rows[1])
    const focusStyle = getComputedStyle(select)
    return {
      rootDisplay: rootStyle.display,
      rootGap: parseFloat(rootStyle.rowGap),
      autoDisplay: autoStyle.display,
      autoGap: parseFloat(autoStyle.rowGap),
      rowDisplay: rowStyle.display,
      rowBorder: parseFloat(rowStyle.borderTopWidth),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      focusOutline: focusStyle.outlineStyle,
      focusWidth: parseFloat(focusStyle.outlineWidth),
    }
  })()`)

  expect(layout).toMatchObject({
    rootDisplay: "flex",
    autoDisplay: "flex",
    rowDisplay: "grid",
    overflow: 0,
    focusOutline: "solid",
  })
  expect(layout.rootGap).toBeGreaterThan(0)
  expect(layout.autoGap).toBeGreaterThan(0)
  expect(layout.rowBorder).toBeGreaterThan(0)
  expect(layout.focusWidth).toBeGreaterThan(0)
})
