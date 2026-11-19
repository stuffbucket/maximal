import { describe, expect, test } from "bun:test"

import type {
  PickerModel,
  PickerView,
  Style,
} from "../examples/pi-model-picker/renderer"

import {
  formatTokens,
  formatUsd,
  installPickerRenderer,
  knownCost,
  nameWidth,
  price,
  renderPicker,
} from "../examples/pi-model-picker/renderer"

// Plain-text style: selection is bracketed so highlight boundaries are visible.
// Like ANSI codes, the brackets take no terminal cells.
const plainWidth = (text: string) =>
  Array.from(text.replaceAll(/[<>]/gu, "")).length
const style: Style = {
  fg: (_token, text) => text,
  selected: (text) => `<${text}>`,
  bold: (text) => text,
  truncate: (text, width) =>
    plainWidth(text) <= width ? text : (
      Array.from(text).slice(0, width).join("")
    ),
  measure: plainWidth,
}
const tiered = {
  known: true,
  input: 0.1,
  output: 0.5,
  cacheRead: 0.01,
  cacheWrite: 0.125,
  tiers: [
    {
      inputTokensAbove: 100_000,
      input: 0.5,
      output: 2.5,
      cacheRead: 0.05,
      cacheWrite: 0.625,
    },
  ],
}
const models: Array<PickerModel> = [
  {
    id: "claude-haiku-5.5",
    name: "Claude Haiku 5.5",
    provider: "maximal",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    reasoning: true,
    input: ["text", "image"],
    cost: tiered,
  },
  {
    id: "claude-opus-5.5",
    name: "Claude Opus 5.5",
    provider: "maximal",
    contextWindow: 1_050_000,
    cost: { known: true, input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  },
  { id: "mystery", provider: "maximal", contextWindow: 400_000 },
]
const view = (overrides: Partial<PickerView> = {}): PickerView => ({
  models,
  selectedIndex: 0,
  isCurrent: (model) => model.id === "claude-opus-5.5",
  isDefault: (model) => model.id === "claude-opus-5.5",
  ...overrides,
})
const columnOf = (row: string, needle: string) => row.indexOf(needle)
const decimalPoints = (row: string) =>
  [...row.matchAll(/\$\d+\./gu)].map(
    (match) => match.index + match[0].length - 1,
  )

describe("Pi picker formatting", () => {
  test("keeps published precision and distinguishes unknown from free", () => {
    expect(formatUsd(5)).toBe("$5.00")
    expect(formatUsd(0.125)).toBe("$0.125")
    expect(formatUsd(0.0015)).toBe("$0.0015")
    expect(formatUsd(undefined)).toBe("—")
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    expect(price({ ...models[2], cost: zero }, "input")).toBe("—")
    expect(
      price({ ...models[2], cost: { ...zero, known: true } }, "input"),
    ).toBe("$0.00")
    expect(
      price({ ...models[1], cost: { ...tiered, known: false } }, "input"),
    ).toBe("—")
    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        knownCost({
          ...models[2],
          cost: { ...zero, output: invalid, known: true },
        }),
      ).toBe(false)
    }
    expect(formatTokens(1_000_000)).toBe("1M")
    expect(formatTokens(1_050_000)).toBe("1.05M")
    expect(formatTokens(400_000)).toBe("400K")
  })
})

