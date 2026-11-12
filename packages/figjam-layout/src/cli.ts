// CLI: bun src/cli.ts <fetch|convert|plan|map|build|overlay> [...]
//   fetch   <pageId> [out.json]               read-only: board_tree (+style) of a page → normalized Layout JSON
//   convert <board_tree.json> <out.json> [ref.json]  offline: cached board_tree → Layout (edge kinds from ref)
//   plan    <layout.json> [outDir]            run every strategy offline, score, write SVG/PNG previews + plan.json
//   map     <layout.json> [outDir] [--policy A|B]  run only the recommended pipeline (planMap): SVG/PNG + plan.json
//   build   <plan.json> <strategy> [pageId]   recreate the page content with that strategy on a page we own
//   overlay <plan.json> <strategy> <pageId> <board_tree.json>  hide existing connectors, add routed edges
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { bus } from "./bus"
import { classify, suggestMoves } from "./classify"
import { tool as callTool } from "./client"
import { baseline, magnets, reflow, route } from "./engine"
import { checks, HARD_CHECKS, lanes, titleRect } from "./lanes"
import {
  must,
  score,
  type Edge,
  type EdgeKind,
  type EdgeStyle,
  type Layout,
  type Node,
  type Rect,
  type Section,
  type ShapeStyle,
} from "./model"
import { planMap } from "./pipeline"
import { toSvg } from "./svg"
import { bridgeToken } from "./token"

// The bridge call every tool request goes through, with the operator's opt-in token (token.ts).
const tool = (name: string, input: Record<string, unknown>) =>
  callTool(name, input, { token: bridgeToken() })

// ---- board_tree, as the bridge returns it (figjam-plugin `board_tree`: treeNode / edgeOut) ----

export type TreeNode = {
  id: string
  type: string
  name: string
  rev?: unknown
  role?: string
  bounds?: Rect
  text?: string
  style?: ShapeStyle
  children?: Array<TreeNode>
}
// Floating ends have no from/to. Edges carry no style today; lineType/style are read when present.
export type TreeEdge = {
  id: string
  rev?: unknown
  from?: string
  to?: string
  fromMagnet?: string
  toMagnet?: string
  label?: string
  lineType?: string
  style?: EdgeStyle
}
export type BoardTree = { root: TreeNode; edges: Array<TreeEdge> }

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const optString = (o: Json, k: string) =>
  o[k] === undefined || typeof o[k] === "string"
const optNumber = (o: Json, k: string) =>
  o[k] === undefined || typeof o[k] === "number"
const optNumbers = (o: Json, k: string) => {
  const v = o[k]
  return (
    v === undefined
    || (Array.isArray(v) && v.every((x) => typeof x === "number"))
  )
}
const isRect = (v: unknown): v is Rect =>
  isRecord(v)
  && typeof v.x === "number"
  && typeof v.y === "number"
  && typeof v.w === "number"
  && typeof v.h === "number"

const isShapeStyle = (v: unknown): v is ShapeStyle =>
  isRecord(v)
  && ["color", "fill", "shape"].every((k) => optString(v, k))
  && optNumber(v, "fontSize")
const isEdgeStyle = (v: unknown): v is EdgeStyle =>
  isRecord(v)
  && optNumbers(v, "dashPattern")
  && optNumbers(v, "dashes")
  && optNumber(v, "strokeWeight")
  && optString(v, "lineType")

function isTreeNode(v: unknown): v is TreeNode {
  return (
    isRecord(v)
    && typeof v.id === "string"
    && typeof v.type === "string"
    && typeof v.name === "string"
    && optString(v, "role")
    && optString(v, "text")
    && (v.bounds === undefined || isRect(v.bounds))
    && (v.style === undefined || isShapeStyle(v.style))
    && (v.children === undefined
      || (Array.isArray(v.children) && v.children.every((c) => isTreeNode(c))))
  )
}
const isTreeEdge = (v: unknown): v is TreeEdge =>
  isRecord(v)
  && typeof v.id === "string"
  && ["from", "to", "fromMagnet", "toMagnet", "label", "lineType"].every((k) =>
    optString(v, k),
  )
  && (v.style === undefined || isEdgeStyle(v.style))

