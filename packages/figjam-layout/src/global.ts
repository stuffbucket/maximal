// Global routing stage (before lanes): a PathFinder-style negotiated-congestion router over 80px
// gcells. It decides each edge's coarse path, which card sides its ends use, where it passes
// section walls, and which edges become name tags instead of wires. lanes.ts then does the
// detailed routing inside those corridors.
import { sectionOf } from "./engine"
import {
  center,
  must,
  type Edge,
  type Layout,
  type Node,
  type Rect,
  type Side,
} from "./model"

export const G = 80 // gcell size: cards and sections sit on this grid in the map
const DX = [1, -1, 0, 0]
const DY = [0, 0, 1, -1]
const SIDE_OF_DIR: Array<Side> = ["RIGHT", "LEFT", "BOTTOM", "TOP"] // leaving a card in direction d

export type GlobalOpts = {
  tagRatio?: number
  tagMinDist?: number
  iterations?: number
  bend?: number
  cross?: number
  wall?: number
  share?: number
  tagged?: Set<string>
}
export type Window = {
  s: string
  side: Side
  lo: number
  hi: number
  pair: string
  bundles: Array<string>
}
export type GlobalPlan = {
  g: number
  gx0: number
  gy0: number
  gnx: number
  gny: number
  bbox: Rect
  paths: Map<string, Array<number>> // edge id → gcell indices
  sides: Map<string, [Side, Side]> // edge id → [source side, target side]
  tagged: Set<string> // edges drawn as name tags, not wires
  ratio: Map<string, number> // edge id → global path length / Manhattan distance
  windows: Array<Window>
  overflow: number
  iterations: number
}

class Heap {
  k: Array<number> = []
  v: Array<number> = []
  push(key: number, val: number) {
    let i = this.k.length
    this.k.push(key)
    this.v.push(val)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.k[p] <= key) break
      this.k[i] = this.k[p]
      this.v[i] = this.v[p]
      i = p
    }
    this.k[i] = key
    this.v[i] = val
  }
  pop(): number {
    const top = this.v[0],
      lk = must(this.k.pop(), "heap key"),
      lv = must(this.v.pop(), "heap value")
    if (this.k.length > 0) {
      let i = 0
      const n = this.k.length
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && this.k[c + 1] < this.k[c]) c++
        if (this.k[c] >= lk) break
        this.k[i] = this.k[c]
        this.v[i] = this.v[c]
        i = c
      }
      this.k[i] = lk
      this.v[i] = lv
    }
    return top
  }
  get size() {
    return this.k.length
  }
}

export const bundleKey = (L: Layout, e: Edge) => {
  const [a, b] = sectionOf(L, e)
  return a && b && a !== b ?
      `${[a, b].sort().join("|")}|${e.kind}`
    : `e|${e.id}`
}
export const manhattan = (a: Rect, b: Rect) => {
  const p = center(a),
    q = center(b)
  return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1])
}

// The gcell lattice over the sections' bounding box: which cells are blocked, which card a cell
// belongs to, which section covers it, and its capacity per direction (0 = horizontal, 1 = vertical).
type Grid = {
  bbox: Rect
  gx0: number
  gy0: number
  gnx: number
  gny: number
  nc: number
  blocked: Uint8Array
  cardOf: Map<number, string>
  secOf: Int32Array
  cap: [Uint8Array, Uint8Array]
}

// A free cell next to a card, with the direction a path leaves the card in.
type Terminal = { c: number; d: number }

const cellX = (grid: Grid, c: number) => grid.gx0 + (c % grid.gnx) * G
const cellY = (grid: Grid, c: number) => grid.gy0 + Math.floor(c / grid.gnx) * G
const coversCell = (grid: Grid, r: Rect, c: number) =>
  cellX(grid, c) >= r.x
  && cellX(grid, c) + G <= r.x + r.w
  && cellY(grid, c) >= r.y
  && cellY(grid, c) + G <= r.y + r.h