describe("Pi picker table", () => {
  test("renders a header, rule and readable names, highlighting only the active row", () => {
    const rows = renderPicker(view(), 120, style)
    expect(rows[0]).toMatch(/Model\s+Provider\s+Context\s+Input\s+Output/u)
    expect(rows[1]).toMatch(/^─+$/u)
    const active = rows.filter((row) => row.startsWith("<"))
    expect(active).toHaveLength(1)
    expect(active[0]?.startsWith("<  Claude Haiku 5.5")).toBe(true)
    expect(rows.join("\n")).not.toContain("›")
    expect(active[0]).toContain("Claude Haiku 5.5")
    // One status mark (current) in the gutter; default is a quiet word after the name.
    expect(rows.find((row) => row.includes("Claude Opus 5.5"))).toContain(
      "✓ Claude Opus 5.5  default   maximal",
    )
    expect(rows.join("\n")).not.toContain("★")
    expect(rows.join("\n")).not.toContain("claude-opus-5.5")
  })

  test("aligns prices on the decimal point; * never shifts digits", () => {
    const rows = renderPicker(view(), 120, style)
    const haiku = (
      rows.find((row) => row.includes("Claude Haiku")) ?? ""
    ).slice(1)
    const opus = rows.find((row) => row.includes("Claude Opus")) ?? ""
    const mystery = rows.find((row) => row.includes("mystery")) ?? ""
    // Every price column shares its decimal-point position across rows, even with
    // a trailing "*" ("$0.10*" vs "$4.00") or extra precision ("$0.125*" vs "$5.00").
    expect(decimalPoints(haiku)).toHaveLength(4)
    expect(decimalPoints(haiku)).toEqual(decimalPoints(opus))
    // Header right edge matches the last integer+fraction digit of its column.
    const header = rows[0] ?? ""
    expect(columnOf(header, "Input") + "Input".length).toBe(
      columnOf(opus, "$4.00") + 5,
    )
    // Unknown prices render a dash, not $0.00.
    expect(mystery).toContain("—")
    expect(mystery).not.toContain("$0.00")
  })

  test("sizes the model column to the longest name, not the terminal width", () => {
    const wide = renderPicker(view(), 200, style)
    const narrowerTable = renderPicker(view(), 120, style)
    const header = wide[0] ?? ""
    expect(columnOf(header, "Provider") - columnOf(header, "Model")).toBe(
      "Claude Opus 5.5  default".length + 3,
    )
    expect(header.trimEnd()).toBe((narrowerTable[0] ?? "").trimEnd())
  })

  test("shows long names in full when there is room, clipping only narrow terminals", () => {
    const names = [
      ...Array.from({ length: 9 }, (_, i) => `Model ${i}`),
      "Model 9 Fast (Internal only)",
    ]
    const list = names.map((name, i) => ({ ...models[1], id: `m${i}`, name }))
    expect(nameWidth(list, style)).toBe("Model 9 Fast (Internal only)".length)
    const wide = renderPicker(
      view({ models: list, selectedIndex: 9 }),
      160,
      style,
    )
    expect(wide.find((row) => row.startsWith("<"))).toContain(
      "Model 9 Fast (Internal only)   maximal",
    )
    // Narrow: the clipped name stays inside one unbroken selection highlight.
    const narrow = renderPicker(
      view({ models: list, selectedIndex: 9 }),
      40,
      style,
    )
    const active = narrow.find((row) => row.startsWith("<")) ?? ""
    expect(active).toMatch(/Model 9 Fast \S*…/u)
    expect(active.endsWith(">")).toBe(true)
    expect(plainWidth(active)).toBe(40)
    // The full name is still available in the details panel.
    expect(narrow.join("\n")).toContain("Model 9 Fast (Internal only)")
  })

  test("keeps the default tag when a narrow column shortens the name", () => {
    const rows = renderPicker(view(), 40, style)
    const opus = rows.find((row) => row.includes("default")) ?? ""
    expect(opus).toMatch(/✓ Claude O\S*…\s+default/u)
    const details = renderPicker(view({ selectedIndex: 1 }), 120, style).join(
      "\n",
    )
    expect(details).toContain(
      "maximal/claude-opus-5.5   current · default for new sessions",
    )
  })

  test("fits every width, dropping secondary columns before prices", () => {
    for (const width of [0, 1, 10, 24, 32, 40, 60, 79, 80, 100, 160, 240]) {
      for (const row of renderPicker(view(), width, style))
        expect(plainWidth(row)).toBeLessThanOrEqual(width + 0)
    }
    const narrow = renderPicker(view(), 44, style)
    expect(narrow[0]).toContain("Input")
    expect(narrow[0]).not.toContain("Provider")
    expect(narrow.join("\n")).toContain("$0.10*")
  })

  test("shows a structured detail table with tier bands for the selection", () => {
    const text = renderPicker(view(), 120, style).join("\n")
    expect(text).toContain("maximal/claude-haiku-5.5")
    expect(text).toContain("1M context · 128K max output · reasoning · images")
    expect(text).toMatch(
      /Up to 100K input\s+\$0\.10\s+\$0\.50\s+\$0\.01\s+\$0\.125/u,
    )
    expect(text).toMatch(
      /Above 100K input\s+\$0\.50\s+\$2\.50\s+\$0\.05\s+\$0\.625/u,
    )
    const unknown = renderPicker(view({ selectedIndex: 2 }), 120, style).join(
      "\n",
    )
    expect(unknown).toContain("Pricing unknown for this model (not free)")
  })

  test("keeps the dialog height stable as the selection moves between models", () => {
    // Haiku has a long-context tier row, Opus none, "mystery" no prices at all.
    const heights = [0, 1, 2].map(
      (selectedIndex) =>
        renderPicker(view({ selectedIndex }), 120, style).length,
    )
    expect(new Set(heights).size).toBe(1)
    const narrow = [0, 1, 2].map(
      (selectedIndex) =>
        renderPicker(view({ selectedIndex }), 40, style).length,
    )
    expect(new Set(narrow).size).toBe(1)
  })

  test("keeps native scroll window, empty, error and refresh states", () => {
    const many = Array.from({ length: 22 }, (_, i) => ({
      ...models[1],
      id: `m${i}`,
      name: `Model ${i}`,
    }))
    const rows = renderPicker(
      view({ models: many, selectedIndex: 20 }),
      120,
      style,
    )
    expect(rows[2]).toContain("Model 12")
    expect(rows.find((row) => row.startsWith("<"))).toContain("Model 20")
    expect(rows).toContain("  13–22 of 22")
    const empty = renderPicker(view({ models: [] }), 80, style)
    expect(empty.join("\n")).toContain("No matching models")
    const failed = renderPicker(
      view({
        errorMessage: "Could not refresh maximal; showing cached models.",
      }),
      100,
      style,
    ).join("\n")
    expect(failed).toContain("Could not refresh maximal")
    expect(failed).not.toContain("Up to 100K input")
    const refreshed = renderPicker(
      view({
        refreshMessage: "Model catalogs refreshed.",
        refreshSucceeded: true,
      }),
      100,
      style,
    )
    expect(refreshed.at(-1)).toContain("Model catalogs refreshed.")
  })
})

