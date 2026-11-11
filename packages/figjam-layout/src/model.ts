// Layout model + geometry + metrics. Pure functions, no bridge access.
export type Pt = [number, number]
export type Rect = { x: number; y: number; w: number; h: number }
export type Side = "TOP" | "BOTTOM" | "LEFT" | "RIGHT"
export type EdgeKind = "dep" | "flow" | "verify" | "loop" | "other"

// A section's or card's style as board_tree reports it: a palette colour name ("light green"),
// a fill hex, a FigJam shape name ("ROUNDED_RECTANGLE", "ELLIPSE", ...) and a font size.
export type ShapeStyle = {
  color?: string
  fill?: string
  fillHex?: string
  shape?: string
  fontSize?: number
}
// A connector's stroke style. board_tree edges carry none, so it is often absent.
export type EdgeStyle = {
  dashPattern?: Array<number>
  dashes?: Array<number>
  strokeWeight?: number
  lineType?: string
}

export type Section = {
  id: string
  name: string
  rect: Rect
  style?: ShapeStyle
}
export type Node = {
  id: string
  section?: string
  rect: Rect
  type: string
  role?: string
  text?: string
  style?: ShapeStyle
  obstacle: boolean
}
export type Edge = {
  id: string
  from: string
  to: string
  kind: EdgeKind
  label?: string
  fromMagnet?: string
  toMagnet?: string
  lineType?: string
  style?: EdgeStyle
}
// A route: native = FigJam auto-elbow between two magnets; drawn = our own polyline.
export type Route = {
  edge: string
  pts: Array<Pt>
  native: boolean
  fromMagnet?: Side
  toMagnet?: Side
  bundle?: string
}
export type Label = { edge: string; text: string; rect: Rect }

// A stroke as drawn: a bundle's shared chain, one edge's own line, or an arrowhead.
// `bus` draws trunk/feeder/intra pieces; `lanes` draws chain/arrow pieces.
export type Piece = {
  id: string
  kind: string | undefined
  pts: Array<Pt>
  arrow: boolean
  arrowOnly?: boolean
  count: number
  role: "arrow" | "chain" | "feeder" | "intra" | "trunk"
}

// A name tag: the pill at one end of a link drawn as a pair of pills instead of a wire.
export type Tag = {
  edge: string
  edges?: Array<string>
  card: string
  other: string
  text: string
  rect: Rect
  order: number
}

// Why a route looks the way it does: its mode, its port choices, and a cause per bend. lanes
// writes all four; the fixpoint adds port causes and rewrites `bends`, and starts an entry of its
// own (without mode or ports) for a route lanes didn't explain.
export type Explanation = {
  mode?: string
  from?: unknown
  to?: unknown
  bends?: Array<string>
}

export type Layout = {
  name: string
  sections: Array<Section>
  nodes: Array<Node>
  edges: Array<Edge>
  routes: Array<Route>
  notes?: Array<string>
  blocks?: Array<Rect>
  labels?: Array<Label>
  checks?: Record<string, number>
  // Set by individual strategies and read by svg.ts, build.ts and the pipeline.
  pieces?: Array<Piece>
  doors?: Array<{ pt: Pt }>
  doorNodes?: Array<Pt>
  tags?: Array<Tag>
  newTags?: Array<string>
  policy?: "A" | "B"
  explain?: Partial<Record<string, Explanation>>
  swapPts?: Array<Pt>
  swapPairs?: Array<[string, string]>
  swapGutterPairs?: Array<[string, string]>
  fixpoint?: FixpointStats
  plan?: PlanStats
}

// What the local-optimality fixpoint did: moves applied per kind, sweeps run, layouts evaluated,
// and improving simplifications still available (0 at a true fixpoint).
export type FixpointStats = {
  applied: Record<string, number>
  sweeps: number
  evaluations: number
  left: number
}

// The global plan's outcome and the name-tag thresholds the pipeline used.
export type PlanStats = {
  overflow: number
  iterations: number
  windows: number
  tagRatio: number
  tagLength: number
}

// The last element of a non-empty array. Throws on an empty one: callers rely on it existing.
export function last<T>(xs: ReadonlyArray<T>): T {
  if (xs.length === 0) throw new Error("last() of an empty array")
  return xs.at(-1) as T
}

