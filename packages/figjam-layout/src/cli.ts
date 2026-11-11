// CLI: bun src/cli.ts <fetch|plan|build> [...]
//   fetch <pageId> [out.json]          read-only: board_tree (+style) of a page → normalized Layout JSON
//   plan  <layout.json> [outDir]       run every strategy offline, score, write SVG/PNG previews + plan.json
//   build <plan.json> <strategy> [pageId]  recreate the page content with that strategy on a page we own
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tool } from "./client.ts"
import { baseline, magnets, reflow, route } from "./engine.ts"
import { bus } from "./bus.ts"
import { checks, HARD_CHECKS, lanes, titleRect } from "./lanes.ts"
import { planMap } from "./pipeline.ts"
import { classify, suggestMoves } from "./classify.ts"
import { score, type Edge, type EdgeKind, type Layout, type Node, type Rect, type Section } from "./model.ts"
import { toSvg } from "./svg.ts"

function kindOf(style: any, lineType?: string): EdgeKind {
  const dash: number[] = style?.dashPattern ?? style?.dashes ?? []
  const w = style?.strokeWeight ?? 2
  if (w >= 5) return "loop"
  if (dash.length && dash[0] <= 3) return "verify"
  if (dash.length) return "flow"
  if (lineType === "STRAIGHT" && w >= 5) return "loop"
  return "dep"
}

export async function fetchLayout(pageId: string): Promise<Layout> {
  return fromTree(await tool("board_tree", { pageId, include: ["text", "geometry", "style"], limit: 2000, depth: 4 }))
}

// board_tree edges carry no style, so edge kinds come from a reference layout (same ids) when given.
// Sections named like a legend are left out of layout and routing.
export function fromTree(tree: any, ref?: Layout): Layout {
  const sections: Section[] = []
  const nodes: Node[] = []
  const blocks: Rect[] = [] // areas edges must avoid entirely (legend)
  const walk = (n: any, sectionId?: string) => {
    if (n.type === "SECTION" && /how to read|legend/i.test(n.name)) { blocks.push(n.bounds); return }
    if (n.type === "SECTION") {
      sections.push({ id: n.id, name: n.name, rect: n.bounds, style: n.style })
      for (const c of n.children ?? []) walk(c, n.id)
      return
    }
    if (n.type === "PAGE" || n.role === "page") { for (const c of n.children ?? []) walk(c, sectionId); return }
    if (!n.bounds) return
    const obstacle = ["SHAPE_WITH_TEXT", "STICKY", "TABLE", "CODE_BLOCK", "LINK_UNFURL", "EMBED"].includes(n.type)
    nodes.push({ id: n.id, section: sectionId, rect: n.bounds, type: n.type, role: n.role, text: n.text, style: n.style, obstacle })
    for (const c of n.children ?? []) walk(c, sectionId)
  }
  walk(tree.root)
  const have = new Set(nodes.map((n) => n.id))
  const refKind = new Map((ref?.edges ?? []).map((e) => [`${e.from}>${e.to}`, e]))
  const edges: Edge[] = (tree.edges ?? [])
    .filter((e: any) => have.has(e.from) && have.has(e.to))
    .map((e: any) => ({ id: e.id, from: e.from, to: e.to, kind: refKind.get(`${e.from}>${e.to}`)?.kind ?? kindOf(e.style, e.lineType ?? e.style?.lineType), label: e.label ?? refKind.get(`${e.from}>${e.to}`)?.label, fromMagnet: e.fromMagnet, toMagnet: e.toMagnet, lineType: e.lineType ?? e.style?.lineType ?? refKind.get(`${e.from}>${e.to}`)?.lineType, style: e.style }))
  // card styles: board_tree reports camelCase palette names ("lightGreen")
  for (const n of nodes) if (n.style?.color) n.style.color = String(n.style.color).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
  return { name: "original", sections, nodes, edges, routes: [], blocks }
}

function png(svgPath: string): string | undefined {
  const out = svgPath.replace(/\.svg$/, ".png")
  try { execFileSync("rsvg-convert", ["-w", "2000", "-o", out, svgPath]); return out } catch { return undefined }
}

