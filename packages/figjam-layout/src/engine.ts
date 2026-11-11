// Strategies: baseline (as drawn), magnets (re-pick sides only), reflow (ELK), route (bus + libavoid).
import ELK, {
  type ElkExtendedEdge,
  type ElkNode,
} from "elkjs/lib/elk.bundled.js"
import { AvoidLib } from "libavoid-js"
import { dirname, join } from "node:path"

import {
  autoSides,
  bestMagnets,
  center,
  must,
  nativeElbow,
  SIDES,
  simplify,
  type Edge,
  type Layout,
  type Node,
  type Pt,
  type Rect,
  type Route,
  type Side,
  jsonClone,
} from "./model"

const SIDE_OK = new Set(["TOP", "BOTTOM", "LEFT", "RIGHT"])

function nodeMap(L: Layout) {
  return new Map(L.nodes.map((n) => [n.id, n]))
}

function rectOf(m: Map<string, Node>, id: string): Rect {
  return must(m.get(id), `node ${id}`).rect
}

export function sectionOf(
  L: Layout,
  e: Edge,
): [string | undefined, string | undefined] {
  const m = nodeMap(L)
  return [m.get(e.from)?.section, m.get(e.to)?.section]
}

// A recorded magnet if it names a side, else the facing side.
function recordedSide(magnet: string | undefined, fallback: Side): Side {
  return SIDE_OK.has(magnet ?? "") ? (magnet as Side) : fallback
}

// Baseline: the map as FigJam draws it today (recorded magnets, else facing sides).
export function baseline(L0: Layout): Layout {
  const L = jsonClone(L0)
  L.name = "original"
  const m = nodeMap(L)
  L.routes = L.edges.map((e) => {
    const a = rectOf(m, e.from),
      b = rectOf(m, e.to)
    const [da, db] = autoSides(a, b)
    const sa = recordedSide(e.fromMagnet, da)
    const sb = recordedSide(e.toMagnet, db)
    const pts =
      e.lineType === "STRAIGHT" ?
        [center(a), center(b)]
      : nativeElbow(a, sa, b, sb)
    return { edge: e.id, pts, native: true, fromMagnet: sa, toMagnet: sb }
  })
  return L
}

// Native connectors everywhere, magnets chosen greedily (longest edges first) to avoid cards and crossings.
export function pickMagnets(L: Layout, only?: Set<string>): Array<Route> {
  const m = nodeMap(L)
  const obstacles = L.nodes.filter((n) => n.obstacle)
  const fixed = L.routes.filter((r) => only && !only.has(r.edge))
  const todo = L.edges.filter((e) => !only || only.has(e.id))
  const d = (e: Edge) => {
    const [a, b] = [center(rectOf(m, e.from)), center(rectOf(m, e.to))]
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])
  }
  todo.sort((x, y) => d(y) - d(x))
  const out: Array<Route> = []
  for (const e of todo) {
    const a = rectOf(m, e.from),
      b = rectOf(m, e.to)
    const obs = obstacles
      .filter((n) => n.id !== e.from && n.id !== e.to)
      .map((n) => n.rect)
    const best = bestMagnets(
      a,
      b,
      obs,
      [...fixed, ...out].map((r) => r.pts),
    )
    out.push({
      edge: e.id,
      pts: best.pts,
      native: true,
      fromMagnet: best.sa,
      toMagnet: best.sb,
    })
  }
  return [...fixed, ...out]
}

export function magnets(L0: Layout): Layout {
  const L = jsonClone(L0)
  L.name = "magnets"
  L.routes = pickMagnets(L)
  return L
}

// ---- A. Reflow with ELK (layered, compound sections, orthogonal), snapped to the grid ----

// ELK fills in x/y (and width/height) on every node it lays out.
function placed(v: number | undefined, what: string): number {
  return must(v, `ELK ${what}`)
}

