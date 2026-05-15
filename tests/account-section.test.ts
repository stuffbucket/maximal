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
    for (const action of ["auth-start", "sign-out", "copy-user-code"]) {
      expect(section.includes(`data-action="${action}"`)).toBe(true)
    }
  })

  test("data-field slots match the AuthStatus contract", () => {
    const section = accountSection()
    for (const field of [
      "verification_uri",
      "user_code",
      "expires_at",
      "account_login",
      "error",
    ]) {
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
})
