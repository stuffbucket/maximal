#!/usr/bin/env bun
// Ad-hoc UI layout inspector. Loads a URL in headless Chromium and reports the
// things happy-dom can't compute:
//   1. computed display + gap for every flex/grid container under the root,
//   2. the vertical distance between adjacent sibling blocks (a ~0 = a "jam"),
//   3. targeted "dead hook" checks scoped to the selected root, via --expect,
//   4. a full-page screenshot you actually look at.
//
// Usage:
//   bun inspect.ts <url> [--root <sel>] [--ready <sel>] [--out <png>] \
//     [--expect a,b,c]
//   bun inspect.ts http://127.0.0.1:4199/ui/settings/#diagnostics \
//     --root '[data-section="diagnostics"]' --out /tmp/diag.png \
//     --ready '[data-diagnostics-root][aria-busy="false"]' \
//     --expect '[data-diagnostics-root],[data-uninstall-body],.uninstall-options'
import { chromium } from "@playwright/test"

interface ContainerReport {
  tag: string
  cls: string
  display: string
  dir: string
  rowGap: string
  columnGap: string
}

interface JamReport {
  between: string
  gap: number
  axis: "horizontal" | "vertical"
}

interface InvalidSelectorReport {
  selector: string
  error: string
}

type LayoutReport =
  | { error: string }
  | {
      containers: Array<ContainerReport>
      jams: Array<JamReport>
      missing: Array<string>
      invalidSelectors: Array<InvalidSelectorReport>
    }

const args = process.argv.slice(2)
const url = args.find((argument) => !argument.startsWith("--"))
const flag = (name: string, fallback: string): string => {
  const index = args.indexOf(name)
  const value = args[index + 1]
  return index !== -1 && value ? value : fallback
}
if (!url) {
  console.error(
    "usage: bun inspect.ts <url> [--root sel] [--ready sel] [--out png] [--expect a,b]",
  )
  process.exit(2)
}
const rootSelector = flag("--root", "main")
const readySelector = flag("--ready", rootSelector)
const outputPath = flag("--out", "/tmp/ui-inspect.png")
const expectedSelectors = flag("--expect", "")
  .split(",")
  .map((selector) => selector.trim())
  .filter(Boolean)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
page.setDefaultTimeout(5_000)
await page.emulateMedia({ reducedMotion: "reduce" })
await page.coverage.startCSSCoverage()
await page.goto(url, { waitUntil: "domcontentloaded" })

let readinessError: string | null = null
try {
  await page.locator(readySelector).waitFor({ state: "visible" })
  await page.evaluate(async () => {
    await document.fonts.ready
  })
} catch (error) {
  readinessError =
    error instanceof Error ? error.message : `not ready: ${readySelector}`
}