function elkGraph(
  L: Layout,
  grid: number,
  direction: "RIGHT" | "DOWN",
): ElkNode {
  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
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
      layoutOptions: {
        "elk.padding": `[top=${grid * 2},left=${grid},bottom=${grid},right=${grid}]`,
        "elk.spacing.nodeNode": String(grid),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(grid * 2),
        "elk.spacing.edgeNode": "40",
      },
      children: L.nodes
        .filter((n) => n.section === s.id)
        .map((n) => ({ id: n.id, width: n.rect.w, height: n.rect.h })),
    })),
    edges: L.edges.map((e) => ({
      id: e.id,
      sources: [e.from],
      targets: [e.to],
    })),
  }
}

// ELK's own orthogonal routes (what we'd draw as vectors), in absolute coordinates.
function elkRoutes(res: ElkNode, secIds: Set<string>): Array<Route> {
  const elkEdges: Array<{ e: ElkExtendedEdge; ox: number; oy: number }> = []
  const collect = (g: ElkNode, ox: number, oy: number) => {
    for (const e of g.edges ?? []) elkEdges.push({ e, ox, oy })
    for (const c of g.children ?? [])
      if (secIds.has(c.id))
        collect(c, ox + placed(c.x, "x"), oy + placed(c.y, "y"))
  }
  collect(res, 0, 0)
  const routes: Array<Route> = []
  for (const { e, ox, oy } of elkEdges) {
    for (const s of e.sections ?? []) {
      const pts: Array<Pt> = [
        [s.startPoint.x + ox, s.startPoint.y + oy],
        ...(s.bendPoints ?? []).map((p): Pt => [p.x + ox, p.y + oy]),
        [s.endPoint.x + ox, s.endPoint.y + oy],
      ]
      routes.push({ edge: e.id, pts: simplify(pts), native: false })
    }
  }
  return routes
}

export async function reflow(
  L0: Layout,
  opts: { grid?: number; direction?: "RIGHT" | "DOWN" } = {},
): Promise<{ native: Layout; drawn: Layout }> {
  const grid = opts.grid ?? 80
  const elk = new ELK()
  const L = jsonClone(L0)
  const secIds = new Set(L.sections.map((s) => s.id))
  const res = await elk.layout(elkGraph(L, grid, opts.direction ?? "RIGHT"))
  const snap = (v: number) => Math.round(v / grid) * grid
  const abs = new Map<string, Rect>()
  for (const s of res.children ?? []) {
    const sx = snap(placed(s.x, "x")),
      sy = snap(placed(s.y, "y"))
    let maxX = 0,
      maxY = 0
    for (const c of s.children ?? []) {
      const cx = snap(placed(c.x, "x")),
        cy = snap(placed(c.y, "y"))
      const w = placed(c.width, "width"),
        h = placed(c.height, "height")
      abs.set(c.id, { x: sx + cx, y: sy + cy, w, h })
      maxX = Math.max(maxX, cx + w)
      maxY = Math.max(maxY, cy + h)
    }
    const sec = must(
      L.sections.find((q) => q.id === s.id),
      `section ${s.id}`,
    )
    sec.rect = {
      x: sx,
      y: sy,
      w: Math.ceil((maxX + grid) / grid) * grid,
      h: Math.ceil((maxY + grid) / grid) * grid,
    }
  }
  for (const n of L.nodes) {
    const r = abs.get(n.id)
    if (r) n.rect = r
  }
  const drawn = jsonClone(L)
  drawn.name = "reflow-drawn"
  drawn.routes = elkRoutes(res, secIds)
  drawn.notes = ["ELK routes before grid snap; for reference only"]
  L.name = "reflow"
  L.routes = pickMagnets(L)
  return { native: L, drawn }
}

// ---- libavoid ----
// libavoid-js's own typings mix constructors with instances and widen to `any`; these describe
// the slice of its embind API this package uses.
declare const avoidHandle: unique symbol
type AvoidHandle<Name extends string> = { readonly [avoidHandle]: Name }