export async function plan(L: Layout, outDir: string) {
  mkdirSync(outDir, { recursive: true })
  const cands: Layout[] = [baseline(L), magnets(L)]
  const rf = await reflow(L)
  cands.push(rf.native, rf.drawn)
  const rd = await reflow(L, { direction: "DOWN" })
  rd.native.name = "reflow-down"
  cands.push(rd.native)
  cands.push(await route(L))
  cands.push(await bus(L), await bus(L, { intra: "native" }), await bus(L, { intra: "routed" }), await bus(L, { intra: "cards" }), await bus(L, { walls: false, name: "bus-nowalls" }), await bus(L, { walls: false, intra: "cards", name: "bus-nowalls-cards" }), await bus(L, { drawAll: true, name: "bus-drawn" }))
  // lanes: a few router settings; keep the one with no hard violations and the fewest crossings
  const tries: Layout[] = []
  for (const [cross, passes, bend] of [[100, 2, 6], [50, 1, 6], [50, 2, 10], [80, 3, 8], [150, 2, 6]]) tries.push(await lanes(L, { cross, passes, bend }))
  const bad = (c: Layout) => HARD_CHECKS.reduce((s, k) => s + (c.checks![k] ?? 0), 0)
  tries.sort((a, b) => bad(a) - bad(b) || a.checks!.laneSwapsInSections - b.checks!.laneSwapsInSections || a.checks!.crossings - b.checks!.crossings)
  tries[0].name = "lanes-v1"
  cands.push(tries[0])
  // the full pipeline: global routing → name tags → detailed lanes → pills
  cands.push(await planMap(L))
  const groups = classify(L)
  const sug = suggestMoves(L, groups)
  writeFileSync(join(outDir, "classification.json"), JSON.stringify({ groups, moves: sug.moves }, null, 1))
  const rows = cands.map((c) => {
    const svg = join(outDir, `${c.name}.svg`)
    writeFileSync(svg, toSvg(c))
    return { strategy: c.name, ...score(c), preview: png(svg) ?? svg }
  })
  writeFileSync(join(outDir, "plan.json"), JSON.stringify({ candidates: cands, metrics: rows }, null, 1))
  console.table(rows.map(({ preview, ...r }) => r))
  for (const c of cands) { const ck = c.checks ?? checks(c, c.sections.map((s) => titleRect(s))); console.log(c.name.padEnd(18), "self-checks", JSON.stringify(ck)) }
  return { cands, rows }
}

async function main() {
  const [cmd, a, b, c] = process.argv.slice(2)
  if (cmd === "fetch") {
    const L = await fetchLayout(a)
    writeFileSync(b ?? "layout.json", JSON.stringify(L, null, 1))
    console.log(`${L.sections.length} sections, ${L.nodes.length} nodes, ${L.edges.length} edges`)
  } else if (cmd === "convert") {
    // offline: cached board_tree JSON (+ reference layout for edge kinds) → Layout
    const ref = c ? JSON.parse(readFileSync(c, "utf8")) : undefined
    const L = fromTree(JSON.parse(readFileSync(a, "utf8")), ref)
    writeFileSync(b, JSON.stringify(L, null, 1))
    console.log(`${L.sections.length} sections, ${L.nodes.length} nodes, ${L.edges.length} edges`)
  } else if (cmd === "plan") {
    const L: Layout = JSON.parse(readFileSync(a, "utf8"))
    await plan(L, b ?? "out")
  } else if (cmd === "build") {
    const { build } = await import("./build.ts")
    const P = JSON.parse(readFileSync(a, "utf8"))
    const L: Layout = P.candidates.find((x: Layout) => x.name === b)
    if (!L) throw new Error(`no candidate ${b}`)
    await build(L, c)
  } else if (cmd === "overlay") {
    // overlay <plan.json> <strategy> <pageId> <board_tree.json>: hide existing connectors, add routed edges
    const { overlay } = await import("./build.ts")
    const P = JSON.parse(readFileSync(a, "utf8"))
    const L: Layout = P.candidates.find((x: Layout) => x.name === b)
    if (!L) throw new Error(`no candidate ${b}`)
    await overlay(L, c, JSON.parse(readFileSync(process.argv[6], "utf8")))
  } else {
    console.log("usage: bun src/cli.ts fetch <pageId> [out.json] | plan <layout.json> [outDir] | build <plan.json> <strategy> [pageId]")
  }
  void existsSync
}
if (import.meta.main) { await main(); process.exit(0) }
