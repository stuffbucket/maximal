// Global routing stage (before lanes): a PathFinder-style negotiated-congestion router over 80px
// gcells. It decides each edge's coarse path, which card sides its ends use, where it passes
// section walls, and which edges become name tags instead of wires. lanes.ts then does the
// detailed routing inside those corridors.
import { sectionOf } from "./engine.ts"
import { center, type Edge, type Layout, type Pt, type Rect, type Side } from "./model.ts"

export const G = 80 // gcell size: cards and sections sit on this grid in the map
const DX = [1, -1, 0, 0]
const DY = [0, 0, 1, -1]
const SIDE_OF_DIR: Side[] = ["RIGHT", "LEFT", "BOTTOM", "TOP"] // leaving a card in direction d

export type GlobalOpts = { tagRatio?: number; tagMinDist?: number; iterations?: number; bend?: number; cross?: number; wall?: number; share?: number; tagged?: Set<string> }
export type Window = { s: string; side: Side; lo: number; hi: number; pair: string; bundles: string[] }
export type GlobalPlan = {
  g: number; gx0: number; gy0: number; gnx: number; gny: number
  bbox: Rect
  paths: Map<string, number[]> // edge id → gcell indices
  sides: Map<string, [Side, Side]> // edge id → [source side, target side]
  tagged: Set<string> // edges drawn as name tags, not wires
  ratio: Map<string, number> // edge id → global path length / Manhattan distance
  windows: Window[]
  overflow: number
  iterations: number
}

class Heap {
  k: number[] = []
  v: number[] = []
  push(key: number, val: number) {
    let i = this.k.length
    this.k.push(key); this.v.push(val)
    while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= key) break; this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p }
    this.k[i] = key; this.v[i] = val
  }
  pop(): number {
    const top = this.v[0], lk = this.k.pop()!, lv = this.v.pop()!
    if (this.k.length) {
      let i = 0
      const n = this.k.length
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && this.k[c + 1] < this.k[c]) c++; if (this.k[c] >= lk) break; this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c }
      this.k[i] = lk; this.v[i] = lv
    }
    return top
  }
  get size() { return this.k.length }
}

export const bundleKey = (L: Layout, e: Edge) => { const [a, b] = sectionOf(L, e); return a && b && a !== b ? `${[a, b].sort().join("|")}|${e.kind}` : `e|${e.id}` }
export const manhattan = (a: Rect, b: Rect) => { const p = center(a), q = center(b); return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) }

