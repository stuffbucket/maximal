// Strategies: baseline (as drawn), magnets (re-pick sides only), reflow (ELK), route (bus + libavoid).
import ELK from "elkjs/lib/elk.bundled.js"
import { AvoidLib } from "libavoid-js"
import { autoSides, bestMagnets, center, nativeElbow, simplify, type Edge, type Layout, type Node, type Pt, type Rect, type Route, type Section, type Side } from "./model.ts"
import { dirname, join } from "node:path"

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const SIDE_OK = new Set(["TOP", "BOTTOM", "LEFT", "RIGHT"])

function nodeMap(L: Layout) {
  return new Map(L.nodes.map((n) => [n.id, n]))
}

export function sectionOf(L: Layout, e: Edge): [string | undefined, string | undefined] {
  const m = nodeMap(L)
  return [m.get(e.from)?.section, m.get(e.to)?.section]
}

// Baseline: the map as FigJam draws it today (recorded magnets, else facing sides).
export function baseline(L0: Layout): Layout {
  const L = clone(L0)
  L.name = "original"
  const m = nodeMap(L)
  L.routes = L.edges.map((e) => {
    const a = m.get(e.from)!.rect, b = m.get(e.to)!.rect
    const [da, db] = autoSides(a, b)
    const sa = (SIDE_OK.has(e.fromMagnet ?? "") ? e.fromMagnet : da) as Side
    const sb = (SIDE_OK.has(e.toMagnet ?? "") ? e.toMagnet : db) as Side
    const pts = e.lineType === "STRAIGHT" ? [center(a), center(b)] : nativeElbow(a, sa, b, sb)
    return { edge: e.id, pts, native: true, fromMagnet: sa, toMagnet: sb }
  })
  return L
}

// Native connectors everywhere, magnets chosen greedily (longest edges first) to avoid cards and crossings.
export function pickMagnets(L: Layout, only?: Set<string>): Route[] {
  const m = nodeMap(L)
  const obstacles = L.nodes.filter((n) => n.obstacle)
  const fixed = L.routes.filter((r) => only && !only.has(r.edge))
  const todo = L.edges.filter((e) => !only || only.has(e.id))
  todo.sort((x, y) => {
    const d = (e: Edge) => { const [a, b] = [center(m.get(e.from)!.rect), center(m.get(e.to)!.rect)]; return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) }
    return d(y) - d(x)
  })
  const out: Route[] = []
  for (const e of todo) {
    const a = m.get(e.from)!.rect, b = m.get(e.to)!.rect
    const obs = obstacles.filter((n) => n.id !== e.from && n.id !== e.to).map((n) => n.rect)
    const best = bestMagnets(a, b, obs, [...fixed, ...out].map((r) => r.pts))
    out.push({ edge: e.id, pts: best.pts, native: true, fromMagnet: best.sa, toMagnet: best.sb })
  }
  return [...fixed, ...out]
}

export function magnets(L0: Layout): Layout {
  const L = clone(L0)
  L.name = "magnets"
  L.routes = pickMagnets(L)
  return L
}

