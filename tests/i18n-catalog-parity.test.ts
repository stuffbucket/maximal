import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Single-source-of-truth guard for the OS-conditional i18n terms.
 *
 * `shell/src/i18n/en.json` is the ONE catalog that defines the OS-conditional
 * nouns the whole product uses:
 *   - `app-container` = "{os, select, macos {menu bar} other {system tray}}"
 *   - `file-manager`  = "{os, select, windows {File Explorer} linux {Files} other {Finder}}"
 *
 * The JS UI renders these via a real ICU runtime. The Rust side (Tauri shell)
 * deliberately does NOT pull in an ICU runtime for two words — instead
 * `app_container_noun()` in shell/src-tauri/src/lib.rs is a trivial hand
 * mirror of the `app-container` term. That mirror can silently diverge from
 * the catalog, so this test pins both directions:
 *   1. the catalog still spells the nouns exactly as the code expects, and
 *   2. the Rust mirror still contains those exact literals.
 *
 * If either drifts, this test fails and points you back at the catalog as the
 * source of truth.
 */

const REPO_ROOT = resolve(import.meta.dir, "..")
const CATALOG = resolve(REPO_ROOT, "shell", "src", "i18n", "en.json")
const RUST_LIB = resolve(REPO_ROOT, "shell", "src-tauri", "src", "lib.rs")

interface Catalog {
  "app-container": string
  "file-manager": string
}

function loadCatalog(): Catalog {
  return JSON.parse(readFileSync(CATALOG, "utf8")) as Catalog
}

describe("i18n catalog is the single source of truth", () => {
  test("app-container ICU term defines exactly the two container nouns", () => {
    const term = loadCatalog()["app-container"]
    expect(term).toContain("menu bar")
    expect(term).toContain("system tray")
  })

  test("Rust mirror in lib.rs carries both container-noun literals", () => {
    // The Rust side has no ICU runtime; app_container_noun() is a hand mirror.
    // Assert the exact literals are present so the mirror can't drift silently.
    const rust = readFileSync(RUST_LIB, "utf8")
    expect(rust).toContain("menu bar")
    expect(rust).toContain("system tray")
  })

  test("file-manager ICU term defines all three file-manager nouns", () => {
    const term = loadCatalog()["file-manager"]
    expect(term).toContain("Finder")
    expect(term).toContain("File Explorer")
    expect(term).toContain("Files")
  })
})
