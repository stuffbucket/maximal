import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { subscribeToQuitRequests } from "../shell/src/ui/features/quit/quit-requests"

const ROOT = resolve(import.meta.dir, "..")
const SHELL_PERMISSIONS = readFileSync(
  resolve(ROOT, "shell/src-tauri/permissions/default.toml"),
  "utf8",
)

describe("Windows quit prompt requests", () => {
  test("opens a request that was queued before the webview mounted", async () => {
    let opens = 0

    await subscribeToQuitRequests(
      () => {
        opens++
      },
      {
        subscribe: () => Promise.resolve(() => {}),
        takePending: () => Promise.resolve(true),
      },
    )

    expect(opens).toBe(1)
  })

  test("consumes and opens requests received by a mounted webview", async () => {
    let listener: (() => void) | undefined
    let pending = false
    let opens = 0

    await subscribeToQuitRequests(
      () => {
        opens++
      },
      {
        subscribe: (handler) => {
          listener = handler
          return Promise.resolve(() => {})
        },
        takePending: () => {
          const result = pending
          pending = false
          return Promise.resolve(result)
        },
      },
    )

    pending = true
    listener?.()
    await Promise.resolve()

    expect(pending).toBe(false)
    expect(opens).toBe(1)
  })

  test("degrades cleanly when Tauri events are unavailable", async () => {
    const unlisten = await subscribeToQuitRequests(
      () => {
        throw new Error("unexpected prompt")
      },
      {
        subscribe: () => Promise.reject(new Error("not running in Tauri")),
        takePending: () => Promise.resolve(false),
      },
    )

    expect(typeof unlisten).toBe("function")
    unlisten()
  })

  test("mounts the confirmation dialog in the unified window", () => {
    const html = readFileSync(
      resolve(ROOT, "shell/ui/settings/index.html"),
      "utf8",
    )
    const main = readFileSync(resolve(ROOT, "shell/src/main.ts"), "utf8")

    expect(html).toContain('id="quit-dialog-root"')
    expect(main).toContain("import { mountQuitDialog }")
    expect(main).toContain("mountQuitDialog();")
  })

  test("grants the remote Settings webview access to quit commands", () => {
    expect(SHELL_PERMISSIONS).toContain('"allow-take-quit-request"')
    expect(SHELL_PERMISSIONS).toContain(
      'commands.allow = ["take_quit_request"]',
    )
    expect(SHELL_PERMISSIONS).toContain('"allow-confirm-quit"')
    expect(SHELL_PERMISSIONS).toContain('commands.allow = ["confirm_quit"]')
  })
})
