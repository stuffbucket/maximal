import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * Frontend integration smoke for the Account section.
 *
 * The Tauri shell has no jsdom harness in this repo yet, so these
 * tests grep the source HTML for the contract attributes the
 * controller in shell/src/main.ts depends on. If anyone moves a
 * `data-state-account` card, drops a `data-action`, or renames a
 * `data-field`, this fails fast.
 */

const REPO_ROOT = resolve(import.meta.dir, "..")
const INDEX_HTML = join(REPO_ROOT, "shell", "index.html")

function html(): string {
  return readFileSync(INDEX_HTML, "utf8")
}

function accountSection(): string {
  const source = html()
  const start = source.indexOf('data-section="account"')
  expect(start).toBeGreaterThan(-1)
  // Slice from the opening of the section element forward. The next
  // `data-section=` after `start` marks the boundary.
  const sectionStart = source.lastIndexOf("<section", start)
  const next = source.indexOf("data-section=", start + 1)
  return source.slice(sectionStart, next === -1 ? undefined : next)
}

describe("Account section markup", () => {
  test("all four state cards exist", () => {
    const section = accountSection()
    for (const state of [
      "unauthenticated",
      "pending",
      "authenticated",
      "error",
    ]) {
      expect(section.includes(`data-state-account="${state}"`)).toBe(true)
    }
  })

  test("data-action buttons are wired", () => {
    const section = accountSection()
    // `sign-in-with-code` is the single-button replacement for the old
    // `copy-user-code` + separate verification-URL link. It copies the
    // device code to the clipboard and opens the verification URL in
    // one click; the controller reads both values from currentAuthStatus.
    for (const action of ["auth-start", "sign-out", "sign-in-with-code"]) {
      expect(section.includes(`data-action="${action}"`)).toBe(true)
    }
  })

  test("data-field slots match the AuthStatus contract", () => {
    const section = accountSection()
    // verification_uri is no longer rendered as a data-field slot —
    // the sign-in-with-code button reads it from currentAuthStatus and
    // hands it to the system opener. The other three pending-state
    // fields plus the authenticated/error slots remain.
    for (const field of ["user_code", "expires_at", "account_login", "error"]) {
      expect(section.includes(`data-field="${field}"`)).toBe(true)
    }
  })

  test("error card uses the error variant", () => {
    const section = accountSection()
    expect(section.includes("card--error")).toBe(true)
  })

  test("no auto-open browser anchor — link is user-driven", () => {
    const section = accountSection()
    // The verification URL must be a plain anchor the user clicks,
    // not a window.open or a JS-triggered redirect. We allow only
    // the empty href= placeholder the controller fills.
    expect(section.includes("window.open")).toBe(false)
  })

  test("known-account rosters live in a shared container, not a state card", () => {
    const section = accountSection()
    // The remembered + gh rosters moved OUT of the unauthenticated card into a
    // shared [data-account-rosters] block so the controller can surface them
    // across the unauthenticated, error, and device-code states (device-code
    // is a fallback, never the only option). Both list anchors the controller
    // queries must live inside that shared container.
    const start = section.indexOf("data-account-rosters")
    expect(start).toBeGreaterThan(-1)
    // Both roster anchors the controller queries must appear AFTER the shared
    // container opens (i.e. inside it), not before.
    expect(section.indexOf("data-account-remembered-list")).toBeGreaterThan(
      start,
    )
    expect(section.indexOf("data-gh-accounts")).toBeGreaterThan(start)
    // There must be exactly one of each roster anchor in the section (the
    // shared one) — they must not also linger inside a per-state card.
    expect(section.split("data-account-remembered-list").length - 1).toBe(1)
    expect(section.split("data-gh-accounts").length - 1).toBe(1)
  })

  test("the shared rosters block is not gated to a single state card", () => {
    const section = accountSection()
    // It must NOT carry a data-state-account attribute (which the controller's
    // hide-all-but-active loop would clobber); the controller toggles it
    // directly per state instead.
    const open = section.indexOf('<div class="account-rosters"')
    expect(open).toBeGreaterThan(-1)
    const openTag = section.slice(open, section.indexOf(">", open))
    expect(openTag.includes("data-state-account")).toBe(false)
  })
})