const report =
  readinessError ?
    {
      error: `root not ready: ${rootSelector} (waited for ${readySelector})\n${readinessError}`,
    }
  : await page.evaluate<
      LayoutReport,
      { selector: string; expected: Array<string> }
    >(
      ({ selector, expected }) => {
        const root = document.querySelector(selector)
        if (!root) return { error: `root not found: ${selector}` }

        const containers: Array<ContainerReport> = []
        const jams: Array<JamReport> = []
        const visibleChildren = (element: Element): Array<Element> =>
          Array.from(element.children).filter(
            (child) =>
              getComputedStyle(child).display !== "none"
              && child.getClientRects().length > 0,
          )
        const recordFlexJams = (
          element: Element,
          style: CSSStyleDeclaration,
        ): void => {
          const isColumn = style.flexDirection === "column"
          const isRow =
            style.flexDirection === "row" && style.flexWrap === "nowrap"
          if (!isColumn && !isRow) return

          const children = visibleChildren(element)
          for (let index = 1; index < children.length; index += 1) {
            const previous = children[index - 1].getBoundingClientRect()
            const current = children[index].getBoundingClientRect()
            const gap = Math.round(
              isColumn ?
                current.top - previous.bottom
              : current.left - previous.right,
            )
            if (gap <= 1) {
              jams.push({
                between: `${children[index - 1].className || children[index - 1].tagName} → ${children[index].className || children[index].tagName}`,
                gap,
                axis: isColumn ? "vertical" : "horizontal",
              })
            }
          }
        }
        const walk = (element: Element): void => {
          const style = getComputedStyle(element)
          const isFlex = ["flex", "inline-flex"].includes(style.display)
          const isGrid = ["grid", "inline-grid"].includes(style.display)
          if (isFlex || isGrid) {
            containers.push({
              tag: element.tagName.toLowerCase(),
              cls: element.className.slice(0, 40),
              display: style.display,
              dir: isFlex ? style.flexDirection : "grid",
              rowGap: style.rowGap,
              columnGap: style.columnGap,
            })
            if (isFlex) recordFlexJams(element, style)
          }
          for (const child of visibleChildren(element)) walk(child)
        }
        walk(root)

        const missing: Array<string> = []
        const invalidSelectors: Array<InvalidSelectorReport> = []
        for (const expectedSelector of expected) {
          try {
            const matchesRoot = root.matches(expectedSelector)
            const matchesDescendant =
              root.querySelectorAll(expectedSelector).length > 0
            if (!matchesRoot && !matchesDescendant)
              missing.push(expectedSelector)
          } catch (error) {
            invalidSelectors.push({
              selector: expectedSelector,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
        return { containers, jams, missing, invalidSelectors }
      },
      { selector: rootSelector, expected: expectedSelectors },
    )

const coverage = await page.coverage.stopCSSCoverage()
let usedBytes = 0
let totalBytes = 0
for (const entry of coverage) {
  totalBytes += entry.text?.length ?? 0
  for (const range of entry.ranges) usedBytes += range.end - range.start
}

// Settings scrolls `.pane` inside a viewport-height shell. Expand those wrappers
// only after measuring layout so the screenshot includes off-screen content.
await page.addStyleTag({
  content: `
    html, body { height: auto !important; overflow: visible !important; }
    .app { height: auto !important; overflow: visible !important; }
    .shell { flex: none !important; min-height: auto !important; }
    .pane { flex: none !important; overflow: visible !important; }
  `,
})
await page.screenshot({ path: outputPath, fullPage: true })
await browser.close()

let bad = false
console.log(`\nURL: ${url}\nroot: ${rootSelector}\n`)
if ("error" in report) {
  console.log(`!! ${report.error}`)
  bad = true
} else {
  console.log("flex/grid containers under root (dir = flex-direction):")
  for (const container of report.containers) {
    console.log(
      `  ${container.display.padEnd(11)} ${container.dir.padEnd(7)} rowGap=${container.rowGap.padEnd(8)} columnGap=${container.columnGap.padEnd(8)} <${container.tag} class="${container.cls}">`,
    )
  }
  if (report.jams.length > 0) {
    bad = true
    console.log("\n!! POSSIBLE JAMS (adjacent blocks with ~0 gap):")
    for (const jam of report.jams) {
      console.log(`  ${jam.gap}px ${jam.axis.padEnd(10)} ${jam.between}`)
    }
  } else {
    console.log("\nok: no jams (all adjacent blocks separated)")
  }
  if (report.invalidSelectors.length > 0) {
    bad = true
    console.log("\n!! INVALID EXPECTED SELECTORS:")
    for (const invalid of report.invalidSelectors) {
      console.log(`  ${invalid.selector}: ${invalid.error}`)
    }
  }
  if (expectedSelectors.length > 0) {
    if (report.missing.length > 0) {
      bad = true
      console.log(
        "\n!! DEAD HOOKS (expected selectors matching zero elements):",
      )
      for (const selector of report.missing) console.log(`  ${selector}`)
    } else if (report.invalidSelectors.length === 0) {
      console.log(
        `\nok: all ${expectedSelectors.length} expected selector(s) matched`,
      )
    }
  }
}
console.log(
  `\ncss coverage: ${usedBytes}/${totalBytes} bytes used across ${coverage.length} sheet(s)`,
)
console.log(`screenshot → ${outputPath}  (open it and LOOK)\n`)
process.exit(bad ? 1 : 0)