// ---- A. Reflow with ELK (layered, compound sections, orthogonal), snapped to the grid ----
export async function reflow(L0: Layout, opts: { grid?: number; direction?: "RIGHT" | "DOWN" } = {}): Promise<{ native: Layout; drawn: Layout }> {
  const grid = opts.grid ?? 80
  const elk = new ELK()
  const L = clone(L0)
  const secIds = new Set(L.sections.map((s) => s.id))
  const graph: any = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": opts.direction ?? "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": String(grid),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(grid * 2),
      "elk.spacing.edgeEdge": "24",
      "elk.spacing.edgeNode": "40",
      "elk.layered.spacing.edgeNodeBetweenLayers": "40",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.aspectRatio": "1.6",
    },
    children: L.sections.map((s) => ({
      id: s.id,
      layoutOptions: { "elk.padding": `[top=${grid * 2},left=${grid},bottom=${grid},right=${grid}]`, "elk.spacing.nodeNode": String(grid), "elk.layered.spacing.nodeNodeBetweenLayers": String(grid * 2), "elk.spacing.edgeNode": "40" },
      children: L.nodes.filter((n) => n.section === s.id).map((n) => ({ id: n.id, width: n.rect.w, height: n.rect.h })),
    })),
    edges: L.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  }
  const res = await elk.layout(graph)
  const snap = (v: number) => Math.round(v / grid) * grid
  const abs = new Map<string, Rect>()
  const offs = new Map<string, Pt>()
  for (const s of res.children ?? []) {
    const sx = snap(s.x), sy = snap(s.y)
    offs.set(s.id, [s.x, s.y])
    let maxX = 0, maxY = 0
    for (const c of s.children ?? []) {
      const r = { x: sx + snap(c.x), y: sy + snap(c.y), w: c.width, h: c.height }
      abs.set(c.id, r)
      maxX = Math.max(maxX, snap(c.x) + c.width)
      maxY = Math.max(maxY, snap(c.y) + c.height)
    }
    const sec = L.sections.find((q) => q.id === s.id)!
    sec.rect = { x: sx, y: sy, w: Math.ceil((maxX + grid) / grid) * grid, h: Math.ceil((maxY + grid) / grid) * grid }
  }
  for (const n of L.nodes) if (abs.has(n.id)) n.rect = abs.get(n.id)!
  // ELK's own orthogonal routes (what we'd draw as vectors)
  const drawn = clone(L)
  drawn.name = "reflow-drawn"
  const elkEdges: any[] = []
  const collect = (g: any, ox: number, oy: number) => {
    for (const e of g.edges ?? []) elkEdges.push({ e, ox, oy })
    for (const c of g.children ?? []) if (secIds.has(c.id)) collect(c, ox + c.x, oy + c.y)
  }
  collect(res, 0, 0)
  drawn.routes = []
  for (const { e, ox, oy } of elkEdges) {
    for (const s of e.sections ?? []) {
      const pts: Pt[] = [[s.startPoint.x + ox, s.startPoint.y + oy], ...(s.bendPoints ?? []).map((p: any) => [p.x + ox, p.y + oy] as Pt), [s.endPoint.x + ox, s.endPoint.y + oy]]
      drawn.routes.push({ edge: e.id, pts: simplify(pts), native: false })
    }
  }
  drawn.notes = ["ELK routes before grid snap; for reference only"]
  L.name = "reflow"
  L.routes = pickMagnets(L)
  return { native: L, drawn }
}

// ---- B. Route: fixed positions, inter-section edges through gutter "bus" doors (libavoid) ----
let avoidReady: Promise<any> | undefined
export async function avoid() {
  if (!avoidReady) {
    // The package doesn't export the .wasm path, so find it next to the entry point.
    const wasm = join(dirname(Bun.resolveSync("libavoid-js", import.meta.dir)), "libavoid.wasm")

    avoidReady = AvoidLib.load(wasm).then(() => AvoidLib.getInstance())
  }
  return avoidReady
}

type Door = { section: string; side: Side; at: number; pt: Pt; edges: string[] }

export function facingSide(a: Rect, b: Rect): Side {
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w))
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h))
  if (gapX >= gapY) return b.x > a.x ? "RIGHT" : "LEFT"
  return b.y > a.y ? "BOTTOM" : "TOP"
}