const touchesCell = (grid: Grid, r: Rect, c: number) =>
  cellX(grid, c) < r.x + r.w
  && cellX(grid, c) + G > r.x
  && cellY(grid, c) < r.y + r.h
  && cellY(grid, c) + G > r.y

// The empty lattice. The routing area is the sections' bounding box: nothing may wrap around the
// outside.
function emptyGrid(L: Layout): Grid {
  const rs = [...L.sections.map((s) => s.rect), ...(L.blocks ?? [])]
  const bx0 = Math.min(...rs.map((r) => r.x)),
    by0 = Math.min(...rs.map((r) => r.y))
  const bx1 = Math.max(...rs.map((r) => r.x + r.w)),
    by1 = Math.max(...rs.map((r) => r.y + r.h))
  const gx0 = Math.floor(bx0 / G) * G,
    gy0 = Math.floor(by0 / G) * G
  const gnx = Math.ceil((bx1 - gx0) / G),
    gny = Math.ceil((by1 - gy0) / G)
  const nc = gnx * gny
  return {
    bbox: { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 },
    gx0,
    gy0,
    gnx,
    gny,
    nc,
    blocked: new Uint8Array(nc),
    cardOf: new Map<number, string>(),
    secOf: new Int32Array(nc).fill(-1),
    cap: [new Uint8Array(nc).fill(4), new Uint8Array(nc).fill(4)],
  }
}

// Each cell's section, and the blocked cells: cards, no-go blocks and section title pills
// (top-left of each section).
function markBlocked(grid: Grid, L: Layout): void {
  const { nc, blocked } = grid
  for (const [i, s] of L.sections.entries()) {
    for (let c = 0; c < nc; c++)
      if (coversCell(grid, s.rect, c)) grid.secOf[c] = i
  }
  for (const n of L.nodes)
    for (let c = 0; c < nc; c++)
      if (touchesCell(grid, n.rect, c)) {
        blocked[c] = 1
        if (n.obstacle) grid.cardOf.set(c, n.id)
      }
  for (const b of L.blocks ?? [])
    for (let c = 0; c < nc; c++) if (touchesCell(grid, b, c)) blocked[c] = 1
  for (const s of L.sections) {
    const t = {
      x: s.rect.x,
      y: s.rect.y,
      w: Math.min(s.rect.w, 48 + s.name.length * 15),
      h: 64,
    }
    for (let c = 0; c < nc; c++) if (touchesCell(grid, t, c)) blocked[c] = 1
  }
}

// capacity per cell and direction (0 = horizontal, 1 = vertical): 4 lattice lines, fewer next to
// cards (their 20/40px rings are stub-only), 3 in the narrow 80px gaps between two cards
function setCapacities(grid: Grid): void {
  const { nc, gnx, blocked, cap } = grid
  const isCard = (c: number) => c >= 0 && c < nc && grid.cardOf.has(c)
  for (let c = 0; c < nc; c++) {
    if (blocked[c]) {
      cap[0][c] = cap[1][c] = 0
      continue
    }
    const i = c % gnx
    const up = c - gnx,
      dn = c + gnx,
      lf = i > 0 ? c - 1 : -1,
      rt = i < gnx - 1 ? c + 1 : -1
    if (isCard(up) || isCard(dn)) cap[0][c] = 2
    if (isCard(lf) && isCard(rt)) cap[1][c] = 3
    else if (isCard(lf) || isCard(rt)) cap[1][c] = 2
  }
}

function buildGrid(L: Layout): Grid {
  const grid = emptyGrid(L)
  markBlocked(grid, L)
  setCapacities(grid)
  return grid
}

// Shapes whose top/bottom terminals are limited: hexagons/chevrons/ellipses only take the flat
// top/bottom and the middle of the pointed sides; rounded cards keep clear of the corner radius.
const SHAPED = new Set([
  "HEXAGON",
  "CHEVRON",
  "ELLIPSE",
  "ROUNDED_RECTANGLE",
  "",
])