export function globalPlan(L: Layout, opts: GlobalOpts = {}): GlobalPlan {
  const BEND = opts.bend ?? 3, CROSS = opts.cross ?? 4, WALL = opts.wall ?? 3, SHARE = opts.share ?? 0.25
  const m = new Map(L.nodes.map((n) => [n.id, n]))
  // the routing area is the sections' bounding box: nothing may wrap around the outside
  const rs = [...L.sections.map((s) => s.rect), ...(L.blocks ?? [])]
  const bx0 = Math.min(...rs.map((r) => r.x)), by0 = Math.min(...rs.map((r) => r.y))
  const bx1 = Math.max(...rs.map((r) => r.x + r.w)), by1 = Math.max(...rs.map((r) => r.y + r.h))
  const gx0 = Math.floor(bx0 / G) * G, gy0 = Math.floor(by0 / G) * G
  const gnx = Math.ceil((bx1 - gx0) / G), gny = Math.ceil((by1 - gy0) / G)
  const NC = gnx * gny
  const cx = (c: number) => gx0 + (c % gnx) * G, cy = (c: number) => gy0 + Math.floor(c / gnx) * G
  const cellAt = (x: number, y: number) => Math.floor((y - gy0) / G) * gnx + Math.floor((x - gx0) / G)
  const covers = (r: Rect, c: number, pad = 0) => cx(c) >= r.x - pad && cx(c) + G <= r.x + r.w + pad && cy(c) >= r.y - pad && cy(c) + G <= r.y + r.h + pad
  const touches = (r: Rect, c: number) => cx(c) < r.x + r.w && cx(c) + G > r.x && cy(c) < r.y + r.h && cy(c) + G > r.y
  const blocked = new Uint8Array(NC)
  const cardOf = new Map<number, string>()
  const secOf = new Int32Array(NC).fill(-1)
  L.sections.forEach((s, i) => { for (let c = 0; c < NC; c++) if (covers(s.rect, c)) secOf[c] = i })
  for (const n of L.nodes) for (let c = 0; c < NC; c++) if (touches(n.rect, c)) { blocked[c] = 1; if (n.obstacle) cardOf.set(c, n.id) }
  for (const b of L.blocks ?? []) for (let c = 0; c < NC; c++) if (touches(b, c)) blocked[c] = 1
  // section title pills (top-left of each section)
  for (const s of L.sections) { const t = { x: s.rect.x, y: s.rect.y, w: Math.min(s.rect.w, 48 + s.name.length * 15), h: 64 }; for (let c = 0; c < NC; c++) if (touches(t, c)) blocked[c] = 1 }
  // capacity per cell and direction (0 = horizontal, 1 = vertical): 4 lattice lines, fewer next to
  // cards (their 20/40px rings are stub-only), 3 in the narrow 80px gaps between two cards
  const cap = [new Uint8Array(NC).fill(4), new Uint8Array(NC).fill(4)]
  const isCard = (c: number) => c >= 0 && c < NC && cardOf.has(c)
  for (let c = 0; c < NC; c++) {
    if (blocked[c]) { cap[0][c] = cap[1][c] = 0; continue }
    const i = c % gnx
    const up = c - gnx, dn = c + gnx, lf = i > 0 ? c - 1 : -1, rt = i < gnx - 1 ? c + 1 : -1
    if (isCard(up) || isCard(dn)) cap[0][c] = 2
    if (isCard(lf) && isCard(rt)) cap[1][c] = 3
    else if (isCard(lf) || isCard(rt)) cap[1][c] = 2
  }

  // ---- nets ----
  const edges = L.edges.filter((e) => m.get(e.from)?.obstacle && m.get(e.to)?.obstacle)
  const bk = new Map(edges.map((e) => [e.id, bundleKey(L, e)]))
  const bundles = [...new Set(bk.values())]
  const bIdx = new Map(bundles.map((b, i) => [b, i]))
  const NB = bundles.length
  // usage: per cell+direction, how many paths of each bundle use it (a bundle counts once)
  const use = [new Map<number, Map<number, number>>(), new Map<number, Map<number, number>>()]
  const occ = (axis: number, c: number) => use[axis].get(c)?.size ?? 0
  const hist = [new Float32Array(NC), new Float32Array(NC)]
  const add = (path: number[], b: number, sign: 1 | -1) => {
    for (let i = 0; i < path.length; i++) {
      const c = path[i]
      const axes = new Set<number>()
      if (i > 0) axes.add(Math.abs(path[i] - path[i - 1]) === 1 ? 0 : 1)
      if (i + 1 < path.length) axes.add(Math.abs(path[i + 1] - path[i]) === 1 ? 0 : 1)
      for (const a of axes) {
        let mp = use[a].get(c)
        if (!mp) { mp = new Map(); use[a].set(c, mp) }
        const v = (mp.get(b) ?? 0) + sign
        if (v <= 0) mp.delete(b); else mp.set(b, v)
      }
    }
  }
  // terminals: free cells next to a card, with the side they leave from
  const terminals = (id: string): { c: number; d: number }[] => {
    const r = m.get(id)!.rect
    const out: { c: number; d: number }[] = []
    for (let c = 0; c < NC; c++) {
      if (blocked[c]) continue
      for (let d = 0; d < 4; d++) {
        const i = c % gnx, j = Math.floor(c / gnx)
        const pi = i - DX[d], pj = j - DY[d]
        if (pi < 0 || pi >= gnx || pj < 0 || pj >= gny) continue
        if (cardOf.get(pj * gnx + pi) === id) out.push({ c, d })
      }
    }
    // hexagons/chevrons/ellipses: only the flat top/bottom and the middle of the pointed sides
    const shape = String(m.get(id)!.style?.shape ?? "")
    const rounded = shape === "ROUNDED_RECTANGLE" || shape === ""
    if (shape === "HEXAGON" || shape === "CHEVRON" || shape === "ELLIPSE" || rounded) {
      const my = r.y + r.h / 2
      const li = shape === "HEXAGON" ? r.w * 0.14 : shape === "CHEVRON" ? 0 : rounded ? r.h / 2 + 16 : r.w / 2 - G / 2
      const ri = shape === "HEXAGON" ? r.w * 0.14 : shape === "CHEVRON" ? r.w * 0.12 : rounded ? r.h / 2 + 16 : r.w / 2 - G / 2
      return out.filter(({ c, d }) => (d >= 2 ? cx(c) >= r.x + li - 1 && cx(c) + G <= r.x + r.w - ri + 1 : cy(c) <= my && cy(c) + G > my))
    }
    return out
  }
  const termCache = new Map<string, { c: number; d: number }[]>()
  const term = (id: string) => { if (!termCache.has(id)) termCache.set(id, terminals(id)); return termCache.get(id)! }

  let pf = 0.5
  const route = (e: Edge): { path: number[]; s: number; t: number; cost: number } | undefined => {
    const b = bIdx.get(bk.get(e.id)!)!
    const src = term(e.from), dst = term(e.to)
    const goal = new Map<number, number>() // cell → direction we must arrive moving (toward the card)
    for (const t of dst) goal.set(t.c, t.d ^ 1)
    const T = m.get(e.to)!.rect
    const h = (c: number) => (Math.max(0, T.x - G - cx(c), cx(c) - T.x - T.w) + Math.max(0, T.y - G - cy(c), cy(c) - T.y - T.h)) / G * SHARE
    const S = NC * 4
    const g = new Float32Array(S).fill(Infinity), from = new Int32Array(S).fill(-1)
    const heap = new Heap()
    for (const s of src) { const st = s.c * 4 + s.d; g[st] = 0; heap.push(h(s.c), st) }
    let end = -1
    while (heap.size) {
      const st = heap.pop(), c = st >> 2, d = st & 3
      if (goal.has(c) && goal.get(c) === d) { end = st; break }
      const gs = g[st]
      for (const nd of [d, d < 2 ? 2 : 0, d < 2 ? 3 : 1]) {
        const i = c % gnx, j = Math.floor(c / gnx)
        const ni = i + DX[nd], nj = j + DY[nd]
        if (ni < 0 || ni >= gnx || nj < 0 || nj >= gny) continue
        const q = nj * gnx + ni
        if (blocked[q]) continue
        const axis = nd < 2 ? 0 : 1
        const mine = use[axis].get(q)?.has(b)
        const over = Math.max(0, occ(axis, q) + (mine ? 0 : 1) - cap[axis][q])
        let cost = (mine ? SHARE : 1) * (1 + hist[axis][q]) * (1 + pf * over)
        if (nd !== d) cost += BEND
        if (secOf[q] !== secOf[c]) cost += WALL // passing a section wall (a door)
        const perp = use[1 - axis].get(q)
        if (perp) for (const ob of perp.keys()) if (ob !== b) cost += CROSS
        const ns = q * 4 + nd, ng = gs + cost
        if (ng < g[ns]) { g[ns] = ng; from[ns] = st; heap.push(ng + h(q), ns) }
      }
    }
    if (end < 0) return undefined
    const path: number[] = []
    let st = end, first = end
    while (st >= 0) { path.push(st >> 2); first = st; st = from[st] }
    path.reverse()
    return { path, s: first & 3, t: (end & 3) ^ 1, cost: g[end] }
  }

  const tagged = new Set<string>(opts.tagged ?? [])
  const tagRatio = opts.tagRatio ?? 2.5, tagMin = opts.tagMinDist ?? 1200
  const paths = new Map<string, number[]>(), sides = new Map<string, [Side, Side]>(), ratio = new Map<string, number>()
  // nearest first: short edges take the inner tracks
  const order = [...edges].sort((p, q) => manhattan(m.get(p.from)!.rect, m.get(p.to)!.rect) - manhattan(m.get(q.from)!.rect, m.get(q.to)!.rect))
  const runPathFinder = (iters: number) => {
    let overflow = 0, it = 0
    for (it = 0; it < iters; it++) {
      for (const e of order) {
        if (tagged.has(e.id)) continue
        const b = bIdx.get(bk.get(e.id)!)!
        const old = paths.get(e.id)
        if (old) add(old, b, -1)
        const r = route(e)
        if (!r) { if (old) add(old, b, 1); continue }
        paths.set(e.id, r.path)
        sides.set(e.id, [SIDE_OF_DIR[r.s], SIDE_OF_DIR[r.t]])
        add(r.path, b, 1)
      }
      overflow = 0
      for (const a of [0, 1]) for (const [c, mp] of use[a]) { const o = Math.max(0, mp.size - cap[a][c]); if (o) { overflow += o; hist[a][c] += o * 0.5 } }
      if (!overflow) break
      pf *= 1.7
    }
    return { overflow, it }
  }
  let res = runPathFinder(opts.iterations ?? 14)
  // name tags: edges whose coarse path is a long detour become link pills at both ends
  for (const e of edges) {
    const p = paths.get(e.id)
    if (!p) { tagged.add(e.id); continue }
    const d = manhattan(m.get(e.from)!.rect, m.get(e.to)!.rect)
    const r = (p.length * G) / Math.max(G, d)
    ratio.set(e.id, r)
    if (r > tagRatio && d >= tagMin) tagged.add(e.id)
  }
  if (tagged.size) {
    for (const id of tagged) { const p = paths.get(id); if (p) add(p, bIdx.get(bk.get(id)!)!, -1); paths.delete(id); sides.delete(id) }
    res = runPathFinder(opts.iterations ?? 14)
  }

  // windows: where each family pair's coarse paths cross each section wall
  const crossings = new Map<string, { s: string; side: Side; at: number[]; pair: string; bundles: Set<string> }>()
  for (const e of edges) {
    const p = paths.get(e.id)
    if (!p || tagged.has(e.id)) continue
    const [a, b] = sectionOf(L, e)
    if (!a || !b || a === b) continue
    const pair = [a, b].sort().join("|")
    for (let i = 1; i < p.length; i++) {
      const s0 = secOf[p[i - 1]], s1 = secOf[p[i]]
      if (s0 === s1) continue
      for (const [si, inside, outside] of [[s0, p[i - 1], p[i]], [s1, p[i], p[i - 1]]] as [number, number, number][]) {
        if (si < 0) continue
        const s = L.sections[si]
        const d = outside - inside
        const side: Side = d === 1 ? "RIGHT" : d === -1 ? "LEFT" : d > 0 ? "BOTTOM" : "TOP"
        const coord = side === "TOP" || side === "BOTTOM" ? cx(inside) + G / 2 : cy(inside) + G / 2
        const k = `${s.id}|${side}|${pair}`
        const w = crossings.get(k) ?? { s: s.id, side, at: [], pair, bundles: new Set() }
        w.at.push(coord); w.bundles.add(bk.get(e.id)!)
        crossings.set(k, w)
      }
    }
  }
  const windows: Window[] = [...crossings.values()].map((w) => {
    w.at.sort((x, y) => x - y)
    const mid = w.at[Math.floor(w.at.length / 2)]
    const width = (w.bundles.size + 2) * 20
    const lo = Math.round((mid - width / 2) / 20) * 20
    return { s: w.s, side: w.side, lo, hi: lo + width, pair: w.pair, bundles: [...w.bundles] }
  })
  void cellAt
  return { g: G, gx0, gy0, gnx, gny, bbox: { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 }, paths, sides, tagged, ratio, windows, overflow: res.overflow, iterations: res.it }
}