// An embind enum member (RouterFlag, RoutingParameter, RoutingOption, ConnType).
export type AvoidEnum = { readonly value: number }
export type AvoidPoint = AvoidHandle<"Point"> & { x: number; y: number }
export type AvoidRectangle = AvoidHandle<"Rectangle">
export type AvoidShapeRef = AvoidHandle<"ShapeRef">
export type AvoidConnEnd = AvoidHandle<"ConnEnd">
export type AvoidCheckpoint = AvoidHandle<"Checkpoint">
export type AvoidCheckpointVector = {
  push_back: (checkpoint: AvoidCheckpoint) => void
}
export type AvoidPolyLine = {
  size: () => number
  at: (index: number) => AvoidPoint
}
export type AvoidRouter = {
  setRoutingParameter: (parameter: AvoidEnum, value: number) => void
  setRoutingOption: (option: AvoidEnum, value: boolean) => void
  processTransaction: () => void
}
export type AvoidConnRef = {
  setRoutingType: (type: AvoidEnum) => void
  setRoutingCheckpoints: (checkpoints: AvoidCheckpointVector) => void
  displayRoute: () => AvoidPolyLine
}
export type AvoidShapeConnectionPin = {
  setExclusive: (exclusive: boolean) => void
}
export type AvoidApi = {
  Router: new (flags: number) => AvoidRouter
  Point: new (x: number, y: number) => AvoidPoint
  Rectangle: new (
    topLeft: AvoidPoint,
    bottomRight: AvoidPoint,
  ) => AvoidRectangle
  ShapeRef: new (router: AvoidRouter, polygon: AvoidRectangle) => AvoidShapeRef
  ShapeConnectionPin: new (
    shape: AvoidShapeRef,
    classId: number,
    xOffset: number,
    yOffset: number,
    proportional: boolean,
    insideOffset: number,
    visDirs: number,
  ) => AvoidShapeConnectionPin
  ConnEnd: {
    new (point: AvoidPoint): AvoidConnEnd
    new (shape: AvoidShapeRef, classId: number): AvoidConnEnd
  }
  ConnRef: new (
    router: AvoidRouter,
    src: AvoidConnEnd,
    dst: AvoidConnEnd,
  ) => AvoidConnRef
  Checkpoint: new (point: AvoidPoint) => AvoidCheckpoint
  CheckpointVector: new () => AvoidCheckpointVector
  RouterFlag: { OrthogonalRouting: AvoidEnum }
  RoutingParameter: Record<
    | "crossingPenalty"
    | "fixedSharedPathPenalty"
    | "idealNudgingDistance"
    | "segmentPenalty"
    | "shapeBufferDistance",
    AvoidEnum
  >
  RoutingOption: Record<
    | "nudgeOrthogonalSegmentsConnectedToShapes"
    | "nudgeOrthogonalTouchingColinearSegments"
    | "nudgeSharedPathsWithCommonEndPoint"
    | "performUnifyingNudgingPreprocessingStep",
    AvoidEnum
  >
  ConnType: { ConnType_Orthogonal: AvoidEnum }
}

// A router and the library it came from: what the shape/connector helpers below need.
export type Avoider = { Avoid: AvoidApi; router: AvoidRouter }

let avoidReady: Promise<AvoidApi> | undefined
export async function avoid(): Promise<AvoidApi> {
  if (!avoidReady) {
    // The package doesn't export the .wasm path, so find it next to the entry point.
    const wasm = join(
      dirname(Bun.resolveSync("libavoid-js", import.meta.dir)),
      "libavoid.wasm",
    )

    avoidReady = AvoidLib.load(wasm).then(
      () => AvoidLib.getInstance() as unknown as AvoidApi,
    )
  }
  return avoidReady
}

function box(Avoid: AvoidApi, p: Pt, q: Pt): AvoidRectangle {
  return new Avoid.Rectangle(
    new Avoid.Point(p[0], p[1]),
    new Avoid.Point(q[0], q[1]),
  )
}

