import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Settings → System is one section with progressive disclosure: one display
 * heading, everyday version/update state and actions first, low-level runtime
 * and log details in a closed native disclosure, Uninstall set apart. The
 * markup is parsed (not pattern-matched) so reordering or reformatting cannot
 * pass or fail these by accident; the real layout and focus rendering are
 * checked by tests/e2e/settings-system.spec.ts.
 */

const REPO_ROOT = resolve(import.meta.dir, "..")
const read = (path: string): string =>
  readFileSync(resolve(REPO_ROOT, path), "utf8")

const HTML = read("shell/ui/settings/index.html")
const MAIN_TS = read("shell/src/main.ts")
const CSS = read("shell/src/ui/styles/styles.css")
const EN = JSON.parse(read("shell/src/i18n/en.json")) as Record<string, string>

interface Node {
  tag: string
  attrs: Partial<Record<string, string>>
  /** Document order within the System section. */
  index: number
  ancestors: Array<Node>
}

const SECTION_START = HTML.indexOf('data-section="diagnostics"')
const SECTION_HTML = `<section ${HTML.slice(
  SECTION_START,
  HTML.indexOf("<!-- APPEARANCE -->"),
)}`

async function parse(html: string): Promise<Array<Node>> {
  const nodes: Array<Node> = []
  const stack: Array<Node> = []
  await new HTMLRewriter()
    .on("*", {
      element(element) {
        const node: Node = {
          tag: element.tagName,
          attrs: Object.fromEntries(element.attributes),
          index: nodes.length,
          ancestors: [...stack],
        }
        nodes.push(node)
        if (element.canHaveContent) {
          stack.push(node)
          element.onEndTag(() => {
            stack.pop()
          })
        }
      },
    })
    .transform(new Response(html))
    .text()
  return nodes
}

const nodes = await parse(SECTION_HTML)
const byHook = (name: string, value?: string): Array<Node> =>
  nodes.filter(
    (node) =>
      Object.hasOwn(node.attrs, name)
      && (value === undefined || node.attrs[name] === value),
  )
const only = (name: string, value?: string): Node => {
  const found = byHook(name, value)
  expect(
    found,
    `${name}${value === undefined ? "" : `=${value}`}`,
  ).toHaveLength(1)
  return found[0]
}
const inside = (node: Node, ancestor: Node): boolean =>
  node.ancestors.includes(ancestor)

const details = only("data-system-details")
const root = only("data-diagnostics-root")
const uninstall = only("data-uninstall-card")

const EVERYDAY: Array<[string, string?]> = [
  ["data-field", "version"],
  ["data-field", "update_status"],
  ["data-action", "check-update"],
  ["data-field", "update_check"],
  ["data-update-apt"],
  ["data-action", "copy-json"],
  ["data-action", "reveal-logs"],
  ["data-action", "reveal-config"],
]
const LOW_LEVEL: Array<[string, string?]> = [
  ["data-field", "source_revision"],
  ["data-field", "launch_source"],
  ["data-field", "pid"],
  ["data-field", "uptime"],
  ["data-field", "account_type"],
  ["data-field", "models_cached"],
  ["data-field", "web_search"],
  ["data-field", "github_copilot_status"],
  ["data-field", "rate_limit"],
  ["data-field", "logs_where_hint"],
  ["data-field", "logs_retention_value"],
]