// A value the algorithm guarantees is present (a map lookup by an id it put there, etc.).
// Throws with `what` instead of carrying on with undefined.
export function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`)
  return value
}

// A self-check's value, 0 when the checks didn't report it.
export function checkValue(
  checks: Record<string, number>,
  key: string,
): number {
  return checks[key] ?? 0
}

// A deep copy of plain JSON data (a Layout) through JSON: fields set to undefined are dropped,
// as they are when a layout is written to disk.
export function jsonClone<T>(value: T): T {
  // eslint-disable-next-line unicorn/prefer-structured-clone -- structuredClone keeps undefined-valued fields, which changes the copy's keys and its serialized form
  return JSON.parse(JSON.stringify(value)) as T
}

export const SIDES: Array<Side> = ["TOP", "BOTTOM", "LEFT", "RIGHT"]

export function center(r: Rect): Pt {
  return [r.x + r.w / 2, r.y + r.h / 2]
}

export function sidePoint(r: Rect, s: Side, t = 0.5): Pt {
  if (s === "TOP") return [r.x + r.w * t, r.y]
  if (s === "BOTTOM") return [r.x + r.w * t, r.y + r.h]
  if (s === "LEFT") return [r.x, r.y + r.h * t]
  return [r.x + r.w, r.y + r.h * t]
}

const DIR: Record<Side, Pt> = {
  TOP: [0, -1],
  BOTTOM: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
}

// Facing sides along the dominant axis (what `connect` does with magnets omitted).
export function autoSides(a: Rect, b: Rect): [Side, Side] {
  const [ax, ay] = center(a)
  const [bx, by] = center(b)
  const dx = bx - ax
  const dy = by - ay
  const overlapX = a.x < b.x + b.w && b.x < a.x + a.w
  const overlapY = a.y < b.y + b.h && b.y < a.y + a.h
  const horizontal = overlapY || (!overlapX && Math.abs(dx) >= Math.abs(dy))
  if (horizontal) return dx >= 0 ? ["RIGHT", "LEFT"] : ["LEFT", "RIGHT"]
  return dy >= 0 ? ["BOTTOM", "TOP"] : ["TOP", "BOTTOM"]
}

// Approximation of FigJam's elbow router between two magnets: leave each side
// perpendicular by a stub, then join with one or two orthogonal bends.
// eslint-disable-next-line max-params -- exported signature (engine.ts calls it with two rect/side pairs and the default stub)
export function nativeElbow(
  a: Rect,
  sa: Side,
  b: Rect,
  sb: Side,
  stub = 24,
): Array<Pt> {
  const p = sidePoint(a, sa)
  const q = sidePoint(b, sb)
  const da = DIR[sa]
  const db = DIR[sb]
  const p1: Pt = [p[0] + da[0] * stub, p[1] + da[1] * stub]
  const q1: Pt = [q[0] + db[0] * stub, q[1] + db[1] * stub]
  const hA = da[0] !== 0
  const hB = db[0] !== 0
  let mid: Array<Pt>
  if (hA && hB) {
    const mx = (p1[0] + q1[0]) / 2
    mid = [
      [mx, p1[1]],
      [mx, q1[1]],
    ]
  } else if (!hA && !hB) {
    const my = (p1[1] + q1[1]) / 2
    mid = [
      [p1[0], my],
      [q1[0], my],
    ]
  } else if (hA) mid = [[q1[0], p1[1]]]
  else mid = [[p1[0], q1[1]]]
  return simplify([p, p1, ...mid, q1, q])
}

export function simplify(pts: Array<Pt>): Array<Pt> {
  const out: Array<Pt> = []
  for (const p of pts) {
    const last = out.at(-1)
    if (
      last
      && Math.abs(last[0] - p[0]) < 0.5
      && Math.abs(last[1] - p[1]) < 0.5
    )
      continue
    out.push([Math.round(p[0]), Math.round(p[1])])
  }
  // drop collinear middle points
  for (let i = out.length - 2; i > 0; i--) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]]
    if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]))
      out.splice(i, 1)
  }
  return out
}

// ---- metrics ----
type Seg = [Pt, Pt]

function segHitsRect([p, q]: Seg, r: Rect, pad = 2): boolean {
  const x0 = r.x + pad,
    y0 = r.y + pad,
    x1 = r.x + r.w - pad,
    y1 = r.y + r.h - pad
  // Liang–Barsky clip
  let t0 = 0,
    t1 = 1
  const dx = q[0] - p[0],
    dy = q[1] - p[1]
  const tests: Array<[number, number]> = [
    [-dx, p[0] - x0],
    [dx, x1 - p[0]],
    [-dy, p[1] - y0],
    [dy, y1 - p[1]],
  ]
  for (const [pp, qq] of tests) {
    if (pp === 0) {
      if (qq < 0) return false
      continue
    }
    const t = qq / pp
    if (pp < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
  }
  return t1 - t0 > 1e-6
}

// Whether any segment of the polyline passes through the rect (shrunk by `pad`).
function polylineHitsRect(pts: Array<Pt>, r: Rect, pad = 2): boolean {
  for (let i = 0; i + 1 < pts.length; i++)
    if (segHitsRect([pts[i], pts[i + 1]], r, pad)) return true
  return false
}

const orient = (p: Pt, q: Pt, r: Pt) =>
  Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))

function segsCross([a, b]: Seg, [c, d]: Seg): boolean {
  return (
    orient(a, b, c) * orient(a, b, d) < 0
    && orient(c, d, a) * orient(c, d, b) < 0
  )
}

function overlapLen([a, b]: Seg, [c, d]: Seg): number {
  if (a[1] === b[1] && c[1] === d[1] && Math.abs(a[1] - c[1]) < 1) {
    const lo = Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0]))
    const hi = Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0]))
    return Math.max(0, hi - lo)
  }
  if (a[0] === b[0] && c[0] === d[0] && Math.abs(a[0] - c[0]) < 1) {
    const lo = Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1]))
    const hi = Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]))
    return Math.max(0, hi - lo)
  }
  return 0
}

export type Metrics = {
  edges: number
  inkCrossings: number
  strokes: number
  inkBends: number
  inkLength: number
  throughNode: number
  throughHits: number
  crossings: number
  bends: number
  length: number
  laneOverlaps: number
  nodeOverlaps: number
  area: number
}

// How many obstacles (other than the edge's own ends) the route passes through.
function obstacleHits(pts: Array<Pt>, e: Edge, obstacles: Array<Node>): number {
  let hit = 0
  for (const n of obstacles) {
    if (n.id === e.from || n.id === e.to) continue
    if (polylineHitsRect(pts, n.rect)) hit++
  }
  return hit
}

// `length` plus the route's Euclidean length, accumulated segment by segment.
function addLength(length: number, pts: Array<Pt>): number {
  let sum = length
  for (let i = 0; i + 1 < pts.length; i++)
    sum += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
  return sum
}

// Whether two routes properly cross (ignored when they share a card), and how long they run
// on top of each other.
function routeContact(
  a: Array<Pt>,
  b: Array<Pt>,
  shared: boolean,
): { crossed: boolean; overlap: number } {
  let crossed = false,
    overlap = 0
  for (let s = 0; s + 1 < a.length; s++) {
    for (let t = 0; t + 1 < b.length; t++) {
      const sa: Seg = [a[s], a[s + 1]],
        sb: Seg = [b[t], b[t + 1]]
      if (!shared && segsCross(sa, sb)) crossed = true
      overlap += overlapLen(sa, sb)
    }
  }
  return { crossed, overlap }
}

// Route pairs that cross, and unbundled route pairs that share a lane for more than 8px.
function routePairs(
  routes: Array<Route>,
  edgeOf: (id: string) => Edge,
): { crossings: number; laneOverlaps: number } {
  let crossings = 0,
    laneOverlaps = 0
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const A = routes[i],
        B = routes[j]
      const ea = edgeOf(A.edge),
        eb = edgeOf(B.edge)
      const shared = [ea.from, ea.to].some((x) => x === eb.from || x === eb.to)
      const { crossed, overlap } = routeContact(A.pts, B.pts, shared)
      if (crossed) crossings++
      if (overlap > 8 && !shared && (!A.bundle || A.bundle !== B.bundle))
        laneOverlaps++
    }
  }
  return { crossings, laneOverlaps }
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  )
}

function nodeOverlapCount(obstacles: Array<Node>): number {
  let n = 0
  for (let i = 0; i < obstacles.length; i++)
    for (let j = i + 1; j < obstacles.length; j++)
      if (rectsOverlap(obstacles[i].rect, obstacles[j].rect)) n++
  return n
}

// Proper intersections between two strokes.
function strokeCrossings(a: Array<Pt>, b: Array<Pt>): number {
  let n = 0
  for (let s = 0; s + 1 < a.length; s++)
    for (let t = 0; t + 1 < b.length; t++)
      if (segsCross([a[s], a[s + 1]], [b[t], b[t + 1]])) n++
  return n
}

function inkCrossingCount(strokes: Array<Array<Pt>>): number {
  let n = 0
  for (let i = 0; i < strokes.length; i++)
    for (let j = i + 1; j < strokes.length; j++)
      n += strokeCrossings(strokes[i], strokes[j])
  return n
}

export function score(L: Layout): Metrics {
  const edgeById = new Map(L.edges.map((e) => [e.id, e]))
  const edgeOf = (id: string) => must(edgeById.get(id), `edge ${id}`)
  const obstacles = L.nodes.filter((n) => n.obstacle)
  let throughNode = 0,
    throughHits = 0,
    bends = 0,
    length = 0
  for (const r of L.routes) {
    const hit = obstacleHits(r.pts, edgeOf(r.edge), obstacles)
    if (hit) throughNode++
    throughHits += hit
    bends += Math.max(0, r.pts.length - 2)
    length = addLength(length, r.pts)
  }
  const { crossings, laneOverlaps } = routePairs(L.routes, edgeOf)
  const nodeOverlaps = nodeOverlapCount(obstacles)
  const all = [...L.sections.map((s) => s.rect), ...L.nodes.map((n) => n.rect)]
  const bx = Math.min(...all.map((r) => r.x)),
    by = Math.min(...all.map((r) => r.y))
  const ex = Math.max(...all.map((r) => r.x + r.w)),
    ey = Math.max(...all.map((r) => r.y + r.h))
  // ink crossings: proper intersections between the strokes actually drawn (a bundled trunk is one stroke)
  const pieces = L.pieces
  const strokes: Array<Array<Pt>> = [
    ...(pieces ?? []).map((p) => p.pts),
    ...L.routes.filter((r) => !pieces || r.native).map((r) => r.pts),
  ]
  const inkCrossings = inkCrossingCount(strokes)
  const inkBends = strokes.reduce((a, p) => a + Math.max(0, p.length - 2), 0)
  const inkLength = Math.round(
    strokes.reduce(
      (a, p) =>
        a
        + p
          .slice(1)
          .reduce(
            (b, q, i) =>
              b + Math.abs(q[0] - p[i][0]) + Math.abs(q[1] - p[i][1]),
            0,
          ),
      0,
    ),
  )
  return {
    edges: L.routes.length,
    inkCrossings,
    strokes: strokes.length,
    inkBends,
    inkLength,
    throughNode,
    throughHits,
    crossings,
    bends,
    length: Math.round(length),
    laneOverlaps,
    nodeOverlaps,
    area: Math.round((((ex - bx) * (ey - by)) / 1e6) * 10) / 10,
  }
}

// Best magnet pair for a native connector given the current layout, by local cost.
// eslint-disable-next-line max-params -- exported signature (engine.ts and bus.ts pass obstacles, other routes and the cross cost)
export function bestMagnets(
  a: Rect,
  b: Rect,
  obstacles: Array<Rect>,
  others: Array<Array<Pt>>,
  crossCost = Number(process.env.LAYOUT_CROSS_COST ?? 800),
): { sa: Side; sb: Side; pts: Array<Pt> } {
  // `cost` plus crossCost for every crossing with another route, added one crossing at a time
  const addCrossings = (cost: number, pts: Array<Pt>): number => {
    let c = cost
    for (const op of others)
      for (let i = 0; i + 1 < pts.length; i++)
        for (let j = 0; j + 1 < op.length; j++)
          if (segsCross([pts[i], pts[i + 1]], [op[j], op[j + 1]]))
            c += crossCost
    return c
  }
  let best: { sa: Side; sb: Side; pts: Array<Pt>; c: number } | undefined
  const [da, db] = autoSides(a, b)
  for (const sa of SIDES)
    for (const sb of SIDES) {
      const pts = nativeElbow(a, sa, b, sb)
      let c = 0
      for (const o of obstacles) if (polylineHitsRect(pts, o)) c += 10000
      c = addCrossings(c, pts)
      // into a node's own box = backwards
      if (
        segHitsRect([pts[0], pts[Math.min(2, pts.length - 1)]], a, 1)
        || segHitsRect([last(pts), pts[Math.max(0, pts.length - 3)]], b, 1)
      )
        c += 5000
      for (let i = 0; i + 1 < pts.length; i++)
        c +=
          Math.abs(pts[i + 1][0] - pts[i][0])
          + Math.abs(pts[i + 1][1] - pts[i][1])
      c += (pts.length - 2) * 60
      if (sa === da && sb === db) c -= 40 // prefer FigJam's own choice on ties
      if (!best || c < best.c) best = { sa, sb, pts, c }
    }
  return must(best, "magnet pair")
}