// Every obstacle card as a libavoid shape, by node id.
export function cardShapes(
  av: Avoider,
  nodes: Array<Node>,
): Map<string, AvoidShapeRef> {
  const shapes = new Map<string, AvoidShapeRef>()
  for (const n of nodes)
    if (n.obstacle)
      shapes.set(
        n.id,
        new av.Avoid.ShapeRef(
          av.router,
          box(
            av.Avoid,
            [n.rect.x, n.rect.y],
            [n.rect.x + n.rect.w, n.rect.y + n.rect.h],
          ),
        ),
      )
  return shapes
}

// The obstacle box for one stretch [a, b] of a section wall: `inset` deep into the section,
// `outset` out into the gutter.
function wallBox(
  R: Rect,
  side: Side,
  span: { a: number; b: number; inset: number; outset: number },
): [Pt, Pt] {
  const { a, b, inset, outset } = span
  if (side === "TOP")
    return [
      [a, R.y - outset],
      [b, R.y + inset],
    ]
  if (side === "BOTTOM")
    return [
      [a, R.y + R.h - inset],
      [b, R.y + R.h + outset],
    ]
  if (side === "LEFT")
    return [
      [R.x - outset, a],
      [R.x + inset, b],
    ]
  return [
    [R.x + R.w - inset, a],
    [R.x + R.w + outset, b],
  ]
}

// One side of a section wall as libavoid obstacles, with gaps cut out at the doors.
export function addWall(
  av: Avoider,
  wall: {
    R: Rect
    side: Side
    cuts: Array<[number, number]>
    inset: number
    outset: number
  },
): void {
  const { R, side, inset, outset } = wall
  const horiz = side === "TOP" || side === "BOTTOM"
  const lo = horiz ? R.x : R.y
  const hi = horiz ? R.x + R.w : R.y + R.h
  const cuts = [...wall.cuts].sort((a, b) => a[0] - b[0])
  let cur = lo
  const spans: Array<[number, number]> = []
  for (const [c0, c1] of cuts) {
    if (c0 > cur) spans.push([cur, c0])
    cur = Math.max(cur, c1)
  }
  if (cur < hi) spans.push([cur, hi])
  for (const [a, b] of spans) {
    if (b - a < 2) continue
    const [p, q] = wallBox(R, side, { a, b, inset, outset })
    new av.Avoid.ShapeRef(av.router, box(av.Avoid, p, q))
  }
}

// One non-exclusive pin set per card (side midpoints, outward: up=1, down=2, left=4, right=8).
const CARD_PINS: ReadonlyArray<readonly [number, number, number]> = [
  [0.5, 0, 1],
  [0.5, 1, 2],
  [0, 0.5, 4],
  [1, 0.5, 8],
]

// Pin classes handed out per card on first use, numbered from 1 in that order.
export function pinClasses(
  Avoid: AvoidApi,
): (id: string, shape: AvoidShapeRef) => number {
  let next = 1
  const classes = new Map<string, number>()
  return (id, shape) => {
    const known = classes.get(id)
    if (known !== undefined) return known
    const cls = next++
    for (const [x, y, d] of CARD_PINS)
      new Avoid.ShapeConnectionPin(shape, cls, x, y, true, 0, d).setExclusive(
        false,
      )
    classes.set(id, cls)
    return cls
  }
}

export function readRoute(ref: AvoidConnRef): Array<Pt> {
  const pl = ref.displayRoute()
  const pts: Array<Pt> = []
  for (let i = 0; i < pl.size(); i++) pts.push([pl.at(i).x, pl.at(i).y])
  return simplify(pts)
}

export function hasDiagonal(p: Array<Pt>): boolean {
  return p.some((a, i) => i > 0 && a[0] !== p[i - 1][0] && a[1] !== p[i - 1][1])
}

// The point `at` along `side` of section rect S.
export function doorPoint(S: Rect, side: Side, at: number): Pt {
  if (side === "TOP") return [at, S.y]
  if (side === "BOTTOM") return [at, S.y + S.h]
  if (side === "LEFT") return [S.x, at]
  return [S.x + S.w, at]
}

// ---- B. Route: fixed positions, inter-section edges through gutter "bus" doors (libavoid) ----
type Door = {
  section: string
  side: Side
  at: number
  pt: Pt
  edges: Array<string>
}