// How far in from a card's left and right edge its top/bottom terminals may start.
function sideInsets(shape: string, r: Rect): [number, number] {
  if (shape === "HEXAGON") return [r.w * 0.14, r.w * 0.14]
  if (shape === "CHEVRON") return [0, r.w * 0.12]
  if (shape === "ROUNDED_RECTANGLE" || shape === "")
    return [r.h / 2 + 16, r.h / 2 + 16]
  return [r.w / 2 - G / 2, r.w / 2 - G / 2]
}

// The section wall a step of `d` cells (outside − inside) passes through.
function wallSide(d: number): Side {
  if (d === 1) return "RIGHT"
  if (d === -1) return "LEFT"
  return d > 0 ? "BOTTOM" : "TOP"
}

type Costs = { bend: number; cross: number; wall: number; share: number }
type WallCrossings = {
  s: string
  side: Side
  at: Array<number>
  pair: string
  bundles: Set<string>
}
type Usage = Map<number, Map<number, number>>

// Negotiated-congestion state: per cell and direction, how many paths of each bundle use it (a
// bundle counts once), the history cost, the present-overflow factor, and each net's current path.
class PathFinder {
  readonly paths = new Map<string, Array<number>>()
  readonly sides = new Map<string, [Side, Side]>()
  private readonly L: Layout
  private readonly grid: Grid
  private readonly costs: Costs
  private readonly nodes: Map<string, Node>
  private readonly bk = new Map<string, string>()
  private readonly bundleIdx = new Map<string, number>()
  private readonly use: [Usage, Usage] = [
    new Map<number, Map<number, number>>(),
    new Map<number, Map<number, number>>(),
  ]
  private readonly hist: [Float32Array, Float32Array]
  private readonly termCache = new Map<string, Array<Terminal>>()
  private pf = 0.5

  constructor(L: Layout, grid: Grid, costs: Costs) {
    this.L = L
    this.grid = grid
    this.costs = costs
    this.nodes = new Map(L.nodes.map((n) => [n.id, n]))
    this.hist = [new Float32Array(grid.nc), new Float32Array(grid.nc)]
  }

  // the nets: edges between two cards, each in its bundle (same family pair and kind)
  setNets(edges: Array<Edge>): void {
    for (const e of edges) this.bk.set(e.id, bundleKey(this.L, e))
    const bundles = [...new Set(this.bk.values())]
    const bIdx = new Map(bundles.map((b, i) => [b, i]))
    for (const [id, key] of this.bk)
      this.bundleIdx.set(id, must(bIdx.get(key), `bundle ${key}`))
  }

  card(id: string): Node {
    return must(this.nodes.get(id), `card ${id}`)
  }

  // Rip up and reroute every untagged net, until nothing overflows or after `iters` rounds.
  run(
    order: Array<Edge>,
    tagged: Set<string>,
    iters: number,
  ): { overflow: number; it: number } {
    let overflow = 0,
      it = 0
    for (; it < iters; it++) {
      for (const e of order) if (!tagged.has(e.id)) this.reroute(e)
      overflow = this.chargeOverflow()
      if (!overflow) break
      this.pf *= 1.7
    }
    return { overflow, it }
  }

  // Take the tagged nets off the grid.
  drop(tagged: Set<string>): void {
    for (const id of tagged) {
      const p = this.paths.get(id)
      if (p) this.add(p, this.bundle(id), -1)
      this.paths.delete(id)
      this.sides.delete(id)
    }
  }

  // windows: where each family pair's coarse paths cross each section wall
  windows(edges: Array<Edge>, tagged: Set<string>): Array<Window> {
    const crossings = new Map<string, WallCrossings>()
    for (const e of edges) {
      const p = this.paths.get(e.id)
      if (!p || tagged.has(e.id)) continue
      const [a, b] = sectionOf(this.L, e)
      if (!a || !b || a === b) continue
      const pair = [a, b].sort().join("|")
      this.addWallCrossings(crossings, p, {
        pair,
        bundle: must(this.bk.get(e.id), `bundle key of ${e.id}`),
      })
    }
    return [...crossings.values()].map((w) => {
      w.at.sort((x, y) => x - y)
      const mid = w.at[Math.floor(w.at.length / 2)]
      const width = (w.bundles.size + 2) * 20
      const lo = Math.round((mid - width / 2) / 20) * 20
      return {
        s: w.s,
        side: w.side,
        lo,
        hi: lo + width,
        pair: w.pair,
        bundles: [...w.bundles],
      }
    })
  }

