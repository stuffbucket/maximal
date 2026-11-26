import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { isTrailingClickOfOpening } from "../shell/src/ui/components/modal-click-guard"
import { subscribeToUpdateRequests } from "../shell/src/ui/features/update/update-requests"

/**
 * The tray's update actions carry an explicit request to Settings (never
 * inferred from a #diagnostics location), and Settings' dialogs can't be
 * dismissed or answered by the trailing click of the double click that
 * opened them.
 */

const ROOT = resolve(import.meta.dir, "..")
const read = (path: string): string => readFileSync(resolve(ROOT, path), "utf8")

describe("tray update requests reach Settings explicitly", () => {
  test("a request queued before the window loaded is taken once on mount", async () => {
    let pending = true
    let requests = 0
    const subscription = subscribeToUpdateRequests(
      () => {
        requests++
      },
      {
        subscribe: () => Promise.resolve(() => {}),
        take: () => {
          const taken = pending
          pending = false
          return Promise.resolve(taken)
        },
      },
    )
    await subscription.ready
    expect(requests).toBe(1)
    expect(pending).toBe(false)
    subscription.unsubscribe()
  })

  test("a request signalled to an open window is taken from the queue", async () => {
    let pending = false
    let signal: (() => void) | undefined
    let requests = 0
    const subscription = subscribeToUpdateRequests(
      () => {
        requests++
      },
      {
        subscribe: (handler) => {
          signal = handler
          return Promise.resolve(() => {})
        },
        take: () => {
          const taken = pending
          pending = false
          return Promise.resolve(taken)
        },
      },
    )
    await subscription.ready
    expect(requests).toBe(0)

    pending = true
    signal?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(requests).toBe(1)
    // A duplicate signal for the same request finds nothing left to take.
    signal?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(requests).toBe(1)
    subscription.unsubscribe()
  })

  test("nothing queued, nothing signalled: no request", async () => {
    let requests = 0
    const subscription = subscribeToUpdateRequests(
      () => {
        requests++
      },
      {
        subscribe: () => Promise.resolve(() => {}),
        take: () => Promise.resolve(false),
      },
    )
    await subscription.ready
    expect(requests).toBe(0)
    subscription.unsubscribe()
  })

  test("outside the app (no bridge) it does nothing", async () => {
    let requests = 0
    const subscription = subscribeToUpdateRequests(
      () => {
        requests++
      },
      {
        subscribe: () => Promise.reject(new Error("no Tauri")),
        take: () => Promise.reject(new Error("no Tauri")),
      },
    )
    await subscription.ready
    expect(requests).toBe(0)
    subscription.unsubscribe()
  })

  test("Settings never infers update intent from a #diagnostics location", () => {
    const main = read("shell/src/main.ts")
    expect(main).not.toContain("revealingAptCommand")
    expect(main).not.toMatch(/hash === "#diagnostics"[\s\S]{0,200}startUpdate/u)
    expect(main).toContain("subscribeToUpdateRequests(")
  })

  test("the shell queues the request, signals it, and lets Settings take it", () => {
    const lib = read("shell/src-tauri/src/lib.rs")
    const permissions = read("shell/src-tauri/permissions/default.toml")
    expect(lib).toContain(
      'const UPDATE_REQUESTED_EVENT: &str = "app://update-requested";',
    )
    expect(lib).toContain("struct PendingUpdateRequest(")
    // Queued before Settings opens, kept only if it opened (Rust-tested).
    expect(lib).toMatch(
      /TrayUpdateHandoff::AptInSettings => \{\s+let opened = queue_update_request\(&app\.state::<PendingUpdateRequest>\(\), \|\| \{\s+try_open_settings_window\(app, Some\(APT_UPDATE_SECTION\)\)\s+\}\);\s+if !opened \{\s+return;\s+\}/u,
    )
    expect(lib).toContain(
      "app.emit_to(SETTINGS_WINDOW_LABEL, UPDATE_REQUESTED_EVENT, ())",
    )
    expect(lib).toContain("fn take_update_request(")
    expect(lib.match(/\btake_update_request,/gu)).toHaveLength(1)
    expect(permissions).toContain('"allow-take-update-request"')
    expect(permissions).toContain('commands.allow = ["take_update_request"]')
  })
})

describe("tray hand-offs always ask first", () => {
  test("opening mxml.sh from the tray waits for a native confirmation", () => {
    const lib = read("shell/src-tauri/src/lib.rs")
    const en = JSON.parse(read("shell/src/i18n/en.json")) as Record<
      string,
      string
    >
    expect(lib).toMatch(
      /TrayUpdateHandoff::DownloadPage => \{[\s\S]*?if !app\.state::<DownloadPagePrompt>\(\)\.claim\(\) \{\s+return;\s+\}[\s\S]*?if confirm_open_update_page\(&handle, &latest\)\.await \{\s+open_update_url\(&handle\);\s+\}\s+handle\.state::<DownloadPagePrompt>\(\)\.release\(\);/u,
    )
    // The only call of open_update_url is behind that confirmation.
    expect(lib.match(/\bopen_update_url\(&/gu)).toHaveLength(1)
    expect(lib).toContain('"native-update-open-body"')
    expect(lib).toContain('"native-update-open-action"')
    expect(en["native-update-open-body"]).toBe(
      "Your browser will open mxml.sh so you can download Maximal {version}.",
    )
    expect(en["native-update-open-action"]).toBe("Open mxml.sh")
  })
})

describe("a dialog ignores the trailing click of the gesture that opened it", () => {
  test("a second click arriving right after opening is swallowed", () => {
    expect(isTrailingClickOfOpening(2, 30)).toBe(true)
    expect(isTrailingClickOfOpening(3, 120)).toBe(true)
  })

  test("deliberate clicks still work: single clicks, and later double clicks", () => {
    expect(isTrailingClickOfOpening(1, 10)).toBe(false)
    expect(isTrailingClickOfOpening(0, 10)).toBe(false)
    expect(isTrailingClickOfOpening(2, 900)).toBe(false)
  })
})
