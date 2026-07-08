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
const I18N_DIR = resolve(REPO_ROOT, "shell", "src", "i18n")
const CATALOG = resolve(I18N_DIR, "en.json")
const RUST_LIB = resolve(REPO_ROOT, "shell", "src-tauri", "src", "lib.rs")

/**
 * Every locale that ships in the catalog. `en` is the base; the rest resolve
 * through the region→language→en fallback chain, so a regional file may be a
 * sparse set of overrides (or empty) — but `es` is the Spanish LANGUAGE base
 * that es-MX/es-ES fall back to, so it must cover the whole key set.
 */
const OVERRIDE_LOCALES = ["en-GB", "es", "es-MX", "es-ES"] as const
const FULL_COVERAGE_LOCALES = new Set(["es"])

function loadLocale(tag: string): Record<string, string> {
  return JSON.parse(
    readFileSync(resolve(I18N_DIR, `${tag}.json`), "utf8"),
  ) as Record<string, string>
}

/** `{n, plural, …}` / `{os, select, …}` — the arg name + kind, e.g. "os:select". */
function complexArgs(msg: string): Set<string> {
  const out = new Set<string>()
  const re = /\{\s*(\w+)\s*,\s*(plural|select|selectordinal)\b/g
  for (let m = re.exec(msg); m; m = re.exec(msg)) out.add(`${m[1]}:${m[2]}`)
  return out
}

/** Simple `{name}` tokens. Only trustworthy when the message has no
 * select/plural (whose branch literals like `{Mac}` would otherwise be
 * mistaken for placeholders), so callers gate on complexArgs being empty. */
function simpleArgs(msg: string): Set<string> {
  const out = new Set<string>()
  const re = /\{\s*(\w+)\s*\}/g
  for (let m = re.exec(msg); m; m = re.exec(msg)) out.add(m[1])
  return out
}

function braceBalanced(msg: string): boolean {
  let depth = 0
  for (const ch of msg) {
    if (ch === "{") depth++
    else if (ch === "}" && --depth < 0) return false
  }
  return depth === 0
}

function fmt(s: Set<string>): string {
  return [...s].sort().join(", ")
}

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

describe("multi-locale catalog integrity (#278)", () => {
  const base = JSON.parse(readFileSync(CATALOG, "utf8")) as Record<
    string,
    string
  >
  const baseKeys = new Set(Object.keys(base))

  for (const tag of OVERRIDE_LOCALES) {
    describe(tag, () => {
      const locale = loadLocale(tag)
      const entries = Object.entries(locale)

      test("declares no key absent from the en base (no dead/typo'd keys)", () => {
        const stray = Object.keys(locale).filter((k) => !baseKeys.has(k))
        expect(stray).toEqual([])
      })

      test("every message has balanced ICU braces", () => {
        const broken = entries
          .filter(([, v]) => !braceBalanced(v))
          .map(([k]) => k)
        expect(broken).toEqual([])
      })

      test("preserves every base placeholder / plural-select arg", () => {
        // A translation may reword freely, but dropping a base arg loses data
        // and INTRODUCING one throws at format time (arg not provided). So the
        // arg surface of each override must match its base key exactly.
        const drifted: Array<string> = []
        for (const [k, v] of entries) {
          if (!(k in base)) continue // covered by the stray-key test
          const b = base[k]
          const bc = complexArgs(b)
          const vc = complexArgs(v)
          if (fmt(bc) !== fmt(vc)) {
            drifted.push(`${k}: complex {${fmt(bc)}} vs {${fmt(vc)}}`)
            continue
          }
          // Simple placeholders are only unambiguous without select/plural
          // (whose branch literals look like {tokens}); check those keys.
          if (bc.size === 0) {
            const bs = simpleArgs(b)
            const vs = simpleArgs(v)
            if (fmt(bs) !== fmt(vs)) {
              drifted.push(`${k}: args {${fmt(bs)}} vs {${fmt(vs)}}`)
            }
          }
        }
        expect(drifted).toEqual([])
      })

      if (FULL_COVERAGE_LOCALES.has(tag)) {
        test("is a full language base — covers every en key", () => {
          const missing = [...baseKeys].filter((k) => !(k in locale))
          expect(missing).toEqual([])
        })
      }
    })
  }
})
