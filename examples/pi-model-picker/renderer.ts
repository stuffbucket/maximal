/** Display-only adapter for Pi 1.5.x's exported ModelSelectorComponent.
 * Selection, filtering, scoped models, defaults and catalog refresh stay native;
 * only the list area below the search box is re-rendered as a table.
 */
export interface Rates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface PickerModel {
  id: string
  name?: string
  provider: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: ReadonlyArray<string>
  cost?: Rates & {
    known?: boolean
    tiers?: ReadonlyArray<Partial<Rates> & { inputTokensAbove: number }>
  }
}

export type Token =
  | "text"
  | "accent"
  | "muted"
  | "dim"
  | "borderMuted"
  | "success"
  | "warning"
  | "error"

/** Host terminal primitives; the extension passes Pi's live theme and width helpers. */
export interface Style {
  fg: (token: Token, text: string) => string
  selected: (text: string) => string
  bold: (text: string) => string
  truncate: (text: string, width: number) => string
  measure: (text: string) => number
}

export interface PickerView {
  models: ReadonlyArray<PickerModel>
  selectedIndex: number
  isCurrent: (model: PickerModel) => boolean
  isDefault: (model: PickerModel) => boolean
  errorMessage?: string
  refreshMessage?: string
  refreshSucceeded?: boolean
}

interface Selector {
  filteredModels: Array<{ model: PickerModel }>
  selectedIndex: number
  currentModel?: PickerModel
  listContainer?: { children: Array<Component> }
  isDefaultModel: (model: PickerModel) => boolean
  errorMessage?: unknown
  refreshStatusMessage?: unknown
  refreshStatusSuccess?: unknown
}

interface Component {
  render: (width: number) => Array<string>
  invalidate: () => void
}

type Segment = [text: string, token: Token]
type Align = "left" | "right"

/** Pi's native window size: keep scrolling identical to the built-in picker. */
const MAX_VISIBLE = 10
const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const
type RateKey = (typeof RATE_KEYS)[number]
const MAX_NAME_WIDTH = 44
const MIN_NAME_WIDTH = 12

export function knownCost(model: PickerModel): boolean {
  const cost = model.cost
  if (!cost || cost.known === false) return false
  const rates = RATE_KEYS.map((key) => cost[key])
  return (
    rates.every((value) => Number.isFinite(value) && value >= 0)
    && (cost.known === true || rates.some((value) => value > 0))
  )
}

/** "$5.00", "$0.125", "$0.0015": at least cents, never rounds away a published rate. */
export function formatUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—"
  const fixed = value.toFixed(4).replace(/0{1,2}$/u, "")
  return `$${fixed}`
}

export function price(model: PickerModel, key: RateKey): string {
  return knownCost(model) ? formatUsd(model.cost?.[key]) : "—"
}