type DoorPlan = { e: Edge; out: Door; in: Door }

const OUT: Record<Side, Pt> = {
  TOP: [0, -1],
  BOTTOM: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
}

export function facingSide(a: Rect, b: Rect): Side {
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w))
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h))
  if (gapX >= gapY) return b.x > a.x ? "RIGHT" : "LEFT"
  return b.y > a.y ? "BOTTOM" : "TOP"
}

function cardDoor(card: Node, S: Rect, side: Side): Door {
  const [cx, cy] = center(card.rect)
  const horiz = side === "TOP" || side === "BOTTOM"
  const at =
    horiz ?
      Math.min(Math.max(cx, S.x + 40), S.x + S.w - 40)
    : Math.min(Math.max(cy, S.y + 120), S.y + S.h - 40)
  const pt = doorPoint(S, side, at)
  return {
    section: must(card.section, `section of ${card.id}`),
    side,
    at,
    pt,
    edges: [],
  }
}

// 1. doors (ports): one per (card, section side); edges from the same card through the same side merge.
function planDoors(
  L: Layout,
  inter: Array<Edge>,
): { doors: Map<string, Door>; plan: Array<DoorPlan> } {
  const m = nodeMap(L)
  const sec = new Map(L.sections.map((s) => [s.id, s]))
  const sectionRect = (cardId: string): Rect => {
    const id = must(must(m.get(cardId), `card ${cardId}`).section, "section")
    return must(sec.get(id), `section ${id}`).rect
  }
  const doors = new Map<string, Door>()
  const doorFor = (cardId: string, other: string, edgeId: string): Door => {
    const card = must(m.get(cardId), `card ${cardId}`)
    const S = sectionRect(cardId)
    const side = facingSide(S, sectionRect(other))
    const key = `${cardId}|${side}`
    let d = doors.get(key)
    if (!d) {
      d = cardDoor(card, S, side)
      doors.set(key, d)
    }
    d.edges.push(edgeId)
    return d
  }
  const plan = inter.map((e) => ({
    e,
    out: doorFor(e.from, e.to, e.id),
    in: doorFor(e.to, e.from, e.id),
  }))
  return { doors, plan }
}

// spread doors on the same side so they don't collide
function spreadDoors(doors: Map<string, Door>, L: Layout, pitch: number) {
  const sec = new Map(L.sections.map((s) => [s.id, s]))
  const bySide = new Map<string, Array<Door>>()
  for (const d of doors.values()) {
    const k = `${d.section}|${d.side}`
    bySide.set(k, [...(bySide.get(k) ?? []), d])
  }
  for (const list of bySide.values()) {
    list.sort((a, b) => a.at - b.at)
    for (let i = 1; i < list.length; i++)
      if (list[i].at - list[i - 1].at < pitch * 3)
        list[i].at = list[i - 1].at + pitch * 3
    for (const d of list) {
      const S = must(sec.get(d.section), `section ${d.section}`).rect
      d.pt = doorPoint(S, d.side, d.at)
    }
  }
}

function routeRouter(Avoid: AvoidApi, pitch: number): Avoider {
  const router = new Avoid.Router(Avoid.RouterFlag.OrthogonalRouting.value)
  router.setRoutingParameter(Avoid.RoutingParameter.shapeBufferDistance, 16)
  router.setRoutingParameter(Avoid.RoutingParameter.idealNudgingDistance, pitch)
  router.setRoutingParameter(Avoid.RoutingParameter.segmentPenalty, 40)
  router.setRoutingParameter(Avoid.RoutingParameter.crossingPenalty, 400)
  router.setRoutingParameter(Avoid.RoutingParameter.fixedSharedPathPenalty, 200)
  router.setRoutingOption(
    Avoid.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes,
    true,
  )
  router.setRoutingOption(
    Avoid.RoutingOption.nudgeSharedPathsWithCommonEndPoint,
    true,
  )
  router.setRoutingOption(
    Avoid.RoutingOption.performUnifyingNudgingPreprocessingStep,
    true,
  )
  router.setRoutingOption(
    Avoid.RoutingOption.nudgeOrthogonalTouchingColinearSegments,
    false,
  )
  return { Avoid, router }
}