// Narrows an untrusted board_tree result (from the bridge or a cached file); throws on anything else.
export function parseBoardTree(raw: unknown): BoardTree {
  if (!isRecord(raw) || !isTreeNode(raw.root))
    throw new Error(
      "board_tree: expected { root: node, edges? } with id/type/name on every node",
    )
  const edges = raw.edges ?? []
  if (!Array.isArray(edges) || !edges.every((e) => isTreeEdge(e)))
    throw new Error(
      "board_tree: expected edges to be a list of { id, from?, to?, ... }",
    )
  return { root: raw.root, edges }
}

// ---- board_tree → Layout ----

function kindOf(style: EdgeStyle | undefined): EdgeKind {
  const dash: Array<number> = style?.dashPattern ?? style?.dashes ?? []
  const w = style?.strokeWeight ?? 2
  if (w >= 5) return "loop"
  if (dash.length > 0 && dash[0] <= 3) return "verify"
  if (dash.length > 0) return "flow"
  return "dep"
}

export async function fetchLayout(pageId?: string): Promise<Layout> {
  return fromTree(
    await tool("board_tree", {
      pageId,
      include: ["text", "geometry", "style"],
      limit: 2000,
      depth: 4,
    }),
  )
}

const LEGEND = /how to read|legend/i
const OBSTACLE_TYPES = new Set([
  "CODE_BLOCK",
  "EMBED",
  "LINK_UNFURL",
  "SHAPE_WITH_TEXT",
  "STICKY",
  "TABLE",
])
type Collected = {
  sections: Array<Section>
  nodes: Array<Node>
  blocks: Array<Rect> // areas edges must avoid entirely (legend)
}

// card styles: board_tree reports camelCase palette names ("lightGreen")
function paletteName(style: ShapeStyle | undefined) {
  if (style?.color)
    style.color = style.color
      .replaceAll(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
}

function walk(n: TreeNode, acc: Collected, sectionId?: string): void {
  const kids = n.children ?? []
  if (n.type === "SECTION") {
    const rect = must(n.bounds, `bounds of section ${n.id}`)
    if (LEGEND.test(n.name)) {
      acc.blocks.push(rect)
      return
    }
    acc.sections.push({ id: n.id, name: n.name, rect, style: n.style })
    for (const c of kids) walk(c, acc, n.id)
    return
  }
  if (n.type === "PAGE" || n.role === "page") {
    for (const c of kids) walk(c, acc, sectionId)
    return
  }
  if (!n.bounds) return
  paletteName(n.style)
  acc.nodes.push({
    id: n.id,
    section: sectionId,
    rect: n.bounds,
    type: n.type,
    role: n.role,
    text: n.text,
    style: n.style,
    obstacle: OBSTACLE_TYPES.has(n.type),
  })
  for (const c of kids) walk(c, acc, sectionId)
}

// board_tree edges carry no style, so edge kinds come from a reference layout (same ids) when given.
// Sections named like a legend are left out of layout and routing.
export function fromTree(tree: unknown, ref?: Layout): Layout {
  const { root, edges: treeEdges } = parseBoardTree(tree)
  const acc: Collected = { sections: [], nodes: [], blocks: [] }
  walk(root, acc)
  const have = new Set(acc.nodes.map((n) => n.id))
  const refEdge = new Map(
    (ref?.edges ?? []).map((e) => [`${e.from}>${e.to}`, e]),
  )
  const edges: Array<Edge> = treeEdges
    .filter(
      (e): e is TreeEdge & { from: string; to: string } =>
        e.from !== undefined
        && e.to !== undefined
        && have.has(e.from)
        && have.has(e.to),
    )
    .map((e) => {
      const r = refEdge.get(`${e.from}>${e.to}`)
      return {
        id: e.id,
        from: e.from,
        to: e.to,
        kind: r?.kind ?? kindOf(e.style),
        label: e.label ?? r?.label,
        fromMagnet: e.fromMagnet,
        toMagnet: e.toMagnet,
        lineType: e.lineType ?? e.style?.lineType ?? r?.lineType,
        style: e.style,
      }
    })
  return {
    name: "original",
    sections: acc.sections,
    nodes: acc.nodes,
    edges,
    routes: [],
    blocks: acc.blocks,
  }
}

// ---- JSON files ----

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"))
}