// A fresh class per test: never mutate Pi globals or use leaking mock.module().
const otherRenderer = () => {}
const textComponent = (line: string) => ({
  render: (_width: number) => [line],
  invalidate() {},
})
function fixture() {
  const items = models.map((model) => ({ model }))
  return class Selector {
    filteredModels = [...items]
    selectedIndex = 1
    currentModel = models[1]
    errorMessage: string | undefined = undefined
    refreshStatusMessage = "Refreshing model catalogs…"
    refreshStatusSuccess = false
    listContainer = { children: [textComponent("native")] }
    isDefaultModel = (model: PickerModel) => model.id === "claude-opus-5.5"
    updateList() {
      this.listContainer.children = [textComponent("native row")]
    }
  }
}

describe("Pi picker adapter", () => {
  test("replaces only the list area and restores ownership-checked", () => {
    const Selector = fixture()
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = Selector.prototype.updateList
    const undo = installPickerRenderer(Selector.prototype, style)
    const picker = new Selector()
    picker.updateList()
    expect(picker.listContainer.children).toHaveLength(1)
    const text = picker.listContainer.children.flatMap((child) =>
      child.render(120),
    )
    expect(text).not.toContain("native row")
    expect(text.find((row) => row.startsWith("<"))).toContain("Claude Opus 5.5")
    expect(text.at(-1)).toContain("Refreshing model catalogs")
    undo()
    undo()
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(Selector.prototype.updateList).toBe(original)
  })

  test("keeps the native list when private state has an unexpected shape", () => {
    const Selector = fixture()
    const undo = installPickerRenderer(Selector.prototype, style)
    const picker = new Selector()
    Object.assign(picker, { refreshStatusMessage: 42 })
    picker.updateList()
    expect(
      picker.listContainer.children.flatMap((child) => child.render(80)),
    ).toEqual(["native row"])
    undo()
  })

  test("does not overwrite another extension's renderer on teardown", () => {
    const Selector = fixture()
    const undo = installPickerRenderer(Selector.prototype, style)
    Selector.prototype.updateList = otherRenderer
    undo()
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(Selector.prototype.updateList).toBe(otherRenderer)
    expect(() => installPickerRenderer({}, style)).toThrow(
      "expected model picker",
    )
  })
})