describe("Settings System surface", () => {
  test("Logs is no longer a section of its own", () => {
    expect(HTML).not.toContain('data-section="logs"')
    expect(SECTION_START).toBeGreaterThan(-1)
  })

  test("has one display heading and plain headings below it, without extra landmarks", () => {
    const headings = nodes.filter((node) => /^h[1-6]$/u.test(node.tag))
    expect(headings.map((heading) => heading.tag)).toEqual([
      "h2",
      "h3",
      "h3",
      "h3",
    ])
    expect(headings[0]?.attrs.class).toBe("section__title")
    expect(headings[0]?.attrs["data-i18n"]).toBe("system-title")
    // The groups are plain blocks: only the System section itself is a
    // landmark, so a screen reader's region list does not fill with fragments.
    expect(nodes.filter((node) => node.tag === "section")).toHaveLength(1)
    expect(byHook("role", "region")).toHaveLength(0)
    expect(byHook("aria-labelledby")).toHaveLength(0)
  })

  test("puts version, update state and the everyday actions before the disclosure", () => {
    for (const [name, value] of EVERYDAY) {
      const node = only(name, value)
      expect(node.index, `${name}=${value}`).toBeLessThan(details.index)
      expect(inside(node, details), `${name}=${value}`).toBe(false)
    }
    expect(only("data-action", "check-update").index).toBeLessThan(
      only("data-action", "copy-json").index,
    )
  })

  test("folds the low-level runtime and log details into a closed disclosure", () => {
    expect(details.tag).toBe("details")
    expect(details.attrs.class).toBe("advanced-section")
    expect(Object.hasOwn(details.attrs, "open")).toBe(false)
    const summaries = nodes.filter((node) => node.tag === "summary")
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.ancestors.at(-1)).toBe(details)
    for (const [name, value] of LOW_LEVEL) {
      expect(inside(only(name, value), details), `${name}=${value}`).toBe(true)
    }
    for (const label of ["logs-path-unix-label", "logs-path-windows-label"]) {
      expect(inside(only("data-i18n", label), details), label).toBe(true)
    }
  })

  test("keeps Uninstall apart, after and outside the diagnostics stack", () => {
    expect(uninstall.index).toBeGreaterThan(details.index)
    expect(inside(uninstall, root)).toBe(false)
    expect(inside(uninstall, details)).toBe(false)
    for (const [name] of [
      ["data-uninstall-body"],
      ["data-uninstall-purge"],
      ["data-uninstall-error"],
    ] as const) {
      const node = only(name)
      expect(inside(node, uninstall), name).toBe(true)
      expect(inside(node, root), name).toBe(false)
    }
    const button = only("data-action", "uninstall-maximal")
    expect(inside(button, uninstall)).toBe(true)
    expect(button.attrs.class).toContain("btn--destructive")
    expect(CSS).toMatch(
      /\.system-uninstall \{[^}]*border-block-start: var\(--border-width-hairline\) solid var\(--border-subtle\)/u,
    )
  })

  test("keeps the one busy region the readiness hook and loader share", () => {
    expect(root.attrs["aria-busy"]).toBe("true")
    expect(root.ancestors.map((node) => node.tag)).toEqual(["section"])
    expect(MAIN_TS).toContain('"[data-diagnostics-root]"')
    expect(MAIN_TS).toContain('root.setAttribute("aria-busy", "false")')
  })

  test("keeps the hooks the diagnostics, update and log wiring depend on", () => {
    expect(byHook("data-diagnostics-error")).toHaveLength(1)
    expect(byHook("data-diagnostics-retry")).toHaveLength(1)
    expect(only("id", "restart-proxy").tag).toBe("button")
    // The scoped selectors main.ts wires must still find their buttons here.
    expect(MAIN_TS).toContain(
      `[data-section="diagnostics"] [data-action="reveal-logs"]`,
    )
    expect(MAIN_TS).toContain(
      `[data-section="diagnostics"] [data-action="reveal-config"]`,
    )
    expect(MAIN_TS).toContain('window.location.hash = "diagnostics"')
  })

  test("the disclosure summary has a keyboard focus ring rule", () => {
    expect(CSS).toMatch(
      /\.advanced-section__summary:focus-visible \{[^}]*outline: var\(--focus-ring\)/u,
    )
    expect(CSS).not.toMatch(/\.advanced-section__summary:focus(?!-visible)/u)
  })

  test("the folder buttons read Open Logs and Open Config on every OS, on the same hooks", () => {
    expect(only("data-action", "reveal-logs").attrs["data-i18n"]).toBe(
      "reveal-logs",
    )
    expect(only("data-action", "reveal-config").attrs["data-i18n"]).toBe(
      "reveal-config",
    )
    expect(EN["reveal-logs"]).toBe("Open Logs")
    expect(EN["reveal-config"]).toBe("Open Config")
    // No file-manager noun left to inject, so no OS variants of the label.
    expect(EN["reveal-logs"]).not.toContain("{")
    expect(EN["reveal-config"]).not.toContain("{")
    // Still the OS file manager underneath.
    expect(MAIN_TS).toContain('void safeInvoke("reveal_logs_dir")')
    expect(MAIN_TS).toContain('void safeInvoke("reveal_config_dir")')
    // Comments elsewhere name the button as it now reads.
    const bootIo = read("src/lib/start/boot-io.ts")
    expect(bootIo).toContain('"Open Logs"')
    expect(bootIo).not.toContain("Reveal logs in")
  })

  test("every string in the section comes from the catalog", () => {
    const keys = nodes.flatMap((node) =>
      ["data-i18n", "data-i18n-title"].flatMap((name) => {
        const key = node.attrs[name]
        return key === undefined ? [] : [key]
      }),
    )
    expect(keys).toContain("system-title")
    expect(keys).toContain("system-details-title")
    for (const key of keys) expect(EN[key], key).toBeString()
    // Headings and the summary carry no literal text of their own.
    const html = SECTION_HTML.replaceAll(/<!--[\s\S]*?-->/gu, "")
    expect(html).not.toMatch(
      />\s*(?:System|Troubleshooting|Technical details|Runtime)\s*</u,
    )
  })
})
