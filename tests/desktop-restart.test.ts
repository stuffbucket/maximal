import { describe, expect, test } from "bun:test"

import type { AppEntry } from "../src/lib/config/settings-types"

import {
  desktopRestartChange,
  desktopRestartCopy,
  toggleApplied,
} from "../shell/src/ui/features/apps/desktop-restart"

/**
 * Claude Desktop reads its gateway profile at launch, so after Maximal
 * actually applies an enable or disable the user is told to quit and reopen
 * it. Nothing is said when the change was refused, failed, or came back in a
 * different state than requested.
 */

const DESKTOP: AppEntry = {
  id: "claude-desktop",
  name: "Claude Desktop",
  kind: "config",
  enabled: true,
  status: "ready",
  installs: [],
  install: null,
  conflict: null,
}

describe("toggleApplied", () => {
  test("is true only when the server reports the requested state without a conflict", () => {
    expect(toggleApplied(DESKTOP, true)).toBe(true)
    expect(toggleApplied({ ...DESKTOP, enabled: false }, false)).toBe(true)
    // Refused enable: comes back off with the reason.
    expect(
      toggleApplied(
        { ...DESKTOP, enabled: false, conflict: "foreign-gateway-profile" },
        true,
      ),
    ).toBe(false)
    // Mismatched state with no conflict: not applied either.
    expect(toggleApplied({ ...DESKTOP, enabled: false }, true)).toBe(false)
    expect(toggleApplied(DESKTOP, false)).toBe(false)
    // A conflict alongside the requested state is still not a clean apply.
    expect(
      toggleApplied({ ...DESKTOP, conflict: "cleanup-required" }, true),
    ).toBe(false)
  })
})

describe("desktopRestartChange", () => {
  test("names the change after an applied enable or disable of Claude Desktop", () => {
    expect(
      desktopRestartChange("claude-desktop", true, { ok: true, applied: true }),
    ).toBe("enabled")
    expect(
      desktopRestartChange("claude-desktop", false, {
        ok: true,
        applied: true,
      }),
    ).toBe("disabled")
  })

  test("says nothing after a refusal, a failed request, or an unapplied result", () => {
    expect(
      desktopRestartChange("claude-desktop", true, {
        ok: true,
        applied: false,
      }),
    ).toBeNull()
    expect(
      desktopRestartChange("claude-desktop", true, { ok: true }),
    ).toBeNull()
    expect(
      desktopRestartChange("claude-desktop", true, {
        ok: false,
        error: "boom",
      }),
    ).toBeNull()
  })

  test("is for Claude Desktop only", () => {
    for (const id of ["claude-code", "codex", "copilot-cli"] as const) {
      expect(
        desktopRestartChange(id, true, { ok: true, applied: true }),
      ).toBeNull()
    }
  })
})

describe("desktopRestartCopy", () => {
  test("after enabling: restart guidance plus the sign-in recovery note", () => {
    expect(desktopRestartCopy("enabled")).toEqual({
      title: "Restart Claude Desktop",
      body: "Quit and reopen Claude Desktop for this change to take effect.",
      note: "If Claude Desktop asks you to sign in and sign-in doesn’t complete, leave the integration enabled, quit Claude Desktop completely, reopen it, and try again.",
      action: "Got it",
    })
  })

  test("after disabling: the same guidance without the sign-in note", () => {
    expect(desktopRestartCopy("disabled")).toEqual({
      title: "Restart Claude Desktop",
      body: "Quit and reopen Claude Desktop for this change to take effect.",
      note: null,
      action: "Got it",
    })
  })
})