// Crossings forced by placement if no route detours: two edges whose endpoint boxes cross in a
// "plus" (one box spans the other horizontally, the other spans it vertically) must cross when both
// take monotone (shortest Manhattan) paths. Counted once per pair of bundles.
export function monotoneLowerBound(L: Layout, skip: Set<string> = new Set()): number {
  const m = new Map(L.nodes.map((n) => [n.id, n]))
  const es = L.edges.filter((e) => !skip.has(e.id) && m.get(e.from)?.obstacle && m.get(e.to)?.obstacle)
  const box = (e: Edge) => { const a = center(m.get(e.from)!.rect), b = center(m.get(e.to)!.rect); return { x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) } }
  const forced = new Set<string>()
  for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) {
    const A = es[i], B = es[j]
    const ka = bundleKey(L, A), kb = bundleKey(L, B)
    if (ka === kb || [A.from, A.to].some((x) => x === B.from || x === B.to)) continue
    const a = box(A), b = box(B)
    const plus = (p: typeof a, q: typeof a) => p.x0 < q.x0 && p.x1 > q.x1 && q.y0 < p.y0 && q.y1 > p.y1
    if (plus(a, b) || plus(b, a)) forced.add([ka, kb].sort().join("#"))
  }
  return forced.size
}

export type { Pt }
