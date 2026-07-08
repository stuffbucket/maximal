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
 * deliberately does NOT pull in an ICU runtime: its native strings (tray,
 * notifications, window titles, quit dialog) come straight from the SAME
 * catalog via `native_i18n`, with any OS-conditional noun baked into the
 * per-OS catalog key (e.g. `native-notify-startup-body-macos`) so no runtime
 * `select` is needed. This test pins the catalog nouns the JS side depends on;
 * if they drift it fails and points you back at the catalog as the source of
 * truth.
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

  test("file-manager ICU term defines all three file-manager nouns", () => {
    const term = loadCatalog()["file-manager"]
    expect(term).toContain("Finder")
    expect(term).toContain("File Explorer")
    expect(term).toContain("Files")
  })
})

describe("native (Rust) strings resolve from the catalog", () => {
  // The Tauri shell renders its OS-drawn chrome via `native_i18n`, which reads
  // the `native-*` keys out of these same JSON catalogs. There is no ICU
  // runtime and no compile-time check that a key it looks up actually exists —
  // a typo'd key would silently render as the raw key string in the tray /
  // notification. Pin every `native-*` key referenced in lib.rs to the en base
  // so that drift fails here instead of shipping a literal "native-tray-quit".
  const base = JSON.parse(readFileSync(CATALOG, "utf8")) as Record<
    string,
    string
  >
  const rust = readFileSync(RUST_LIB, "utf8")
  const referenced = [
    ...new Set([...rust.matchAll(/"(native-[a-z0-9-]+)"/g)].map((m) => m[1])),
  ].sort()

  test("lib.rs actually references native-* keys (guard didn't silently no-op)", () => {
    // If this ever hits 0, the regex or the call sites changed and the
    // coverage assertion below would pass vacuously — catch that here.
    expect(referenced.length).toBeGreaterThan(10)
  })

  test("every native-* key used in lib.rs exists in the en base catalog", () => {
    const missing = referenced.filter((k) => !(k in base))
    expect(missing).toEqual([])
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