export async function route(L0: Layout, opts: { pitch?: number; doorPad?: number } = {}): Promise<Layout> {
  const Avoid = await avoid()
  const pitch = opts.pitch ?? 20
  const L = clone(L0)
  L.name = "route"
  const m = nodeMap(L)
  const sec = new Map(L.sections.map((s) => [s.id, s]))
  const inter = L.edges.filter((e) => { const [a, b] = sectionOf(L, e); return a && b && a !== b })
  const intra = new Set(L.edges.filter((e) => !inter.includes(e)).map((e) => e.id))

  // 1. doors (ports): one per (card, section side); edges from the same card through the same side merge.
  const doors = new Map<string, Door>()
  const doorFor = (cardId: string, other: string, edgeId: string): Door => {
    const card = m.get(cardId)!
    const S = sec.get(card.section!)!.rect
    const T = sec.get(m.get(other)!.section!)!.rect
    const side = facingSide(S, T)
    const key = `${cardId}|${side}`
    if (!doors.has(key)) {
      const [cx, cy] = center(card.rect)
      const horiz = side === "TOP" || side === "BOTTOM"
      const at = horiz ? Math.min(Math.max(cx, S.x + 40), S.x + S.w - 40) : Math.min(Math.max(cy, S.y + 120), S.y + S.h - 40)
      const pt: Pt = side === "TOP" ? [at, S.y] : side === "BOTTOM" ? [at, S.y + S.h] : side === "LEFT" ? [S.x, at] : [S.x + S.w, at]
      doors.set(key, { section: card.section!, side, at, pt, edges: [] })
    }
    const d = doors.get(key)!
    d.edges.push(edgeId)
    return d
  }
  const plan = inter.map((e) => ({ e, out: doorFor(e.from, e.to, e.id), in: doorFor(e.to, e.from, e.id) }))
  // spread doors on the same side so they don't collide
  const bySide = new Map<string, Door[]>()
  for (const d of doors.values()) {
    const k = `${d.section}|${d.side}`
    bySide.set(k, [...(bySide.get(k) ?? []), d])
  }
  for (const list of bySide.values()) {
    list.sort((a, b) => a.at - b.at)
    for (let i = 1; i < list.length; i++) if (list[i].at - list[i - 1].at < pitch * 3) list[i].at = list[i - 1].at + pitch * 3
    for (const d of list) {
      const S = sec.get(d.section)!.rect
      d.pt = d.side === "TOP" ? [d.at, S.y] : d.side === "BOTTOM" ? [d.at, S.y + S.h] : d.side === "LEFT" ? [S.x, d.at] : [S.x + S.w, d.at]
    }
  }

  // 2. obstacles: cards + section walls with gaps at the doors.
  const router = new Avoid.Router(Avoid.RouterFlag.OrthogonalRouting.value)
  router.setRoutingParameter(Avoid.RoutingParameter.shapeBufferDistance, 16)
  router.setRoutingParameter(Avoid.RoutingParameter.idealNudgingDistance, pitch)
  router.setRoutingParameter(Avoid.RoutingParameter.segmentPenalty, 40)
  router.setRoutingParameter(Avoid.RoutingParameter.crossingPenalty, 400)
  router.setRoutingParameter(Avoid.RoutingParameter.fixedSharedPathPenalty, 200)
  router.setRoutingOption(Avoid.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes, true)
  router.setRoutingOption(Avoid.RoutingOption.nudgeSharedPathsWithCommonEndPoint, true)
  router.setRoutingOption(Avoid.RoutingOption.performUnifyingNudgingPreprocessingStep, true)
  router.setRoutingOption(Avoid.RoutingOption.nudgeOrthogonalTouchingColinearSegments, false)
  const rect = (x0: number, y0: number, x1: number, y1: number) => new Avoid.Rectangle(new Avoid.Point(x0, y0), new Avoid.Point(x1, y1))
  const shapes = new Map<string, any>()
  for (const n of L.nodes) if (n.obstacle) shapes.set(n.id, new Avoid.ShapeRef(router, rect(n.rect.x, n.rect.y, n.rect.x + n.rect.w, n.rect.y + n.rect.h)))
  const T = 4
  const gap = 40 + (opts.doorPad ?? 0)
  for (const s of L.sections) {
    const R = s.rect
    for (const side of ["TOP", "BOTTOM", "LEFT", "RIGHT"] as Side[]) {
      const horiz = side === "TOP" || side === "BOTTOM"
      const lo = horiz ? R.x : R.y
      const hi = horiz ? R.x + R.w : R.y + R.h
      const cuts = [...doors.values()].filter((d) => d.section === s.id && d.side === side).map((d) => [d.at - gap, d.at + gap]).sort((a, b) => a[0] - b[0])
      let cur = lo
      const spans: [number, number][] = []
      for (const [c0, c1] of cuts) { if (c0 > cur) spans.push([cur, c0]); cur = Math.max(cur, c1) }
      if (cur < hi) spans.push([cur, hi])
      for (const [a, b] of spans) {
        if (b - a < 2) continue
        if (side === "TOP") new Avoid.ShapeRef(router, rect(a, R.y - T, b, R.y + T))
        if (side === "BOTTOM") new Avoid.ShapeRef(router, rect(a, R.y + R.h - T, b, R.y + R.h + T))
        if (side === "LEFT") new Avoid.ShapeRef(router, rect(R.x - T, a, R.x + T, b))
        if (side === "RIGHT") new Avoid.ShapeRef(router, rect(R.x + R.w - T, a, R.x + R.w + T, b))
      }
    }
  }
  // 3. connectors: card → out door → in door → card. Pins on all four sides (center) of each card.
  const ALL = 15
  let pinClass = 1
  const pinCls = new Map<string, number>()
  // one non-exclusive pin set per card (side midpoints, outward: up=1, down=2, left=4, right=8)
  const pinsFor = (id: string, shape: any) => {
    if (!pinCls.has(id)) {
      const cls = pinClass++
      for (const [x, y, d] of [[0.5, 0, 1], [0.5, 1, 2], [0, 0.5, 4], [1, 0.5, 8]]) new Avoid.ShapeConnectionPin(shape, cls, x, y, true, 0, d).setExclusive(false)
      pinCls.set(id, cls)
    }
    return pinCls.get(id)!
  }
  const conns: { e: Edge; ref: any }[] = []
  for (const { e, out, in: inn } of plan) {
    const src = shapes.get(e.from), dst = shapes.get(e.to)
    const cs = pinsFor(e.from, src), cd = pinsFor(e.to, dst)
    const ref = new Avoid.ConnRef(router, new Avoid.ConnEnd(src, cs), new Avoid.ConnEnd(dst, cd))
    ref.setRoutingType(Avoid.ConnType.ConnType_Orthogonal)
    const cps = new Avoid.CheckpointVector()
    const OUT: Record<Side, Pt> = { TOP: [0, -1], BOTTOM: [0, 1], LEFT: [-1, 0], RIGHT: [1, 0] }
    const cp = (d: Door) => new Avoid.Checkpoint(new Avoid.Point(d.pt[0] + OUT[d.side][0] * 40, d.pt[1] + OUT[d.side][1] * 40))
    cps.push_back(cp(out))
    cps.push_back(cp(inn))
    ref.setRoutingCheckpoints(cps)
    conns.push({ e, ref })
  }
  void ALL
  router.processTransaction()
  const read = (ref: any) => {
    const pl = ref.displayRoute()
    const pts: Pt[] = []
    for (let i = 0; i < pl.size(); i++) pts.push([pl.at(i).x, pl.at(i).y])
    return simplify(pts)
  }
  const diag = (p: Pt[]) => p.some((a, i) => i > 0 && a[0] !== p[i - 1][0] && a[1] !== p[i - 1][1])
  // libavoid gives a straight fallback when the door path is infeasible: retry those without checkpoints.
  let retried = 0
  for (const c of conns) if (diag(read(c.ref))) { c.ref.setRoutingCheckpoints(new Avoid.CheckpointVector()); retried++ }
  if (retried) router.processTransaction()
  const drawn: Route[] = conns.map(({ e, ref }) => ({ edge: e.id, pts: read(ref), native: false }))
  const failed = drawn.filter((r) => diag(r.pts)).length
  // 4. intra-section edges stay native; magnets chosen with the drawn bus already in place.
  L.routes = drawn
  L.routes = pickMagnets(L, intra)
  L.notes = [`${inter.length} inter-section edges on the bus via ${doors.size} doors; ${intra.size} native; ${retried} retried without doors, ${failed} still straight`]
  ;(L as any).doors = [...doors.values()]
  return L
}