const isLayout = (v: unknown): v is Layout =>
  isRecord(v)
  && typeof v.name === "string"
  && ["sections", "nodes", "edges", "routes"].every((k) => Array.isArray(v[k]))

function readLayout(path: string): Layout {
  const L = readJson(path)
  if (!isLayout(L))
    throw new Error(
      `${path}: not a Layout (name, sections, nodes, edges, routes)`,
    )
  return L
}

// A candidate from a plan.json written by `plan` or `map`.
function readCandidate(planPath: string, name: string | undefined): Layout {
  const P = readJson(planPath)
  const cands = isRecord(P) && Array.isArray(P.candidates) ? P.candidates : []
  const L: unknown = cands.find((x) => isRecord(x) && x.name === name)
  if (!isLayout(L)) throw new Error(`no candidate ${name}`)
  return L
}

// ---- plan / map ----

function png(svgPath: string): string | undefined {
  const out = svgPath.replace(/\.svg$/, ".png")
  try {
    execFileSync("rsvg-convert", ["-w", "2000", "-o", out, svgPath])
    return out
  } catch {
    return undefined
  }
}

// Writes each candidate's preview and plan.json, then prints the scores and self-checks.
function writePlan(outDir: string, cands: Array<Layout>) {
  const rows = cands.map((c) => {
    const svg = join(outDir, `${c.name}.svg`)
    writeFileSync(svg, toSvg(c))
    return { strategy: c.name, ...score(c), preview: png(svg) ?? svg }
  })
  writeFileSync(
    join(outDir, "plan.json"),
    JSON.stringify({ candidates: cands, metrics: rows }, null, 1),
  )
  console.table(rows.map(({ preview: _preview, ...r }) => r))
  for (const c of cands) {
    const ck =
      c.checks
      ?? checks(
        c,
        c.sections.map((s) => titleRect(s)),
      )
    console.log(c.name.padEnd(18), "self-checks", JSON.stringify(ck))
  }
  return rows
}

// lanes: a few router settings; keep the one with no hard violations and the fewest crossings
async function bestLanes(L: Layout): Promise<Layout> {
  const tries: Array<Layout> = []
  for (const [cross, passes, bend] of [
    [100, 2, 6],
    [50, 1, 6],
    [50, 2, 10],
    [80, 3, 8],
    [150, 2, 6],
  ])
    tries.push(await lanes(L, { cross, passes, bend }))
  const ck = (c: Layout) => must(c.checks, `checks of ${c.name}`)
  const bad = (c: Layout) =>
    HARD_CHECKS.reduce((s, k) => s + (ck(c)[k] ?? 0), 0)
  tries.sort(
    (a, b) =>
      bad(a) - bad(b)
      || ck(a).laneSwapsInSections - ck(b).laneSwapsInSections
      || ck(a).crossings - ck(b).crossings,
  )
  tries[0].name = "lanes-v1"
  return tries[0]
}