  // Record every section wall the coarse path p passes, on both sides of the wall.
  private addWallCrossings(
    crossings: Map<string, WallCrossings>,
    p: Array<number>,
    net: { pair: string; bundle: string },
  ): void {
    const { grid } = this
    const { pair } = net
    for (let i = 1; i < p.length; i++) {
      const s0 = grid.secOf[p[i - 1]],
        s1 = grid.secOf[p[i]]
      if (s0 === s1) continue
      for (const [si, inside, outside] of [
        [s0, p[i - 1], p[i]],
        [s1, p[i], p[i - 1]],
      ] as Array<[number, number, number]>) {
        if (si < 0) continue
        const s = this.L.sections[si]
        const side = wallSide(outside - inside)
        const coord =
          side === "TOP" || side === "BOTTOM" ?
            cellX(grid, inside) + G / 2
          : cellY(grid, inside) + G / 2
        const k = `${s.id}|${side}|${pair}`
        const w = crossings.get(k) ?? {
          s: s.id,
          side,
          at: [],
          pair,
          bundles: new Set(),
        }
        w.at.push(coord)
        w.bundles.add(net.bundle)
        crossings.set(k, w)
      }
    }
  }

  private bundle(id: string): number {
    return must(this.bundleIdx.get(id), `bundle of ${id}`)
  }

  private occ(axis: number, c: number): number {
    return this.use[axis].get(c)?.size ?? 0
  }

  private add(path: Array<number>, b: number, sign: 1 | -1): void {
    for (let i = 0; i < path.length; i++) {
      const c = path[i]
      const axes = new Set<number>()
      if (i > 0) axes.add(Math.abs(path[i] - path[i - 1]) === 1 ? 0 : 1)
      if (i + 1 < path.length)
        axes.add(Math.abs(path[i + 1] - path[i]) === 1 ? 0 : 1)
      for (const a of axes) {
        let mp = this.use[a].get(c)
        if (!mp) {
          mp = new Map()
          this.use[a].set(c, mp)
        }
        const v = (mp.get(b) ?? 0) + sign
        if (v <= 0) mp.delete(b)
        else mp.set(b, v)
      }
    }
  }

  private reroute(e: Edge): void {
    const b = this.bundle(e.id)
    const old = this.paths.get(e.id)
    if (old) this.add(old, b, -1)
    const r = this.route(e)
    if (!r) {
      if (old) this.add(old, b, 1)
      return
    }
    this.paths.set(e.id, r.path)
    this.sides.set(e.id, [SIDE_OF_DIR[r.s], SIDE_OF_DIR[r.t]])
    this.add(r.path, b, 1)
  }

  // Total overflow over every cell and direction; each overflowing cell's history cost grows.
  private chargeOverflow(): number {
    let overflow = 0
    for (const a of [0, 1])
      for (const [c, mp] of this.use[a]) {
        const o = Math.max(0, mp.size - this.grid.cap[a][c])
        if (o) {
          overflow += o
          this.hist[a][c] += o * 0.5
        }
      }
    return overflow
  }

  // terminals: free cells next to a card, with the side they leave from
  private terminals(id: string): Array<Terminal> {
    const { grid } = this
    const { gnx, gny } = grid
    const n = this.card(id)
    const r = n.rect
    const out: Array<Terminal> = []
    for (let c = 0; c < grid.nc; c++) {
      if (grid.blocked[c]) continue
      for (let d = 0; d < 4; d++) {
        const i = c % gnx,
          j = Math.floor(c / gnx)
        const pi = i - DX[d],
          pj = j - DY[d]
        if (pi < 0 || pi >= gnx || pj < 0 || pj >= gny) continue
        if (grid.cardOf.get(pj * gnx + pi) === id) out.push({ c, d })
      }
    }
    const shape = n.style?.shape ?? ""
    if (!SHAPED.has(shape)) return out
    const my = r.y + r.h / 2
    const [li, ri] = sideInsets(shape, r)
    return out.filter(({ c, d }) =>
      d >= 2 ?
        cellX(grid, c) >= r.x + li - 1
        && cellX(grid, c) + G <= r.x + r.w - ri + 1
      : cellY(grid, c) <= my && cellY(grid, c) + G > my,
    )
  }