function doorCheckpoint(Avoid: AvoidApi, d: Door): AvoidCheckpoint {
  return new Avoid.Checkpoint(
    new Avoid.Point(
      d.pt[0] + OUT[d.side][0] * 40,
      d.pt[1] + OUT[d.side][1] * 40,
    ),
  )
}

// 3. connectors: card → out door → in door → card. Pins on all four sides (center) of each card.
function doorConnectors(
  av: Avoider,
  shapes: Map<string, AvoidShapeRef>,
  plan: Array<DoorPlan>,
): Array<{ e: Edge; ref: AvoidConnRef }> {
  const { Avoid, router } = av
  const pinsFor = pinClasses(Avoid)
  const conns: Array<{ e: Edge; ref: AvoidConnRef }> = []
  for (const { e, out, in: inn } of plan) {
    const src = must(shapes.get(e.from), `shape ${e.from}`),
      dst = must(shapes.get(e.to), `shape ${e.to}`)
    const cs = pinsFor(e.from, src),
      cd = pinsFor(e.to, dst)
    const ref = new Avoid.ConnRef(
      router,
      new Avoid.ConnEnd(src, cs),
      new Avoid.ConnEnd(dst, cd),
    )
    ref.setRoutingType(Avoid.ConnType.ConnType_Orthogonal)
    const cps = new Avoid.CheckpointVector()
    cps.push_back(doorCheckpoint(Avoid, out))
    cps.push_back(doorCheckpoint(Avoid, inn))
    ref.setRoutingCheckpoints(cps)
    conns.push({ e, ref })
  }
  return conns
}

export async function route(
  L0: Layout,
  opts: { pitch?: number; doorPad?: number } = {},
): Promise<Layout> {
  const Avoid = await avoid()
  const pitch = opts.pitch ?? 20
  const L = jsonClone(L0)
  L.name = "route"
  const inter = L.edges.filter((e) => {
    const [a, b] = sectionOf(L, e)
    return a && b && a !== b
  })
  const intra = new Set(
    L.edges.filter((e) => !inter.includes(e)).map((e) => e.id),
  )

  const { doors, plan } = planDoors(L, inter)
  spreadDoors(doors, L, pitch)

  // 2. obstacles: cards + section walls with gaps at the doors.
  const av = routeRouter(Avoid, pitch)
  const shapes = cardShapes(av, L.nodes)
  const T = 4
  const gap = 40 + (opts.doorPad ?? 0)
  for (const s of L.sections)
    for (const side of SIDES)
      addWall(av, {
        R: s.rect,
        side,
        cuts: [...doors.values()]
          .filter((d) => d.section === s.id && d.side === side)
          .map((d): [number, number] => [d.at - gap, d.at + gap]),
        inset: T,
        outset: T,
      })
  const conns = doorConnectors(av, shapes, plan)
  av.router.processTransaction()
  // libavoid gives a straight fallback when the door path is infeasible: retry those without checkpoints.
  let retried = 0
  for (const c of conns)
    if (hasDiagonal(readRoute(c.ref))) {
      c.ref.setRoutingCheckpoints(new Avoid.CheckpointVector())
      retried++
    }
  if (retried) av.router.processTransaction()
  const drawn: Array<Route> = conns.map(({ e, ref }) => ({
    edge: e.id,
    pts: readRoute(ref),
    native: false,
  }))
  const failed = drawn.filter((r) => hasDiagonal(r.pts)).length
  // 4. intra-section edges stay native; magnets chosen with the drawn bus already in place.
  L.routes = drawn
  L.routes = pickMagnets(L, intra)
  L.notes = [
    `${inter.length} inter-section edges on the bus via ${doors.size} doors; ${intra.size} native; ${retried} retried without doors, ${failed} still straight`,
  ]
  L.doors = [...doors.values()]
  return L
}