export function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "—"
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`
  return `${Math.round(value / 1000)}K`
}

function hasTiers(model: PickerModel): boolean {
  return knownCost(model) && (model.cost?.tiers?.length ?? 0) > 0
}

function modelName(model: PickerModel): string {
  return model.name?.trim() || model.id
}

/** Decimal-point alignment so "$0.125" and "$12.00" line up on the point,
 * with the long-context "*" in trailing space instead of shifting digits. */
class DecimalColumn implements Column {
  private readonly intWidth: number
  private readonly fracWidth: number
  private readonly marker: boolean
  constructor(
    private readonly title: string,
    private readonly values: ReadonlyArray<{ text: string; tier: boolean }>,
  ) {
    const parts = values.map(({ text }) => split(text))
    this.fracWidth = Math.max(0, ...parts.map(([, frac]) => frac.length))
    this.intWidth = Math.max(
      1,
      title.length - this.fracWidth,
      ...parts.map(([int]) => int.length),
    )
    this.marker = values.some(({ tier }) => tier)
  }

  get width(): number {
    return this.intWidth + this.fracWidth + (this.marker ? 1 : 0)
  }

  header(): string {
    return this.title
      .padStart(this.intWidth + this.fracWidth)
      .padEnd(this.width)
  }

  cell(_model: PickerModel, index: number): Array<Segment> {
    const value = this.values.at(index)
    if (!value) return [[" ".repeat(this.width), "dim"]]
    if (value.text === "—")
      return [
        [
          "—".padStart(this.intWidth + this.fracWidth).padEnd(this.width),
          "dim",
        ],
      ]
    // Digits align on the decimal point; the tier marker hugs the last digit and
    // only occupies trailing padding, so it never pushes the number sideways.
    const [int, frac] = split(value.text)
    const number = int.padStart(this.intWidth) + frac
    const marker = value.tier ? "*" : ""
    return [
      [number, "text"],
      [marker, "warning"],
      [" ".repeat(this.width - number.length - marker.length), "dim"],
    ]
  }
}

function split(text: string): [string, string] {
  const dot = text.indexOf(".")
  return dot === -1 ? [text, ""] : [text.slice(0, dot), text.slice(dot)]
}

interface Column {
  readonly width: number
  header: () => string
  cell: (model: PickerModel, index: number) => Array<Segment>
}

class TextColumn implements Column {
  readonly width: number
  constructor(
    private readonly title: string,
    private readonly spec: {
      width: number
      value: (model: PickerModel) => [string, Token]
      align?: Align
    },
  ) {
    this.width = spec.width
  }

  header(): string {
    return justify(this.title, this.width, this.spec.align ?? "left")
  }

  cell(model: PickerModel): Array<Segment> {
    const [text, token] = this.spec.value(model)
    return [[justify(text, this.width, this.spec.align ?? "left"), token]]
  }
}

/** Plain-text justification for already width-checked ASCII-ish cells. */
function justify(text: string, width: number, align: Align): string {
  return align === "right" ? text.padStart(width) : text.padEnd(width)
}

const GAP = "  "
const NAME_GAP = "   "
// Current mark and a space: names start in column 2, under the search text
// after Pi's "> " prompt. The selection is shown by the row highlight alone.
const GUTTER = 2
const DEFAULT_TAG = "  default"

interface Layout {
  name: number
  columns: Array<Column>
}

const gapBefore = (index: number) => (index === 0 ? NAME_GAP : GAP)

function rowWidth(layout: Layout): number {
  return layout.columns.reduce(
    (sum, column, index) => sum + gapBefore(index).length + column.width,
    GUTTER + layout.name,
  )
}

function rateColumns(
  models: ReadonlyArray<PickerModel>,
  titles: Record<RateKey, string>,
): Record<RateKey, DecimalColumn> {
  const tier = models.map((model) => hasTiers(model))
  const make = (key: RateKey) =>
    new DecimalColumn(
      titles[key],
      models.map((model, index) => ({
        text: price(model, key),
        tier: tier[index] ?? false,
      })),
    )
  return {
    input: make("input"),
    output: make("output"),
    cacheRead: make("cacheRead"),
    cacheWrite: make("cacheWrite"),
  }
}

/** Width of the longest name (and the default model's tag), so no name is clipped
 * when there is room. Narrow terminals shorten it later in layoutFor; clipped
 * names end in "…" and appear in full in the details panel. */
export function nameWidth(
  models: ReadonlyArray<PickerModel>,
  style: Pick<Style, "measure">,
  isDefault: (model: PickerModel) => boolean = () => false,
): number {
  const widths = models.map((model) => style.measure(modelName(model)))
  // The default model's dim tag fits too, so it is never truncated away.
  const tagged = models
    .filter((model) => isDefault(model))
    .map((model) => style.measure(modelName(model) + DEFAULT_TAG))
  return Math.min(
    MAX_NAME_WIDTH,
    Math.max("Model".length, ...widths, ...tagged),
  )
}

/** Natural column widths: the model column ends just after the longest name, so
 * prices sit next to names on wide terminals instead of at the far edge. */
function layoutFor(view: PickerView, width: number, style: Style): Layout {
  const models = view.models
  const providerWidth = Math.max(
    "Provider".length,
    ...models.map((model) => style.measure(model.provider)),
  )
  const rates = rateColumns(models, {
    input: "Input",
    output: "Output",
    cacheRead: "Cache rd",
    cacheWrite: "Cache wr",
  })
  const provider = new TextColumn("Provider", {
    width: providerWidth,
    value: (model) => [model.provider, "dim"],
  })
  const context = new TextColumn("Context", {
    width: 7,
    value: (model) => [formatTokens(model.contextWindow), "muted"],
    align: "right",
  })
  const natural = nameWidth(models, style, view.isDefault)
  const layout: Layout = {
    name: natural,
    columns: [
      provider,
      context,
      rates.input,
      rates.output,
      rates.cacheRead,
      rates.cacheWrite,
    ],
  }
  // Drop the least important columns first, then shrink names, then prices.
  for (const drop of [rates.cacheWrite, rates.cacheRead, provider, context]) {
    if (rowWidth(layout) <= width) return layout
    layout.columns = layout.columns.filter((column) => column !== drop)
  }
  const overflow = rowWidth(layout) - width
  if (overflow > 0) layout.name = Math.max(MIN_NAME_WIDTH, natural - overflow)
  while (rowWidth(layout) > width && layout.columns.length > 0)
    layout.columns.pop()
  if (rowWidth(layout) > width) layout.name = Math.max(1, width - GUTTER)
  return layout
}

/** Width-aware painting for one render pass. */
class Painter {
  constructor(
    private readonly style: Style,
    readonly width: number,
  ) {}

  measure(text: string): number {
    return this.style.measure(text)
  }

  /** Pad or shorten plain text to exactly `width` cells. Done here rather than
   * with the host's truncate, which appends a full SGR reset before its ellipsis
   * and would cut the selected row's background short. */
  clip(text: string, width: number): string {
    if (width <= 0) return ""
    if (this.measure(text) <= width)
      return text + " ".repeat(width - this.measure(text))
    let out = ""
    for (const char of text) {
      if (this.measure(out + char) > width - 1) break
      out += char
    }
    out += "…"
    return out + " ".repeat(Math.max(0, width - this.measure(out)))
  }

  text(text: string, token: Token): string {
    return this.style.fg(token, this.style.truncate(text, this.width))
  }

  rule(width: number): string {
    return this.style.fg("borderMuted", "─".repeat(Math.min(this.width, width)))
  }

  bold(text: string, token: Token): string {
    return this.style.bold(this.style.fg(token, text))
  }

  raw(text: string): string {
    return this.style.truncate(text, this.width)
  }

  line(segments: ReadonlyArray<Segment>, selected = false): string {
    const used = segments.reduce((sum, [text]) => sum + this.measure(text), 0)
    const fill = " ".repeat(Math.max(0, this.width - used))
    // Selected rows: dim text is lifted to muted for contrast on the highlight.
    const body = segments
      .map(([text, token]) =>
        this.style.fg(selected && token === "dim" ? "muted" : token, text),
      )
      .join("")
    // Foreground tokens reset only the foreground, so a full-width selection
    // background survives the inner colour changes.
    return this.style.truncate(
      selected ? this.style.selected(body + fill) : body + fill,
      this.width,
    )
  }
}

function headerRow(layout: Layout, paint: Painter): string {
  return paint.line([
    [" ".repeat(GUTTER) + paint.clip("Model", layout.name), "dim"],
    ...layout.columns.map(
      (column, index): Segment => [gapBefore(index) + column.header(), "dim"],
    ),
  ])
}

/** Name plus, for the default model, a quiet "default" tag right after it;
 * together exactly `width` cells. */
function nameCell(
  model: PickerModel,
  width: number,
  context: { view: PickerView; paint: Painter },
): [label: string, tag: string] {
  const { view, paint } = context
  const name = modelName(model)
  const tag = view.isDefault(model) ? DEFAULT_TAG : ""
  if (!tag || width - tag.length < MIN_NAME_WIDTH / 2)
    return [paint.clip(name, width), ""]
  const label = paint.clip(
    name,
    Math.min(width - tag.length, paint.measure(name)),
  )
  return [label, paint.clip(tag, width - paint.measure(label))]
}

function modelRow(
  model: PickerModel,
  index: number,
  context: { view: PickerView; layout: Layout; paint: Painter },
): string {
  const { view, layout, paint } = context
  const selected = index === view.selectedIndex
  const [label, tag] = nameCell(model, layout.name, { view, paint })
  const segments: Array<Segment> = [
    [view.isCurrent(model) ? "✓" : " ", "success"],
    [" ", "dim"],
    // Bold keeps the active row distinct even if the highlight is faint.
    selected ? [paint.bold(label, "accent"), "accent"] : [label, "text"],
    [tag, "dim"],
  ]
  for (const [i, column] of layout.columns.entries())
    segments.push([gapBefore(i), "dim"], ...column.cell(model, index))
  return paint.line(segments, selected)
}

function tableRows(
  view: PickerView,
  paint: Painter,
  style: Style,
): Array<string> {
  const layout = layoutFor(view, paint.width, style)
  const rows = [headerRow(layout, paint), paint.rule(rowWidth(layout))]
  if (view.models.length === 0)
    return [
      ...rows,
      paint.line([[" ".repeat(GUTTER) + "No matching models", "muted"]]),
    ]
  const start = Math.max(
    0,
    Math.min(
      view.selectedIndex - Math.floor(MAX_VISIBLE / 2),
      view.models.length - MAX_VISIBLE,
    ),
  )
  const end = Math.min(start + MAX_VISIBLE, view.models.length)
  for (const [offset, model] of view.models.slice(start, end).entries())
    rows.push(modelRow(model, start + offset, { view, layout, paint }))
  if (start > 0 || end < view.models.length)
    rows.push(
      paint.text(`  ${start + 1}–${end} of ${view.models.length}`, "dim"),
    )
  return rows
}

function limitsOf(model: PickerModel): string {
  return [
    model.contextWindow && `${formatTokens(model.contextWindow)} context`,
    model.maxTokens && `${formatTokens(model.maxTokens)} max output`,
    model.reasoning && "reasoning",
    model.input?.includes("image") && "images",
  ]
    .filter((item): item is string => typeof item === "string")
    .join(" · ")
}

function pricingRows(model: PickerModel, paint: Painter): Array<string> {
  const cost = model.cost
  if (!cost || !knownCost(model))
    return [
      paint.text("  Pricing unknown for this model (not free)", "warning"),
    ]
  const first = cost.tiers?.[0]?.inputTokensAbove
  const bands: Array<{ label: string; rates: Partial<Rates> }> = [
    {
      label: first ? `Up to ${formatTokens(first)} input` : "All input",
      rates: cost,
    },
    ...(cost.tiers ?? []).map((tier) => ({
      label: `Above ${formatTokens(tier.inputTokensAbove)} input`,
      rates: tier,
    })),
  ]
  const title = "USD / 1M tokens"
  const labelWidth = Math.max(
    title.length,
    ...bands.map((band) => band.label.length),
  )
  const all = RATE_KEYS.map(
    (key) =>
      new DecimalColumn(
        {
          input: "Input",
          output: "Output",
          cacheRead: "Cache read",
          cacheWrite: "Cache write",
        }[key],
        bands.map((band) => ({
          text: formatUsd(band.rates[key]),
          tier: false,
        })),
      ),
  )
  const widthOf = (columns: ReadonlyArray<DecimalColumn>) =>
    2
    + labelWidth
    + columns.reduce((sum, column) => sum + GAP.length + column.width, 0)
  let shown = all
  while (shown.length > 2 && widthOf(shown) > paint.width)
    shown = shown.slice(0, -1)
  if (widthOf(shown) > paint.width)
    return [
      paint.text(
        `  Input ${price(model, "input")} · Output ${price(model, "output")} per 1M`,
        "muted",
      ),
    ]
  return [
    paint.line([
      [`  ${title.padEnd(labelWidth)}`, "dim"],
      ...shown.map((column): Segment => [GAP + column.header(), "dim"]),
    ]),
    ...bands.map((band, index) =>
      paint.line([
        [`  ${band.label.padEnd(labelWidth)}`, "muted"],
        ...shown.flatMap(
          (column): Array<Segment> => [
            [GAP, "dim"],
            ...column.cell(model, index),
          ],
        ),
      ]),
    ),
  ]
}

function detailRows(
  model: PickerModel,
  view: PickerView,
  paint: Painter,
): Array<string> {
  const limits = limitsOf(model)
  const status = [
    view.isCurrent(model) && "current",
    view.isDefault(model) && "default for new sessions",
  ].filter((item): item is string => typeof item === "string")
  return [
    paint.raw(
      `  ${paint.bold(modelName(model), "text")}${paint.text(`   ${model.provider}/${model.id}`, "dim")}${status.length > 0 ? paint.text(`   ${status.join(" · ")}`, "muted") : ""}`,
    ),
    ...(limits ? [paint.text(`  ${limits}`, "muted")] : []),
    ...pricingRows(model, paint),
  ]
}

/** Below the table: the error if refresh failed, else the selected model's details. */
function middleRows(
  view: PickerView,
  rule: string,
  paint: Painter,
): Array<string> {
  if (view.errorMessage)
    return [
      "",
      ...view.errorMessage
        .split("\n")
        .map((message) => paint.text(`  ${message}`, "error")),
    ]
  const selected = view.models.at(view.selectedIndex)
  if (!selected) return []
  // Reserve the tallest details any listed model needs (e.g. an extra
  // long-context tier row), so moving the selection never resizes the dialog
  // and the table above it doesn't jump.
  const reserve = Math.max(
    ...view.models.map((model) => detailRows(model, view, paint).length),
  )
  const details = detailRows(selected, view, paint)
  return [
    rule,
    ...details,
    ...Array.from({ length: reserve - details.length }, () => ""),
  ]
}

const LEGEND = [
  "  ✓ current  * long-context rates apply",
  "  — unknown, not free  ·  Copilot catalog estimates, not charges",
]

/** Pure renderer: the whole list area for one snapshot of native picker state. */
export function renderPicker(
  view: PickerView,
  width: number,
  style: Style,
): Array<string> {
  if (width <= 0) return []
  const paint = new Painter(style, width)
  const table = tableRows(view, paint, style)
  const details = middleRows(view, table[1] ?? "", paint)
  const oneLine = LEGEND.join("  ·")
  const legend = (paint.measure(oneLine) <= width ? [oneLine] : LEGEND).map(
    (text) => paint.text(text, "dim"),
  )
  const refresh =
    view.refreshMessage ?
      [
        paint.text(
          `  ${view.refreshMessage}`,
          view.refreshSucceeded ? "success" : "muted",
        ),
      ]
    : []
  return [...table, ...details, "", ...legend, ...refresh]
}

function component(render: Component["render"]): Component {
  return { render, invalidate() {} }
}

function viewOf(selector: Selector): PickerView | undefined {
  const {
    filteredModels,
    errorMessage,
    refreshStatusMessage,
    refreshStatusSuccess,
  } = selector
  if (
    !Array.isArray(filteredModels)
    || !Array.isArray(selector.listContainer?.children)
    || typeof selector.isDefaultModel !== "function"
    || typeof selector.selectedIndex !== "number"
    || (errorMessage !== undefined && typeof errorMessage !== "string")
    || (refreshStatusMessage !== undefined
      && typeof refreshStatusMessage !== "string")
  )
    return undefined
  const current = selector.currentModel
  return {
    models: filteredModels.map((item) => item.model),
    selectedIndex: selector.selectedIndex,
    isCurrent: (model) =>
      model.provider === current?.provider && model.id === current.id,
    isDefault: (model) => selector.isDefaultModel(model),
    errorMessage: errorMessage || undefined,
    refreshMessage: refreshStatusMessage || undefined,
    refreshSucceeded: refreshStatusSuccess === true,
  }
}

/** Returns an ownership-checked undo for /reload and session shutdown. */
export function installPickerRenderer(
  prototype: object,
  style: Style,
): () => void {
  // The host exports this class, but updateList's data layout is not public API.
  // Any shape change keeps the native list instead of guessing.
  if (
    !("updateList" in prototype)
    || typeof prototype.updateList !== "function"
  ) {
    throw new Error(
      "This Pi version does not expose the expected model picker renderer",
    )
  }
  const original = prototype.updateList
  const replacement = function (this: Selector) {
    original.call(this)
    const view = viewOf(this)
    const children = this.listContainer?.children
    if (!view || !children) return
    children.splice(
      0,
      children.length,
      component((width) => renderPicker(view, width, style)),
    )
  }
  prototype.updateList = replacement
  return () => {
    if (prototype.updateList === replacement) prototype.updateList = original
  }
}