export async function plan(L: Layout, outDir: string) {
  mkdirSync(outDir, { recursive: true })
  const cands: Array<Layout> = [baseline(L), magnets(L)]
  const rf = await reflow(L)
  cands.push(rf.native, rf.drawn)
  const rd = await reflow(L, { direction: "DOWN" })
  rd.native.name = "reflow-down"
  cands.push(
    rd.native,
    await route(L),
    await bus(L),
    await bus(L, { intra: "native" }),
    await bus(L, { intra: "routed" }),
    await bus(L, { intra: "cards" }),
    await bus(L, { walls: false, name: "bus-nowalls" }),
    await bus(L, { walls: false, intra: "cards", name: "bus-nowalls-cards" }),
    await bus(L, { drawAll: true, name: "bus-drawn" }),
    await bestLanes(L),
    // the full pipeline: global routing → name tags → detailed lanes → pills
    await planMap(L),
  )
  const groups = classify(L)
  const sug = suggestMoves(L, groups)
  writeFileSync(
    join(outDir, "classification.json"),
    JSON.stringify({ groups, moves: sug.moves }, null, 1),
  )
  const rows = writePlan(outDir, cands)
  return { cands, rows }
}

// Only the recommended pipeline; plan.json has the same shape as `plan`'s, so `build` reads it.
export async function runMap(L: Layout, outDir: string, policy?: "A" | "B") {
  mkdirSync(outDir, { recursive: true })
  const R = await planMap(L, { policy })
  const rows = writePlan(outDir, [R])
  return { cands: [R], rows }
}

// ---- main ----

const USAGE = [
  "usage: bun src/cli.ts",
  "  fetch <pageId> [out.json]",
  "  convert <board_tree.json> <out.json> [ref.json]",
  "  plan <layout.json> [outDir]",
  "  map <layout.json> [outDir] [--policy A|B]",
  "  build <plan.json> <strategy> [pageId]",
  "  overlay <plan.json> <strategy> <pageId> <board_tree.json>",
].join("\n")

function required(v: string | undefined, what: string): string {
  if (v === undefined) throw new Error(`missing ${what}\n${USAGE}`)
  return v
}

// Splits `--policy A|B` out of the arguments; the rest are positional.
const isPolicy = (p: string | undefined): p is "A" | "B" =>
  p === "A" || p === "B"
function parseArgs(argv: Array<string>): {
  pos: Array<string | undefined>
  policy: "A" | "B" | undefined
} {
  const i = argv.indexOf("--policy")
  const all: Array<string | undefined> = argv
  if (i === -1) return { pos: all, policy: undefined }
  const p = argv[i + 1]
  if (!isPolicy(p)) throw new Error(`--policy takes A or B\n${USAGE}`)
  const pos: Array<string | undefined> = argv.filter(
    (_, j) => j !== i && j !== i + 1,
  )
  return { pos, policy: p }
}

function summary(L: Layout) {
  console.log(
    `${L.sections.length} sections, ${L.nodes.length} nodes, ${L.edges.length} edges`,
  )
}

async function main() {
  const { pos, policy } = parseArgs(process.argv.slice(2))
  const [cmd, a, b, c, d] = pos
  switch (cmd) {
    case "fetch": {
      const L = await fetchLayout(a)
      writeFileSync(b ?? "layout.json", JSON.stringify(L, null, 1))
      summary(L)
      break
    }
    case "convert": {
      // offline: cached board_tree JSON (+ reference layout for edge kinds) → Layout
      const ref = c === undefined ? undefined : readLayout(c)
      const L = fromTree(readJson(required(a, "board_tree.json")), ref)
      writeFileSync(required(b, "out.json"), JSON.stringify(L, null, 1))
      summary(L)
      break
    }
    case "plan": {
      await plan(readLayout(required(a, "layout.json")), b ?? "out")
      break
    }
    case "map": {
      await runMap(
        readLayout(required(a, "layout.json")),
        b ?? "out/map",
        policy,
      )
      break
    }
    case "build": {
      const { build } = await import("./build")
      await build(readCandidate(required(a, "plan.json"), b), c)
      break
    }
    case "overlay": {
      const { overlay } = await import("./build")
      const L = readCandidate(required(a, "plan.json"), b)
      const tree = parseBoardTree(readJson(required(d, "board_tree.json")))
      await overlay(L, { pageId: required(c, "pageId"), tree })
      break
    }
    default: {
      console.log(USAGE)
    }
  }
}
if (import.meta.main) {
  await main()
  process.exit(0)
}
