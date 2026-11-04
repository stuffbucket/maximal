import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { subscribeToQuitRequests } from "../shell/src/ui/features/quit/quit-requests"

const ROOT = resolve(import.meta.dir, "..")
const SHELL_PERMISSIONS = readFileSync(
  resolve(ROOT, "shell/src-tauri/permissions/default.toml"),
  "utf8",
)
const SHELL_SOURCE = readFileSync(
  resolve(ROOT, "shell/src-tauri/src/lib.rs"),
  "utf8",
)

describe("Windows quit prompt requests", () => {
  test("opens a request that was queued before the webview mounted", async () => {
    let opens = 0

    const subscription = subscribeToQuitRequests(
      () => {
        opens++
      },
      {
        subscribe: () => Promise.resolve(() => {}),
        hasPending: () => Promise.resolve(true),
      },
    )
    await subscription.ready

    expect(opens).toBe(1)
    subscription.unsubscribe()
  })

  test("observes and opens requests received by a mounted webview", async () => {
    let listener: (() => void) | undefined
    let pending = false
    let opens = 0

    const subscription = subscribeToQuitRequests(
      () => {
        opens++
      },
      {
        subscribe: (handler) => {
          listener = handler
          return Promise.resolve(() => {})
        },
        hasPending: () => Promise.resolve(pending),
      },
    )
    await subscription.ready

    pending = true
    listener?.()
    await Promise.resolve()

    expect(pending).toBe(true)
    expect(opens).toBe(1)
    subscription.unsubscribe()
  })

  test("observes requests delivered through the local webview bridge", async () => {
    let localListener: (() => void) | undefined
    let pending = false
    let opens = 0

    const subscription = subscribeToQuitRequests(
      () => {
        opens++
      },
      {
        subscribe: () => Promise.resolve(() => {}),
        subscribeLocal: (handler) => {
          localListener = handler
          return () => {
            localListener = undefined
          }
        },
        hasPending: () => Promise.resolve(pending),
      },
    )
    await subscription.ready

    pending = true
    localListener?.()
    await Promise.resolve()

    expect(pending).toBe(true)
    expect(opens).toBe(1)
    subscription.unsubscribe()
    expect(localListener).toBeUndefined()
  })

  test("does not consume an in-flight pending query after disposal", async () => {
    let resolvePending: ((pending: boolean) => void) | undefined
    let opens = 0

    const subscription = subscribeToQuitRequests(
      () => {
        opens++
      },
      {
        subscribe: () => Promise.resolve(() => {}),
        hasPending: () =>
          new Promise<boolean>((resolve) => {
            resolvePending = resolve
          }),
      },
    )
    await Promise.resolve()

    subscription.unsubscribe()
    resolvePending?.(true)
    await subscription.ready

    expect(opens).toBe(0)
  })

  test("stops local delivery before an async remote subscription settles", async () => {
    let localListener: (() => void) | undefined
    let resolveSubscribe: ((unlisten: () => void) => void) | undefined
    const pending = true
    let opens = 0

    const subscription = subscribeToQuitRequests(
      () => {
        opens++
      },
      {
        subscribe: () =>
          new Promise<() => void>((resolve) => {
            resolveSubscribe = resolve
          }),
        subscribeLocal: (handler) => {
          localListener = handler
          return () => {
            localListener = undefined
          }
        },
        hasPending: () => Promise.resolve(pending),
      },
    )

    subscription.unsubscribe()
    expect(localListener).toBeUndefined()
    resolveSubscribe?.(() => {})
    await subscription.ready

    expect(pending).toBe(true)
    expect(opens).toBe(0)
  })

  test("degrades cleanly when Tauri events are unavailable", async () => {
    const subscription = subscribeToQuitRequests(
      () => {
        throw new Error("unexpected prompt")
      },
      {
        subscribe: () => Promise.reject(new Error("not running in Tauri")),
        hasPending: () => Promise.resolve(false),
      },
    )
    await subscription.ready

    expect(typeof subscription.unsubscribe).toBe("function")
    subscription.unsubscribe()
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

  test("routes the Windows close button through the confirmation flow", () => {
    expect(SHELL_SOURCE).toContain(
      "CloseWindowAction::ConfirmQuit => request_quit(&app_clone)",
    )
    expect(SHELL_SOURCE).not.toContain(
      "CloseWindowAction::ConfirmQuit => exit_gracefully",
    )
    expect(SHELL_SOURCE).toContain(
      "window.dispatchEvent(new CustomEvent('maximal:quit-requested'))",
    )
  })

  test("grants the remote Settings webview access to quit commands", () => {
    expect(SHELL_PERMISSIONS).toContain('"allow-has-quit-request"')
    expect(SHELL_PERMISSIONS).toContain('commands.allow = ["has_quit_request"]')
    expect(SHELL_PERMISSIONS).toContain('"allow-take-quit-request"')
    expect(SHELL_PERMISSIONS).toContain(
      'commands.allow = ["take_quit_request"]',
    )
    expect(SHELL_PERMISSIONS).toContain('"allow-confirm-quit"')
    expect(SHELL_PERMISSIONS).toContain('commands.allow = ["confirm_quit"]')
  })
})
