import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, test } from "bun:test"

import type {
  DiagnosticsResponse,
  UpdateStatusResponse,
} from "../../src/lib/config/settings-types"

import {
  __resetShellBridgeForTests,
  __setInvokeForTests,
} from "../src/tauri/shell"
import { Diagnostics } from "../src/ui/features/diagnostics/Diagnostics"

/**
 * Render + interaction tests for the Diagnostics island
 * (shell/src/ui/features/diagnostics/Diagnostics.tsx). Stubs the two boundaries
 * the island touches — `fetch` (through `apiCall`) for the diagnostics +
 * update-status endpoints, and the Tauri `invoke` transport (via
 * `__setInvokeForTests`) for the native actions. Covers loading / content /
 * error states and the reveal-config + uninstall (Radix AlertDialog) flows.
 */

const realFetch = globalThis.fetch

const invokeCalls: Array<{ cmd: string; args?: Record<string, unknown> }> = []

type Route = { ok?: boolean; status?: number; body?: unknown }

/** URL-prefix fetch stub. Supports both res.json() (success) and res.text()
 *  (apiCall's error path). List more specific prefixes first. */
function stubFetch(routes: Array<[string, Route]>): void {
  globalThis.fetch = ((input: string | URL) => {
    const url = String(input)
    for (const [prefix, r] of routes) {
      if (url.includes(prefix)) {
        return Promise.resolve({
          ok: r.ok ?? true,
          status: r.status ?? 200,
          json: () => Promise.resolve(r.body),
          text: () => Promise.resolve(typeof r.body === "string" ? r.body : ""),
        } as Response)
      }
    }
    return Promise.reject(new Error(`unmocked fetch: ${url}`))
  }) as typeof fetch
}

function diagnostics(): DiagnosticsResponse {
  return {
    version: "1.2.3",
    source_revision: "abcdef0",
    source_branch: "main",
    launch_path: "/Applications/Maximal.app/Contents/MacOS/maximal",
    launch_kind: "dmg-app",
    pid: 4242,
    uptime_ms: 65_000,
    account_type: "individual",
    models_cached: 12,
    tokens: { github_token_present: true, copilot_token_present: true },
    rate_limit: {
      interval_seconds: null,
      last_request_at: null,
      wait_when_throttled: false,
    },
    web_search: { kind: "CopilotResponsesExecutor", detail: "gpt-5-mini" },
    copilot_service: {
      upstream_host: "https://copilot-api.example.test",
      github_api_base_url: "https://api.example.test",
      token_endpoint: "https://api.example.test/copilot_internal/v2/token",
      enterprise_domain: "example.test",
      discovered_upstream: null,
    },
  }
}

function updateStatus(): UpdateStatusResponse {
  return {
    current: "1.2.3",
    latest: "1.2.3",
    update_available: false,
    url: "https://mxml.sh",
    enabled: true,
    checked_at: "2026-07-29T00:00:00.000Z",
    last_error: null,
  }
}

function contentRoutes(): Array<[string, Route]> {
  return [
    ["/settings/api/update-status", { body: updateStatus() }],
    ["/settings/api/diagnostics", { body: diagnostics() }],
  ]
}

function installInvokeStub(): void {
  invokeCalls.length = 0
  __setInvokeForTests((cmd, args) => {
    invokeCalls.push({ cmd, args })
    if (cmd === "get_shell_api_key") return Promise.resolve("test-key")
    return Promise.resolve(undefined)
  })
}

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
  __resetShellBridgeForTests()
  invokeCalls.length = 0
})

describe("Diagnostics island", () => {
  test("shows a loading caption before the fetch settles", () => {
    installInvokeStub()
    globalThis.fetch = (() =>
      new Promise<Response>(() => {})) as unknown as typeof fetch
    render(<Diagnostics />)
    expect(screen.getByText("Loading diagnostics…")).toBeDefined()
  })

  test("renders live state and the Copilot service hosts", async () => {
    installInvokeStub()
    stubFetch(contentRoutes())
    render(<Diagnostics />)

    // Proxy version from the diagnostics payload.
    expect(await screen.findByText("1.2.3")).toBeDefined()
    // The "Copilot service" disclosure and its (collapsed-but-rendered) hosts.
    expect(screen.getByText("Copilot service")).toBeDefined()
    expect(screen.getByText("https://copilot-api.example.test")).toBeDefined()
    expect(
      screen.getByText("https://api.example.test/copilot_internal/v2/token"),
    ).toBeDefined()
  })

  test("shows an error banner + retry when the fetch fails", async () => {
    installInvokeStub()
    stubFetch([
      ["/settings/api/update-status", { body: updateStatus() }],
      ["/settings/api/diagnostics", { ok: false, status: 500, body: "boom" }],
    ])
    render(<Diagnostics />)

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("boom")
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined()
  })

  test("Reveal config invokes the native command", async () => {
    installInvokeStub()
    stubFetch(contentRoutes())
    render(<Diagnostics />)
    await screen.findByText("1.2.3")

    fireEvent.click(screen.getByRole("button", { name: /Reveal config/ }))

    expect(invokeCalls.some((c) => c.cmd === "reveal_config_dir")).toBe(true)
  })

  test("Uninstall opens the confirm dialog and invokes with the purge flag", async () => {
    installInvokeStub()
    stubFetch(contentRoutes())
    render(<Diagnostics />)
    await screen.findByText("1.2.3")

    // The card's trigger opens the Radix AlertDialog.
    fireEvent.click(screen.getByRole("button", { name: "Uninstall Maximal…" }))
    const dialog = await screen.findByRole("alertdialog")

    // Confirm inside the dialog (disambiguated from the card's trigger).
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Uninstall Maximal…" }),
    )

    await act(async () => {
      await Promise.resolve()
    })

    const call = invokeCalls.find((c) => c.cmd === "uninstall_maximal")
    expect(call).toBeDefined()
    expect(call?.args).toEqual({ purge: false })
  })

  test("survives a sidecar that omits copilot_service (version skew)", async () => {
    installInvokeStub()
    // An older running sidecar predates the `copilot_service` field. `apiCall`
    // casts the response body without validating it, so the field arrives as
    // undefined — which used to crash the whole island to blank (the content
    // flickered in, then vanished). It must now degrade gracefully.
    const legacy = diagnostics() as Partial<DiagnosticsResponse>
    delete legacy.copilot_service
    stubFetch([
      ["/settings/api/update-status", { body: updateStatus() }],
      ["/settings/api/diagnostics", { body: legacy }],
    ])
    render(<Diagnostics />)

    // The section still renders its live state (no blank crash) …
    expect(await screen.findByText("1.2.3")).toBeDefined()
    // … the Quit button is present as an actual button …
    expect(screen.getByRole("button", { name: "Quit Maximal" })).toBeDefined()
    // … and the "Copilot service" disclosure is simply omitted, not thrown on.
    expect(screen.queryByText("Copilot service")).toBeNull()
  })
})