  private term(id: string): Array<Terminal> {
    let t = this.termCache.get(id)
    if (!t) {
      t = this.terminals(id)
      this.termCache.set(id, t)
    }
    return t
  }

  // The cell one step from c in direction nd, or -1 when that is off the grid or blocked.
  private neighbour(c: number, nd: number): number {
    const { gnx, gny } = this.grid
    const i = c % gnx,
      j = Math.floor(c / gnx)
    const ni = i + DX[nd],
      nj = j + DY[nd]
    if (ni < 0 || ni >= gnx || nj < 0 || nj >= gny) return -1
    const q = nj * gnx + ni
    return this.grid.blocked[q] ? -1 : q
  }

  // Cost of the step from search state st to state ns (state = cell × 4 + direction) for bundle
  // b: (1 + history) × (1 + present × overflow), discounted on cells its own bundle already uses,
  // plus a bend, a section-wall pass, and each other bundle crossed.
  private stepCost(st: number, ns: number, b: number): number {
    const { grid, use, hist, costs } = this
    const c = st >> 2,
      d = st & 3,
      q = ns >> 2,
      nd = ns & 3
    const axis = nd < 2 ? 0 : 1
    const mine = use[axis].get(q)?.has(b)
    const over = Math.max(
      0,
      this.occ(axis, q) + (mine ? 0 : 1) - grid.cap[axis][q],
    )
    let cost =
      (mine ? costs.share : 1) * (1 + hist[axis][q]) * (1 + this.pf * over)
    if (nd !== d) cost += costs.bend
    if (grid.secOf[q] !== grid.secOf[c]) cost += costs.wall // passing a section wall (a door)
    const perp = use[1 - axis].get(q)
    if (perp) for (const ob of perp.keys()) if (ob !== b) cost += costs.cross
    return cost
  }

  // A* over (cell, direction) states from the source card's terminals to the target card's.
  private route(
    e: Edge,
  ): { path: Array<number>; s: number; t: number; cost: number } | undefined {
    const { grid, costs } = this
    const b = this.bundle(e.id)
    const src = this.term(e.from),
      dst = this.term(e.to)
    const goal = new Map<number, number>() // cell → direction we must arrive moving (toward the card)
    for (const t of dst) goal.set(t.c, t.d ^ 1)
    const T = this.card(e.to).rect
    const h = (c: number) =>
      ((Math.max(0, T.x - G - cellX(grid, c), cellX(grid, c) - T.x - T.w)
        + Math.max(0, T.y - G - cellY(grid, c), cellY(grid, c) - T.y - T.h))
        / G)
      * costs.share
    const S = grid.nc * 4
    const g = new Float32Array(S).fill(Infinity),
      from = new Int32Array(S).fill(-1)
    const heap = new Heap()
    for (const s of src) {
      const st = s.c * 4 + s.d
      g[st] = 0
      heap.push(h(s.c), st)
    }
    let end = -1
    while (heap.size > 0) {
      const st = heap.pop(),
        c = st >> 2,
        d = st & 3
      if (goal.has(c) && goal.get(c) === d) {
        end = st
        break
      }
      const gs = g[st]
      for (const nd of [d, d < 2 ? 2 : 0, d < 2 ? 3 : 1]) {
        const q = this.neighbour(c, nd)
        if (q < 0) continue
        const ns = q * 4 + nd,
          ng = gs + this.stepCost(st, ns, b)
        if (ng < g[ns]) {
          g[ns] = ng
          from[ns] = st
          heap.push(ng + h(q), ns)
        }
      }
    }
    if (end < 0) return undefined
    const path: Array<number> = []
    let st = end,
      first = end
    while (st >= 0) {
      path.push(st >> 2)
      first = st
      st = from[st]
    }
    path.reverse()
    return { path, s: first & 3, t: (end & 3) ^ 1, cost: g[end] }
  }
}

