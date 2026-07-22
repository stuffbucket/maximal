import { afterEach, describe, expect, test } from "bun:test"

import {
  __resetShellBridgeForTests,
  __setInvokeForTests,
  getShellApiKey,
  openUrl,
  safeInvoke,
} from "../shell/src/tauri/shell"

/**
 * Unit tests for the Tauri JS bridge (shell/src/tauri/shell.ts) — the only
 * remaining browser↔native invoke() seam after the single-window redesign.
 * The transport is injected via __setInvokeForTests (ADR-0011 wired-seam, no
 * mock.module), so these exercise the real memo + error-swallowing branches
 * without a DOM/mockIPC harness.
 */

afterEach(() => {
  __resetShellBridgeForTests()
  // The inlined-token fallback reads globalThis.__STATE__; clear it so a test
  // that sets it can't leak into the others.
  delete (globalThis as { __STATE__?: unknown }).__STATE__
})

describe("tauri shell bridge", () => {
  test("getShellApiKey returns the key and memoizes it (second call skips invoke)", async () => {
    let calls = 0
    __setInvokeForTests((cmd) => {
      calls += 1
      expect(cmd).toBe("get_shell_api_key")
      return Promise.resolve("sk-abc123")
    })

    expect(await getShellApiKey()).toBe("sk-abc123")
    expect(await getShellApiKey()).toBe("sk-abc123")
    expect(calls).toBe(1)
  })

  test("getShellApiKey swallows a rejection, caches null, and does not re-invoke", async () => {
    let calls = 0
    __setInvokeForTests(() => {
      calls += 1
      return Promise.reject(new Error("no shell key"))
    })

    expect(await getShellApiKey()).toBeNull()
    expect(await getShellApiKey()).toBeNull()
    expect(calls).toBe(1)
  })

  test("getShellApiKey falls back to the inlined session token when invoke fails (browser tab)", async () => {
    // A plain browser tab has no Tauri host, so invoke throws. The sidecar inlines
    // the shell key as window.__STATE__.sessionToken (§1.4); getShellApiKey must
    // read it back so /settings/api/* auth still works from the tab.
    const g = globalThis as { __STATE__?: unknown }
    g.__STATE__ = {
      snapshot: {},
      boundPort: 4141,
      sessionToken: "inlined-shell-key",
    }
    __setInvokeForTests(() => Promise.reject(new Error("no tauri host")))

    expect(await getShellApiKey()).toBe("inlined-shell-key")
  })

  test("openUrl dispatches the opener command with the url payload", async () => {
    const seen: Array<{ cmd: string; args?: Record<string, unknown> }> = []
    __setInvokeForTests((cmd, args) => {
      seen.push({ cmd, args })
      return Promise.resolve(undefined)
    })

    await openUrl("https://example.com/x")

    expect(seen).toEqual([
      {
        cmd: "plugin:opener|open_url",
        args: { url: "https://example.com/x" },
      },
    ])
  })

  test("safeInvoke returns true on success and false when invoke throws", async () => {
    __setInvokeForTests(() => Promise.resolve(undefined))
    expect(await safeInvoke("ok_cmd")).toBe(true)

    __setInvokeForTests(() => Promise.reject(new Error("boom")))
    expect(await safeInvoke("bad_cmd")).toBe(false)
  })
})