export function globalPlan(L: Layout, opts: GlobalOpts = {}): GlobalPlan {
  const costs: Costs = {
    bend: opts.bend ?? 3,
    cross: opts.cross ?? 4,
    wall: opts.wall ?? 3,
    share: opts.share ?? 0.25,
  }
  const grid = buildGrid(L)
  const router = new PathFinder(L, grid, costs)
  const m = new Map(L.nodes.map((n) => [n.id, n]))
  const edges = L.edges.filter(
    (e) => m.get(e.from)?.obstacle && m.get(e.to)?.obstacle,
  )
  router.setNets(edges)
  const tagged = new Set<string>(opts.tagged ?? [])
  const tagRatio = opts.tagRatio ?? 2.5,
    tagMin = opts.tagMinDist ?? 1200
  const ratio = new Map<string, number>()
  const span = (e: Edge) =>
    manhattan(router.card(e.from).rect, router.card(e.to).rect)
  // nearest first: short edges take the inner tracks
  const order = [...edges].sort((p, q) => span(p) - span(q))
  let res = router.run(order, tagged, opts.iterations ?? 14)
  // name tags: edges whose coarse path is a long detour become link pills at both ends
  for (const e of edges) {
    const p = router.paths.get(e.id)
    if (!p) {
      tagged.add(e.id)
      continue
    }
    const d = span(e)
    const r = (p.length * G) / Math.max(G, d)
    ratio.set(e.id, r)
    if (r > tagRatio && d >= tagMin) tagged.add(e.id)
  }
  if (tagged.size > 0) {
    router.drop(tagged)
    res = router.run(order, tagged, opts.iterations ?? 14)
  }
  return {
    g: G,
    gx0: grid.gx0,
    gy0: grid.gy0,
    gnx: grid.gnx,
    gny: grid.gny,
    bbox: grid.bbox,
    paths: router.paths,
    sides: router.sides,
    tagged,
    ratio,
    windows: router.windows(edges, tagged),
    overflow: res.overflow,
    iterations: res.it,
  }
}

type Box = { x0: number; x1: number; y0: number; y1: number }

// p spans q horizontally while q spans p vertically
const plus = (p: Box, q: Box) =>
  p.x0 < q.x0 && p.x1 > q.x1 && q.y0 < p.y0 && q.y1 > p.y1

// Crossings forced by placement if no route detours: two edges whose endpoint boxes cross in a
// "plus" (one box spans the other horizontally, the other spans it vertically) must cross when both
// take monotone (shortest Manhattan) paths. Counted once per pair of bundles.
export function monotoneLowerBound(
  L: Layout,
  skip: Set<string> = new Set(),
): number {
  const m = new Map(L.nodes.map((n) => [n.id, n]))
  const es = L.edges.filter(
    (e) => !skip.has(e.id) && m.get(e.from)?.obstacle && m.get(e.to)?.obstacle,
  )
  const box = (e: Edge): Box => {
    const a = center(must(m.get(e.from), `card ${e.from}`).rect),
      b = center(must(m.get(e.to), `card ${e.to}`).rect)
    return {
      x0: Math.min(a[0], b[0]),
      x1: Math.max(a[0], b[0]),
      y0: Math.min(a[1], b[1]),
      y1: Math.max(a[1], b[1]),
    }
  }
  const forced = new Set<string>()
  for (let i = 0; i < es.length; i++)
    for (let j = i + 1; j < es.length; j++) {
      const A = es[i],
        B = es[j]
      const ka = bundleKey(L, A),
        kb = bundleKey(L, B)
      if (ka === kb || [A.from, A.to].some((x) => x === B.from || x === B.to))
        continue
      const a = box(A),
        b = box(B)
      if (plus(a, b) || plus(b, a)) forced.add([ka, kb].sort().join("#"))
    }
  return forced.size
}

export { type Pt } from "./model"
