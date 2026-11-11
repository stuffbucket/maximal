// Strategy "lanes": every edge gets its own lane on a 20px routing lattice, so parallel lines are
// always ≥ 20px apart. Section borders are walls with door windows (one per family pair, aligned
// on facing sides); each edge leaves its card through its own port (spread along the side, ≥ 20px
// from corners) with a straight 40px stub; bends are ≥ 40px apart; lines keep ≥ 20px from cards
// they don't touch and never run on a section border. Routes are found with A* over
// (node, direction, run) states with exclusive edges/nodes (perpendicular crossings allowed,
// penalized, never at doors or stubs), routed bundle by bundle so lanes nest, then improved by
// rip-up-and-reroute. Labels go in free space beside their own line, or are dropped.
import { sectionOf } from "./engine.ts"
import type { GlobalPlan } from "./global.ts"
import { center, simplify, type Edge, type Label, type Layout, type Pt, type Rect, type Route, type Side } from "./model.ts"

const P = 20 // lattice pitch = lane pitch
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const DX = [1, -1, 0, 0]
const DY = [0, 0, 1, -1]
const SIDE_DIR: Record<Side, number> = { RIGHT: 0, LEFT: 1, BOTTOM: 2, TOP: 3 }

export type LaneOpts = { name?: string; bend?: number; cross?: number; passes?: number; titleW?: (name: string) => number; nearCard?: number; doorExtra?: number; attempts?: number; share?: number; unswap?: number; plan?: GlobalPlan; tags?: Set<string>; corridor?: number; strictSlots?: boolean; slotPenalty?: number; policy?: "A" | "B" }

type Port = { card: string; side: Side; border: Pt; n1: number; n2: number; dir: number }

class Heap {
  k: number[] = []
  v: number[] = []
  push(key: number, val: number) {
    const k = this.k, v = this.v
    let i = k.length
    k.push(key); v.push(val)
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p }
    k[i] = key; v[i] = val
  }
  pop(): number {
    const k = this.k, v = this.v
    const top = v[0]
    const lk = k.pop()!, lv = v.pop()!
    if (k.length) {
      let i = 0
      const n = k.length
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && k[c + 1] < k[c]) c++
        if (k[c] >= lk) break
        k[i] = k[c]; v[i] = v[c]; i = c
      }
      k[i] = lk; v[i] = lv
    }
    return top
  }
  get size() { return this.k.length }
}

export function titleRect(s: { name: string; rect: Rect }, w?: (n: string) => number): Rect {
  // FigJam draws the section name as a pill at the top-left, inside the section
  return { x: s.rect.x, y: s.rect.y, w: Math.min(s.rect.w, w ? w(s.name) : 48 + s.name.length * 15), h: 64 }
}

export async function lanes(L0: Layout, opts: LaneOpts = {}): Promise<Layout> {
  const L = clone(L0)
  L.name = opts.name ?? "lanes"
  const tags = opts.tags ?? opts.plan?.tagged ?? new Set<string>()
  const allEdges = L.edges
  L.edges = L.edges.filter((e) => !tags.has(e.id)) // name-tagged edges get link pills, not wires
  const BEND = opts.bend ?? 6
  const CROSS = opts.cross ?? 50
  const SHARE = opts.share ?? 0.3 // cost per 20px on a lane our own bundle already uses (pulls bundles together)
  const m = new Map(L.nodes.map((n) => [n.id, n]))
  const sec = new Map(L.sections.map((s) => [s.id, s]))
  const all = [...L.sections.map((s) => s.rect), ...L.nodes.map((n) => n.rect), ...(L.blocks ?? [])]
  const x0 = Math.floor((Math.min(...all.map((r) => r.x)) - 240) / P) * P
  const y0 = Math.floor((Math.min(...all.map((r) => r.y)) - 240) / P) * P
  const nx = Math.ceil((Math.max(...all.map((r) => r.x + r.w)) + 240 - x0) / P) + 1
  const ny = Math.ceil((Math.max(...all.map((r) => r.y + r.h)) + 240 - y0) / P) + 1
  const N = nx * ny
  const id = (i: number, j: number) => j * nx + i
  const X = (k: number) => x0 + (k % nx) * P
  const Y = (k: number) => y0 + Math.floor(k / nx) * P
  const at = (x: number, y: number) => id(Math.round((x - x0) / P), Math.round((y - y0) / P))

  // ---- obstacles ----
  const blocked = new Uint8Array(N)
  const blockRect = (r: Rect, pad: number) => {
    const i0 = Math.max(0, Math.ceil((r.x - pad - x0) / P)), i1 = Math.min(nx - 1, Math.floor((r.x + r.w + pad - x0) / P))
    const j0 = Math.max(0, Math.ceil((r.y - pad - y0) / P)), j1 = Math.min(ny - 1, Math.floor((r.y + r.h + pad - y0) / P))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = x0 + i * P, y = y0 + j * P
      if (x > r.x - pad && x < r.x + r.w + pad && y > r.y - pad && y < r.y + r.h + pad) blocked[id(i, j)] = 1
    }
  }
  for (const n of L.nodes) blockRect(n.rect, 16) // cards, labels, headings: ≥ 16px clearance
  for (const b of L.blocks ?? []) blockRect(b, 16)
  const titles = L.sections.map((s) => titleRect(s, opts.titleW))
  for (const t of titles) blockRect(t, 8)
  if (opts.plan) {
    const B = opts.plan.bbox
    for (let k = 0; k < N; k++) { const x = X(k), y = Y(k); if (x < B.x || x > B.x + B.w || y < B.y || y > B.y + B.h) blocked[k] = 1 }
  }

  // ---- doors: one window per (section, other section), aligned when the sections face ----
  const inter: Edge[] = [], intra: Edge[] = []
  for (const e of L.edges) { const [a, b] = sectionOf(L, e); (a && b && a !== b ? inter : intra).push(e) }
  const pairKey = (a: string, b: string) => [a, b].sort().join("|")
  const pairs = new Map<string, Edge[]>()
  for (const e of inter) { const [a, b] = sectionOf(L, e) as [string, string]; const k = pairKey(a, b); pairs.set(k, [...(pairs.get(k) ?? []), e]) }
  const pairIdx = new Map([...pairs.keys()].map((k, i) => [k, i]))
  const pairKeys0 = [...pairs.keys()]
  const doorOwner = new Int32Array(N).fill(-1)
  const border = new Uint8Array(N) // 1 = on a section border (wall unless a door)
  for (const s of L.sections) {
    const R = s.rect
    for (let x = R.x; x <= R.x + R.w; x += P) { border[at(x, R.y)] = 1; border[at(x, R.y + R.h)] = 1 }
    for (let y = R.y; y <= R.y + R.h; y += P) { border[at(R.x, y)] = 1; border[at(R.x + R.w, y)] = 1 }
  }
  type Window = { s: string; side: Side; lo: number; hi: number; pair: number; aligned?: boolean; bundles?: string[] }
  const windows: Window[] = []
  const facing = (A: Rect, B: Rect): Side => {
    const gx = Math.max(B.x - (A.x + A.w), A.x - (B.x + B.w)), gy = Math.max(B.y - (A.y + A.h), A.y - (B.y + B.h))
    return gx >= gy ? (B.x > A.x ? "RIGHT" : "LEFT") : (B.y > A.y ? "BOTTOM" : "TOP")
  }
  const sideSpan = (R: Rect, side: Side): [number, number] => (side === "TOP" || side === "BOTTOM" ? [R.x, R.x + R.w] : [R.y, R.y + R.h])
  // which sides a family pair talks through: the pair of sides whose doors join by the shortest
  // path that doesn't cut through a third section (so families two apart use a side gutter)
  const solids = [...L.sections.map((s) => ({ id: s.id, r: s.rect })), ...(L.blocks ?? []).map((r, i) => ({ id: `block${i}`, r }))]
  const segCuts = (p: Pt, q: Pt, skip: string[]) => solids.some((s) => !skip.includes(s.id) && Math.max(p[0], q[0]) > s.r.x && Math.min(p[0], q[0]) < s.r.x + s.r.w && Math.max(p[1], q[1]) > s.r.y && Math.min(p[1], q[1]) < s.r.y + s.r.h)
  const OUT: Record<Side, Pt> = { TOP: [0, -1], BOTTOM: [0, 1], LEFT: [-1, 0], RIGHT: [1, 0] }
  const chooseSides = (a: string, b: string, es: Edge[]): [Side, Side] => {
    const A = sec.get(a)!.rect, B = sec.get(b)!.rect
    let best: [Side, Side] = [facing(A, B), facing(B, A)], bc = Infinity
    const sides: Side[] = ["TOP", "BOTTOM", "LEFT", "RIGHT"]
    const cardsIn = (s: string) => es.flatMap((e) => [e.from, e.to]).filter((id) => m.get(id)!.section === s).map((id) => center(m.get(id)!.rect))
    const ca = cardsIn(a), cb = cardsIn(b)
    const med = (ps: Pt[], i: number) => { const v = ps.map((p) => p[i]).sort((x, y) => x - y); return v[Math.floor(v.length / 2)] }
    // door estimate: median of the cards that use it, projected onto the side, 120px outside
    const door = (R: Rect, s: Side, ps: Pt[]): Pt => {
      const cx = Math.min(Math.max(med(ps, 0), R.x + 160), R.x + R.w - 160), cy = Math.min(Math.max(med(ps, 1), R.y + 160), R.y + R.h - 160)
      return s === "LEFT" ? [R.x - 120, cy] : s === "RIGHT" ? [R.x + R.w + 120, cy] : s === "TOP" ? [cx, R.y - 120] : [cx, R.y + R.h + 120]
    }
    for (const sa of sides) for (const sb of sides) {
      const pa = door(A, sa, ca), pb = door(B, sb, cb)
      const dir = OUT[sa][0] * (center(B)[0] - center(A)[0]) + OUT[sa][1] * (center(B)[1] - center(A)[1])
      const dirB = OUT[sb][0] * (center(A)[0] - center(B)[0]) + OUT[sb][1] * (center(A)[1] - center(B)[1])
      const inside = (ps: Pt[], p: Pt) => ps.reduce((s, q) => s + Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]), 0) / Math.max(1, ps.length)
      let c = Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) + inside(ca, pa) + inside(cb, pb) + (dir < 0 ? 3000 : 0) + (dirB < 0 ? 3000 : 0)
      const l1 = segCuts(pa, [pb[0], pa[1]], [a, b]) || segCuts([pb[0], pa[1]], pb, [a, b])
      const l2 = segCuts(pa, [pa[0], pb[1]], [a, b]) || segCuts([pa[0], pb[1]], pb, [a, b])
      if (l1 && l2) c += 6000
      if (c < bc) { bc = c; best = [sa, sb] }
    }
    return best
  }
  if (opts.plan) {
    for (const w of opts.plan.windows) {
      const pi = pairIdx.get(w.pair)
      if (pi === undefined) continue
      const R = sec.get(w.s)!.rect
      const [slo, shi] = sideSpan(R, w.side)
      const members = (pairs.get(w.pair) ?? []).filter((e) => w.bundles.includes(`${w.pair}|${e.kind}`)).length
      const width = (members + 2) * P
      const lo = Math.min(Math.max(Math.round(((w.lo + w.hi) / 2 - width / 2) / P) * P, slo + 80), shi - 80 - width)
      windows.push({ s: w.s, side: w.side, lo, hi: lo + width, pair: pi, bundles: w.bundles })
    }
    // facing windows of one pair that overlap: same span, so lanes keep their coordinate across
    const OPP: Record<Side, Side> = { TOP: "BOTTOM", BOTTOM: "TOP", LEFT: "RIGHT", RIGHT: "LEFT" }
    for (const a of windows) for (const b of windows) {
      if (a === b || a.pair !== b.pair || OPP[a.side] !== b.side || a.aligned || b.aligned) continue
      if (Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > -200) {
        const lo = Math.round(((a.lo + b.lo) / 2) / P) * P, width = Math.max(a.hi - a.lo, b.hi - b.lo)
        a.lo = b.lo = lo; a.hi = b.hi = lo + width; a.aligned = b.aligned = true
      }
    }
  } else for (const [k, es] of pairs) {
    const [a, b] = k.split("|")
    const A = sec.get(a)!.rect, B = sec.get(b)!.rect
    const [sa, sb] = chooseSides(a, b, es)
    const width = (es.length + 2) * P
    const horiz = sa === "TOP" || sa === "BOTTOM"
    const proj = (id: string) => { const c = center(m.get(id)!.rect); return horiz ? c[0] : c[1] }
    const place = (R: Rect, side: Side, ids: string[], lo?: number, hi?: number) => {
      const [slo, shi] = sideSpan(R, side)
      const l = Math.max(slo + 80, lo ?? -Infinity), h = Math.min(shi - 80, hi ?? Infinity)
      const ps = ids.map(proj).sort((p, q) => p - q)
      let c = ps.length ? ps[Math.floor(ps.length / 2)] : (l + h) / 2
      c = Math.min(Math.max(c, l + width / 2), h - width / 2)
      const w0 = Math.round((c - width / 2) / P) * P
      return [w0, w0 + width] as [number, number]
    }
    const [ol, oh] = horiz ? [Math.max(A.x, B.x), Math.min(A.x + A.w, B.x + B.w)] : [Math.max(A.y, B.y), Math.min(A.y + A.h, B.y + B.h)]
    const facingPair = sa === ({ TOP: "BOTTOM", BOTTOM: "TOP", LEFT: "RIGHT", RIGHT: "LEFT" } as const)[sb] && oh - ol >= width + 160
    if (facingPair) {
      const ids = es.flatMap((e) => [e.from, e.to])
      const [lo, hi] = place(A, sa, ids, ol, oh)
      windows.push({ s: a, side: sa, lo, hi, pair: pairIdx.get(k)!, aligned: true }, { s: b, side: sb, lo, hi, pair: pairIdx.get(k)!, aligned: true })
    } else {
      const ia = es.flatMap((e) => [e.from, e.to]).filter((id) => m.get(id)!.section === a)
      const ib = es.flatMap((e) => [e.from, e.to]).filter((id) => m.get(id)!.section === b)
      const hb = sb === "TOP" || sb === "BOTTOM"
      const projB = (id: string) => { const c = center(m.get(id)!.rect); return hb ? c[0] : c[1] }
      const [la, ha] = place(A, sa, ia)
      const psb = ib.map(projB).sort((p, q) => p - q)
      const [slo, shi] = sideSpan(B, sb)
      let cb = psb.length ? psb[Math.floor(psb.length / 2)] : (slo + shi) / 2
      cb = Math.min(Math.max(cb, slo + 80 + width / 2), shi - 80 - width / 2)
      const lb = Math.round((cb - width / 2) / P) * P
      windows.push({ s: a, side: sa, lo: la, hi: ha, pair: pairIdx.get(k)! }, { s: b, side: sb, lo: lb, hi: lb + width, pair: pairIdx.get(k)! })
    }
  }
  if (process.env.LANES_DEBUG) for (const w of windows) console.error("win", sec.get(w.s)!.name, w.side, w.lo, w.hi, pairKeys0[w.pair].split("|").map((s) => sec.get(s)!.name).join(" / "))
  // windows on one side must not overlap: push apart (keeping a 40px wall between)
  const bySide = new Map<string, Window[]>()
  for (const w of windows) bySide.set(`${w.s}|${w.side}`, [...(bySide.get(`${w.s}|${w.side}`) ?? []), w])
  for (let rep = 0; rep < 3; rep++) for (const ws of bySide.values()) {
    ws.sort((a, b) => a.lo - b.lo)
    for (let i = 1; i < ws.length; i++) if (ws[i].lo < ws[i - 1].hi + 40) {
      const d = ws[i - 1].hi + 40 - ws[i].lo
      ws[i].lo += d; ws[i].hi += d
      if (ws[i].aligned) { const o = windows.find((x) => x.pair === ws[i].pair && x !== ws[i])!; o.lo += d; o.hi += d } // keep facing doors aligned
    }
  }
  // groups: edges between the same two families with the same kind form one bundle — they may
  // share lanes (merge after leaving their cards, split before reaching them); everything else
  // only meets at right-angle crossings. Intra-family edges are their own group.
  const groupKey = (e: Edge) => { const [a, b] = sectionOf(L, e); return a && b && a !== b ? `${pairKey(a, b)}|${e.kind}` : `e|${e.id}` }
  const groupIds = new Map<string, number>()
  for (const e of L.edges) if (!groupIds.has(groupKey(e))) groupIds.set(groupKey(e), groupIds.size)
  const gOf = new Map(L.edges.map((e) => [e.id, groupIds.get(groupKey(e))!]))
  const gKeyOf = new Map([...groupIds.entries()].map(([k, v]) => [v, k]))
  const edgeIdx = new Map(L.edges.map((e, i) => [e.id, i]))
  // each bundle gets one slot in each window, ordered by where its cards sit inside the section
  // (left-edge style), so lanes nest instead of crossing at the door
  const doorSlot = new Int32Array(N).fill(-1)
  const perpOnly = new Uint8Array(N) // 1 = vertical moves only, 2 = horizontal moves only
  const pairKeys = [...pairs.keys()]
  for (const w of windows) {
    const R = sec.get(w.s)!.rect
    const horiz = w.side === "TOP" || w.side === "BOTTOM"
    const coord = (id: string) => { const c = center(m.get(id)!.rect); return horiz ? c[0] : c[1] }
    const es = pairs.get(pairKeys[w.pair])!
    const inside = (e: Edge) => (m.get(e.from)!.section === w.s ? e.from : e.to)
    const outside = (e: Edge) => (m.get(e.from)!.section === w.s ? e.to : e.from)
    const gs = [...new Set(es.map((e) => gOf.get(e.id)!))].filter((g) => !w.bundles || w.bundles.includes(gKeyOf.get(g)!))
    const key = (g: number) => { const mem = es.filter((e) => gOf.get(e.id) === g); const v = mem.map((e) => coord(inside(e))).sort((a, b) => a - b); const o = mem.map((e) => coord(outside(e))).sort((a, b) => a - b); return [v[Math.floor(v.length / 2)], o[Math.floor(o.length / 2)]] }
    if (w.aligned) {
      // facing windows share one order (both ends), so bundles of a pair never cross in the gutter
      const both = (g: number) => { const mem = es.filter((e) => gOf.get(e.id) === g); const v = mem.flatMap((e) => [coord(e.from), coord(e.to)]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)] }
      gs.sort((a, b) => both(a) - both(b) || a - b)
    } else gs.sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1])
    // one slot per edge: a bundle's members take adjacent slots (nearest first) and merge only
    // outside, in the gutter — never on the card side or inside the section
    const slots: number[] = []
    for (const g of gs) {
      const mem = es.filter((e) => gOf.get(e.id) === g).sort((a, b) => coord(inside(a)) - coord(inside(b)))
      for (const e of mem) slots.push(edgeIdx.get(e.id)!)
    }
    let i = 0
    for (let c = w.lo + P; c < w.hi; c += P) {
      const k = w.side === "TOP" ? at(c, R.y) : w.side === "BOTTOM" ? at(c, R.y + R.h) : w.side === "LEFT" ? at(R.x, c) : at(R.x + R.w, c)
      doorOwner[k] = w.pair
      if (i < slots.length) doorSlot[k] = slots[i++]
    }
    // approach band: 40px on both sides of the window, perpendicular moves only, so every slot has
    // a straight approach and lateral runs (and crossings) happen ≥ 60px from the wall
    for (let c = w.lo; c <= w.hi; c += P) for (const dpt of [-2, -1, 1, 2]) {
      const k = horiz ? at(c, (w.side === "TOP" ? R.y : R.y + R.h) + dpt * P) : at((w.side === "LEFT" ? R.x : R.x + R.w) + dpt * P, c)
      perpOnly[k] = horiz ? 1 : 2
    }
  }
  for (let k = 0; k < N; k++) if (border[k] && doorOwner[k] < 0) blocked[k] = 1
  // ---- ports ----
  const ports = new Map<string, Port[]>()
  const allPorts = new Map<string, Port[]>()
  for (const n of L.nodes) {
    if (!n.obstacle) continue
    const r = n.rect
    const list: Port[] = []
    const add = (side: Side, bx: number, by: number) => {
      const d = SIDE_DIR[side]
      const n1 = at(bx + DX[d] * P, by + DY[d] * P), n2 = at(bx + DX[d] * 2 * P, by + DY[d] * 2 * P)
      if (!blocked[n1] && !blocked[n2] && !border[n1] && !border[n2]) list.push({ card: n.id, side, border: [bx, by], n1, n2, dir: d })
    }
    // ports on lattice coordinates, only where the outline is flat and meets its box: FigJam's
    // rounded rectangles are stadiums (corner radius = half the height), so top/bottom ports keep
    // radius + 16px from each end and the round ends only take a port at mid-height; hexagons and
    // chevrons have slanted ends (one point per side; a chevron's left side is a notch, so its
    // port sits inside the box, at the notch)
    const shape = String(n.style?.shape ?? "")
    const radius = shape === "ROUNDED_RECTANGLE" || shape === "" ? Math.min(r.h, r.w) / 2 : 0
    const slant = shape === "HEXAGON" ? Math.round(r.w * 0.14) + 16 : shape === "CHEVRON" ? Math.round(r.w * 0.12) + 16 : shape === "ELLIPSE" ? r.w / 2 : radius ? radius + 16 : 20
    const xa = shape === "CHEVRON" ? r.x + 20 : r.x + slant, xb = r.x + r.w - slant
    for (let x = Math.ceil((xa - x0) / P) * P + x0; x <= xb; x += P) { add("TOP", x, r.y); add("BOTTOM", x, r.y + r.h) }
    const rounded = radius >= r.h / 2 - 1
    if (shape === "HEXAGON" || shape === "CHEVRON" || shape === "ELLIPSE" || rounded) {
      const my = Math.round((r.y + r.h / 2 - y0) / P) * P + y0
      add("RIGHT", r.x + r.w, my)
      if (shape !== "CHEVRON") add("LEFT", r.x, my)
      else { add("LEFT", r.x, my); const p = list[list.length - 1]; if (p && p.side === "LEFT") p.border = [r.x + Math.round(r.w * 0.12), my] }
    } else for (let y = Math.ceil((r.y + 20 - y0) / P) * P + y0; y <= r.y + r.h - 20; y += P) { add("LEFT", r.x, y); add("RIGHT", r.x + r.w, y) }
    // pointed/round ends are only for straight (0-bend) links; anything that bends enters a flat side
    const pointed = shape === "HEXAGON" || shape === "CHEVRON" || shape === "ELLIPSE" || rounded
    allPorts.set(n.id, list)
    ports.set(n.id, pointed ? list.filter((p) => p.side === "TOP" || p.side === "BOTTOM") : list)
  }
  // nodes where bundles may NOT share a lane: inside sections, on walls, in door/ring bands
  const noShare = new Uint8Array(N)
  for (const sc of L.sections) { const R = sc.rect; for (let y = Math.ceil((R.y - y0) / P) * P + y0; y <= R.y + R.h; y += P) for (let x = Math.ceil((R.x - x0) / P) * P + x0; x <= R.x + R.w; x += P) noShare[at(x, y)] = 1 }

  // ---- channel structure ----
  const near = new Uint8Array(N) // 1 = no crossings here: within 40px of a door node
  for (let k = 0; k < N; k++) if (doorOwner[k] >= 0) {
    const i = k % nx, j = Math.floor(k / nx)
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) { const ii = i + di, jj = j + dj; if (ii >= 0 && ii < nx && jj >= 0 && jj < ny) near[id(ii, jj)] = 1 }
  }
  // narrow channels: nodes within 60px of two cards (the 80px gaps between columns)
  const cardsNear = new Uint8Array(N)
  for (const n of L.nodes) {
    if (!n.obstacle) continue
    const r = n.rect
    for (let y = Math.ceil((r.y - 60 - y0) / P) * P + y0; y <= r.y + r.h + 60; y += P) for (let x = Math.ceil((r.x - 60 - x0) / P) * P + x0; x <= r.x + r.w + 60; x += P) cardsNear[at(x, y)]++
  }
  // the 20px ring and 40px band around each card are for port stubs (no running along a card's
  // border, no boxing a card in), except in narrow channels, where those lines are the lanes
  for (const n of L.nodes) {
    if (!n.obstacle) continue
    const r = n.rect
    const ax = Math.ceil((r.x - 20 - x0) / P) * P + x0, bx = Math.floor((r.x + r.w + 20 - x0) / P) * P + x0
    const ay = Math.ceil((r.y - 20 - y0) / P) * P + y0, by = Math.floor((r.y + r.h + 20 - y0) / P) * P + y0
    for (let x = ax + P; x < bx; x += P) for (const y of [ay, by]) { const k = at(x, y); if (!blocked[k] && cardsNear[k] < 2) perpOnly[k] = perpOnly[k] === 2 ? 3 : 1 }
    for (let y = ay + P; y < by; y += P) for (const x of [ax, bx]) { const k = at(x, y); if (!blocked[k] && cardsNear[k] < 2) perpOnly[k] = perpOnly[k] === 1 ? 3 : 2 }
    for (const x of [ax, bx]) for (const y of [ay, by]) blocked[at(x, y)] = 1
  }
  for (let k = 0; k < N; k++) if (perpOnly[k] === 3) blocked[k] = 1
  for (const n of L.nodes) {
    if (!n.obstacle) continue
    const r = n.rect
    const ax = Math.ceil((r.x - 40 - x0) / P) * P + x0, bx = Math.floor((r.x + r.w + 40 - x0) / P) * P + x0
    const ay = Math.ceil((r.y - 40 - y0) / P) * P + y0, by = Math.floor((r.y + r.h + 40 - y0) / P) * P + y0
    for (let x = ax + 2 * P; x <= bx - 2 * P; x += P) for (const y of [ay, by]) { const k = at(x, y); if (!blocked[k] && !perpOnly[k] && cardsNear[k] < 2) perpOnly[k] = 1 }
    for (let y = ay + 2 * P; y <= by - 2 * P; y += P) for (const x of [ax, bx]) { const k = at(x, y); if (!blocked[k] && !perpOnly[k] && cardsNear[k] < 2) perpOnly[k] = 2 }
  }

  // ---- usage (by group, reference-counted; a node holds its group plus at most one crossing group) ----
  const nodeG = new Int32Array(N).fill(-1), nodeC = new Int32Array(N), nodeM = new Uint8Array(N) // mode 1 H, 2 V, 3 turn/merge
  const nodeXG = new Int32Array(N).fill(-1), nodeXC = new Int32Array(N), nodeXM = new Uint8Array(N)
  const edgeG = new Int32Array(2 * N).fill(-1), edgeC = new Int32Array(2 * N) // [k*2] = k→k+1, [k*2+1] = k→k+nx
  const stub = new Uint8Array(N) // port stub nodes in use: exclusive
  const usedPort = new Set<string>()
  const portKey = (p: Port) => `${p.card}|${p.border[0]}|${p.border[1]}`
  type Placed = { edge: Edge; g: number; nodes: number[]; from: Port; to: Port; cost: number }
  const placed = new Map<string, Placed>()
  const ue = (a: number, b: number) => (b - a === 1 ? a * 2 : b - a === -1 ? b * 2 : b - a === nx ? a * 2 + 1 : b * 2 + 1)
  const modeAt = (ns: number[], i: number) => {
    const prev = ns[i - 1], next = ns[i + 1]
    if (prev === undefined || next === undefined) return 3
    return Math.abs(next - prev) === 2 ? 1 : Math.abs(next - prev) === 2 * nx ? 2 : 3
  }
  const occupy = (p: Placed, set: boolean) => {
    const G = p.g, ns = p.nodes
    for (let i = 0; i < ns.length; i++) {
      const k = ns[i], md = modeAt(ns, i)
      if (set) {
        if (nodeG[k] < 0) { nodeG[k] = G; nodeC[k] = 1; nodeM[k] = md }
        else if (nodeG[k] === G) { nodeC[k]++; if (nodeM[k] !== md) nodeM[k] = 3 }
        else { nodeXG[k] = G; nodeXC[k]++; nodeXM[k] = md }
      } else {
        if (nodeG[k] === G) {
          if (--nodeC[k] === 0) {
            if (nodeXG[k] >= 0) { nodeG[k] = nodeXG[k]; nodeC[k] = nodeXC[k]; nodeM[k] = nodeXM[k]; nodeXG[k] = -1; nodeXC[k] = 0 }
            else { nodeG[k] = -1; nodeM[k] = 0 }
          }
        } else if (nodeXG[k] === G && --nodeXC[k] === 0) nodeXG[k] = -1
      }
      if (i > 0) { const u = ue(ns[i - 1], k); if (set) { edgeG[u] = G; edgeC[u]++ } else if (--edgeC[u] === 0) edgeG[u] = -1 }
    }
    for (const q of [p.from, p.to]) {
      if (set) usedPort.add(portKey(q)); else usedPort.delete(portKey(q))
      stub[q.n1] = stub[q.n2] = set ? 1 : 0
    }
    // which cards each bundle touches (links sharing a card must nest, never cross)
    let mp = groupCards.get(G)
    if (!mp) { mp = new Map(); groupCards.set(G, mp) }
    for (const c of [p.edge.from, p.edge.to]) { const v = (mp.get(c) ?? 0) + (set ? 1 : -1); if (v <= 0) mp.delete(c); else mp.set(c, v) }
  }
  const groupCards = new Map<number, Map<string, number>>()

  // ---- sides, modes and ideal ports ----
  // Inside a family, cards sit in rows. Each intra link gets a mode:
  //   row     — same row, neighbours: one straight horizontal between the facing ends
  //   channel — adjacent rows: bottom → one track in the gap between the rows → top
  //   mono    — anything else that can be routed monotonically (never moving away from its target)
  //   tag     — same row with a card in between (any route would go away and back): a name tag
  // Cross-family links use the side their global path leaves/enters by.
  // Ports: one link on a side sits at its centre; k links sit symmetric around the centre at an even
  // pitch, ordered by the other end's position. Every deviation from that records its cause.
  type Mode = "row" | "channel" | "mono" | "astar" | "tag" | "loopback"
  const mode = new Map<string, Mode>()
  const sideMap = new Map<string, [Side, Side]>()
  const rowsOf = new Map<string, number[]>() // section → sorted row ys
  for (const sc of L.sections) rowsOf.set(sc.id, [...new Set(L.nodes.filter((n) => n.section === sc.id && n.obstacle && n.style?.shape !== "ELLIPSE").map((n) => n.rect.y))].sort((u, v) => u - v))
  const rowIdx = (n: typeof L.nodes[number]) => rowsOf.get(n.section!)?.indexOf(n.rect.y) ?? -1
  for (const e of L.edges) {
    const A = m.get(e.from)!, B = m.get(e.to)!
    const [sa, sb] = sectionOf(L, e)
    if (sa && sa === sb) {
      const ra = rowIdx(A), rb = rowIdx(B)
      if (ra === rb) {
        const [lo, hi] = A.rect.x < B.rect.x ? [A.rect.x + A.rect.w, B.rect.x] : [B.rect.x + B.rect.w, A.rect.x]
        const between = L.nodes.some((n) => n.obstacle && n.section === sa && n.rect.y === A.rect.y && n.rect.x >= lo && n.rect.x + n.rect.w <= hi)
        if (between && e.kind === "loop") { mode.set(e.id, "loopback" as Mode); sideMap.set(e.id, ["BOTTOM", "BOTTOM"]) }
        else { mode.set(e.id, between ? "tag" : "row"); sideMap.set(e.id, A.rect.x < B.rect.x ? ["RIGHT", "LEFT"] : ["LEFT", "RIGHT"]) }
      } else {
        mode.set(e.id, Math.abs(ra - rb) === 1 ? "channel" : "mono")
        sideMap.set(e.id, rb > ra ? ["BOTTOM", "TOP"] : ["TOP", "BOTTOM"])
      }
    } else {
      mode.set(e.id, "astar")
      const sd = opts.plan?.sides.get(e.id)
      sideMap.set(e.id, sd ?? [facing(A.rect, B.rect), facing(B.rect, A.rect)])
    }
  }
  const newTags = new Set<string>(L.edges.filter((e) => mode.get(e.id) === "tag").map((e) => e.id))
  const prefPort = new Map<string, string>()
  const portCause = new Map<string, string>() // "edge|end" → why the port is not at the side centre
  const bendCause = new Map<string, string[]>()
  const routable = (e: Edge) => !newTags.has(e.id)
  {
    type End = { e: Edge; end: 0 | 1; card: string; other: string }
    const groups = new Map<string, End[]>()
    for (const e of L.edges) {
      if (!routable(e)) continue
      const sd = sideMap.get(e.id)!
      for (const [end, card, other, side] of [[0, e.from, e.to, sd[0]], [1, e.to, e.from, sd[1]]] as [0 | 1, string, string, Side][]) {
        const k = `${card}|${side}`
        groups.set(k, [...(groups.get(k) ?? []), { e, end, card, other }])
      }
    }
    const idealAt = new Map<string, number>() // "edge|end" → coordinate along the side
    for (const [k, items] of groups) {
      const [card, side] = k.split("|") as [string, Side]
      const horiz = side === "TOP" || side === "BOTTOM"
      const ps = (allPorts.get(card) ?? []).filter((p) => p.side === side)
      if (!ps.length) continue
      const r = m.get(card)!.rect
      const c0 = horiz ? r.x + r.w / 2 : r.y + r.h / 2
      const lat = (it: End) => { const o = center(m.get(it.other)!.rect); return horiz ? o[0] : o[1] }
      items.sort((u, v) => lat(u) - lat(v) || u.e.id.localeCompare(v.e.id))
      const coords = ps.map((p) => (horiz ? p.border[0] : p.border[1]))
      const lo = Math.min(...coords), hi = Math.max(...coords)
      const kk = items.length
      const sideLen = horiz ? r.w : r.h
      let pitch = kk > 1 ? Math.min(160, Math.max(40, Math.floor((0.6 * sideLen) / (kk - 1) / P) * P)) : 0
      while (kk > 1 && (kk - 1) * pitch > hi - lo && pitch > 20) pitch -= 20
      // a link to a card whose centre lines up (within 40px) with ours is a straight drop: it takes
      // the shared x between the two centres; the other links sit symmetric around it
      const ai = horiz ? items.findIndex((it) => { const o = m.get(it.other)!; return o.section === m.get(card)!.section && Math.abs(center(o.rect)[0] - c0) <= 40 && (o.rect.y >= r.y + r.h + 80 || r.y >= o.rect.y + o.rect.h + 80) }) : -1
      const xAl = ai >= 0 ? Math.round((c0 + center(m.get(items[ai].other)!.rect)[0]) / 2 / P) * P : 0
      items.forEach((it, i) => {
        let want = ai >= 0 ? xAl + (i - ai) * pitch : Math.round((c0 + (i - (kk - 1) / 2) * pitch) / P) * P
        let cause = ai === i ? `aligned with ${(m.get(it.other)!.text ?? "").split("\n")[0]} for a straight drop` : ai >= 0 ? `slot ${i + 1} of ${kk} around a straight drop on ${side}` : kk > 1 ? `slot ${i + 1} of ${kk} on ${side} (ordered by the other end's position)` : ""
        if (want < lo || want > hi) { want = Math.min(Math.max(want, lo), hi); cause = `clamped to the flat part of the ${side.toLowerCase()} side` }
        idealAt.set(`${it.e.id}|${it.end}`, want)
        if (cause) portCause.set(`${it.e.id}|${it.end}`, cause)
      })
    }
    // straight drops: a channel link whose two ideal ports are within 2 grid steps gets one shared x
    for (const e of L.edges) {
      if (mode.get(e.id) !== "channel" || !routable(e)) continue
      const a = idealAt.get(`${e.id}|0`), b = idealAt.get(`${e.id}|1`)
      if (a === undefined || b === undefined || Math.abs(a - b) > 40 || a === b) continue
      const x = Math.round((a + b) / 2 / P) * P
      const okA = (allPorts.get(e.from) ?? []).some((p) => p.border[0] === x), okB = (allPorts.get(e.to) ?? []).some((p) => p.border[0] === x)
      if (!okA || !okB) continue
      idealAt.set(`${e.id}|0`, x); idealAt.set(`${e.id}|1`, x)
      portCause.set(`${e.id}|0`, `aligned with ${(m.get(e.to)!.text ?? "").split("\n")[0]} for a straight drop`)
      portCause.set(`${e.id}|1`, `aligned with ${(m.get(e.from)!.text ?? "").split("\n")[0]} for a straight drop`)
    }
    for (const [key, at2] of idealAt) {
      const [eid, end] = key.split("|")
      const e = L.edges.find((x) => x.id === eid)!
      const card = end === "0" ? e.from : e.to
      const side = sideMap.get(eid)![Number(end)]
      const horiz = side === "TOP" || side === "BOTTOM"
      const p = (allPorts.get(card) ?? []).filter((q) => q.side === side).sort((u, v) => Math.abs((horiz ? u.border[0] : u.border[1]) - at2) - Math.abs((horiz ? v.border[0] : v.border[1]) - at2))[0]
      if (p) prefPort.set(key, portKey(p))
    }
  }
  const planSides = sideMap
  // corridors: the global path's gcells plus one ring; leaving them costs extra
  const corridor = new Map<string, Uint8Array>()
  const gp = opts.plan
  const cellOf = (k: number) => { if (!gp) return -1; const i = Math.floor((X(k) - gp.gx0) / gp.g), j = Math.floor((Y(k) - gp.gy0) / gp.g); return i < 0 || j < 0 || i >= gp.gnx || j >= gp.gny ? -1 : j * gp.gnx + i }
  if (gp) for (const [eid, path] of gp.paths) {
    const a = new Uint8Array(gp.gnx * gp.gny)
    for (const c of path) { const i = c % gp.gnx, j = Math.floor(c / gp.gnx); for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const ii = i + di, jj = j + dj; if (ii >= 0 && jj >= 0 && ii < gp.gnx && jj < gp.gny) a[jj * gp.gnx + ii] = 1 } }
    corridor.set(eid, a)
  }
  const CORR = opts.corridor ?? 1.5

  // a port within 40px of another port already used on the same side of the same card
  const tightPort = (card: string, p: Port) => [...usedPort].some((k) => {
    if (!k.startsWith(`${card}|`)) return false
    const [ux, uy] = k.split("|").slice(1).map(Number)
    return p.side === "TOP" || p.side === "BOTTOM" ? uy === p.border[1] && Math.abs(ux - p.border[0]) < 40 && ux !== p.border[0] : ux === p.border[0] && Math.abs(uy - p.border[1]) < 40 && uy !== p.border[1]
  })
  const route = (e: Edge, G: number, allowed: number, flex = false, level = 0, mono = true): Placed | undefined => {
    const EI = edgeIdx.get(e.id)!
    const okPort = (p: Port) => !usedPort.has(portKey(p)) && nodeG[p.n1] < 0 && nodeG[p.n2] < 0 && !stub[p.n1] && !stub[p.n2]
    const pick = (card: string, end: 0 | 1) => {
      const free = (allPorts.get(card) ?? []).filter(okPort)
      const sd = planSides?.get(e.id)
      if (!sd || level >= 2) return free
      const onSide = free.filter((p) => p.side === sd[end])
      if (level === 1) {
        // target end: keep ≥ 40px from ports already used on this side when the side allows it
        // (source end: a small start penalty instead, so a straighter line can still win)
        if (end === 0) return onSide
        const spaced = onSide.filter((p) => !tightPort(card, p))
        return spaced.length ? spaced : onSide
      }
      const pref = prefPort.get(`${e.id}|${end}`)
      return onSide.filter((p) => portKey(p) === pref)
    }
    // monotone inside sections: never move away from the target inside its family, never move back
    // toward the source inside the source's family
    const SR = m.get(e.from)!.rect, TR = m.get(e.to)!.rect
    const SS = sec.get(m.get(e.from)!.section ?? "")?.rect, TS = sec.get(m.get(e.to)!.section ?? "")?.rect
    const inR = (z: number, R?: Rect) => !!R && X(z) >= R.x && X(z) <= R.x + R.w && Y(z) >= R.y && Y(z) <= R.y + R.h
    const dX = (z: number, R: Rect) => Math.max(0, R.x - X(z), X(z) - R.x - R.w), dY = (z: number, R: Rect) => Math.max(0, R.y - Y(z), Y(z) - R.y - R.h)
    const src = pick(e.from, 0)
    const dst = pick(e.to, 1)
    const corr = corridor.get(e.id)
    if (!src.length || !dst.length) return undefined
    const goal = new Map<number, Port>()
    for (const p of dst) goal.set(p.n2 * 4 + (p.dir ^ 1), p) // arrive at n2 moving toward the card
    const T = m.get(e.to)!.rect
    const tx0 = T.x - 40, tx1 = T.x + T.w + 40, ty0 = T.y - 40, ty1 = T.y + T.h + 40
    const h = (k: number) => { const x = X(k), y = Y(k); return (Math.max(0, tx0 - x, x - tx1) + Math.max(0, ty0 - y, y - ty1)) / P * SHARE }
    const S = N * 8
    const g = new Float32Array(S).fill(Infinity)
    const from = new Int32Array(S).fill(-1)
    const heap = new Heap()
    const startPort = new Map<number, Port>()
    const tgtSide = SIDE_DIR[facing(m.get(e.from)!.rect, T)]
    for (const p of src) {
      const s = (p.n2 * 4 + p.dir) * 2 + 1
      const pref = prefPort.get(`${e.id}|0`)
      const prefP = pref ? (ports.get(e.from) ?? []).find((q) => portKey(q) === pref) : undefined
      const pull = prefP ? (Math.abs(prefP.border[0] - p.border[0]) + Math.abs(prefP.border[1] - p.border[1])) / P * 0.15 : 0
      const c = 2 + (p.dir === tgtSide ? 0 : 3) + pull + (tightPort(e.from, p) ? 3 : 0)
      if (c < g[s]) { g[s] = c; startPort.set(s, p); heap.push(c + h(p.n2), s) }
    }
    let end = -1
    while (heap.size) {
      const s = heap.pop()
      const run = s & 1, kd = s >> 1, k = kd >> 2, d = kd & 3
      const gs = g[s]
      if (goal.has(kd)) { end = s; break }
      const i = k % nx
      for (const nd of [d, d < 2 ? 2 : 0, d < 2 ? 3 : 1]) {
        const turn = nd !== d
        if (turn) {
          if (!run || doorOwner[k] >= 0 || border[k] || stub[k]) continue
          // turn only on a free node or where our own bundle runs (a merge/split), never at a crossing
          if (nodeG[k] >= 0 && (nodeG[k] !== G || nodeXG[k] >= 0 || noShare[k] || perpOnly[k])) continue
          if (nodeXG[k] >= 0) continue
        }
        const ni = i + DX[nd]
        if (ni < 0 || ni >= nx) continue
        const q = k + DX[nd] + DY[nd] * nx
        if (q < 0 || q >= N || blocked[q] || stub[q]) continue
        if (mono && opts.policy !== "B" && (dX(q, TR) > dX(k, TR) || dY(q, TR) > dY(k, TR))) continue // A: monotone everywhere
        if (mono && opts.policy === "B") {
          // B: monotone inside the families; outside, the route is judged afterwards (detour, bends)
          if (inR(k, TS) && inR(q, TS) && (dX(q, TR) > dX(k, TR) || dY(q, TR) > dY(k, TR))) continue
          if (inR(k, SS) && inR(q, SS) && SS !== TS && (dX(q, SR) < dX(k, SR) || dY(q, SR) < dY(k, SR))) continue
        }
        if ((perpOnly[q] === 1 || perpOnly[k] === 1) && nd < 2) continue
        if ((perpOnly[q] === 2 || perpOnly[k] === 2) && nd >= 2) continue
        // door slots: any free slot of this pair's window; the assigned one is free of charge, others
        // cost a little (so the lane keeps its coordinate instead of jogging to reach its slot)
        let slotPen = 0
        if (doorOwner[q] >= 0) {
          if (doorOwner[q] !== allowed || nodeG[q] >= 0) continue
          if (doorSlot[q] !== EI) { if (!flex && opts.strictSlots) continue; slotPen = opts.slotPenalty ?? 5 }
        }
        const u = ue(k, q)
        if (edgeG[u] >= 0 && (edgeG[u] !== G || noShare[k] || noShare[q] || perpOnly[k] || perpOnly[q])) continue
        if ((nodeG[q] === G || nodeXG[q] === G) && (noShare[q] || perpOnly[q])) continue // own bundle inside a section: no shared trunk near cards
        const horiz = nd < 2
        if (nodeG[q] === G && nodeXG[q] >= 0 && avoidG.has(nodeXG[q])) continue
        let c = (edgeG[u] === G ? SHARE : 1) + (turn ? BEND : 0) + slotPen
        if (corr) { const gc = cellOf(q); if (gc < 0 || !corr[gc]) c += CORR }
        if (nodeG[q] >= 0 && nodeG[q] !== G) {
          // a straight perpendicular crossing of another bundle's straight segment, away from doors
          if (nodeXG[q] >= 0 && nodeXG[q] !== G) continue
          if (near[q] || nodeM[q] === 3 || (horiz && nodeM[q] !== 2) || (!horiz && nodeM[q] !== 1)) continue
          if (avoidG.has(nodeG[q])) continue
          const gc = groupCards.get(nodeG[q])
          if (gc && (gc.has(e.from) || gc.has(e.to))) continue // shares a card with us: nest, don't cross
          if (nodeXG[q] < 0) c += CROSS
        } else if (nodeG[q] === G && nodeXG[q] >= 0) {
          // our bundle is crossed here: keep straight in our bundle's direction
          if ((horiz && nodeM[q] !== 1) || (!horiz && nodeM[q] !== 2)) continue
        }
        const ns = ((q * 4 + nd) * 2) + (turn ? 0 : 1)
        const ng = gs + c
        if (ng < g[ns]) { g[ns] = ng; from[ns] = s; heap.push(ng + h(q), ns) }
      }
    }
    if (end < 0) return undefined
    const toPort = goal.get(end >> 1)!
    const nodes: number[] = []
    let s = end, st = end
    while (s >= 0) { nodes.push(s >> 3); st = s; s = from[s] }
    nodes.reverse()
    const fromPort = startPort.get(st)!
    return { edge: e, g: G, nodes: [fromPort.n1, ...nodes, toPort.n1], from: fromPort, to: toPort, cost: g[end] }
  }

  let avoidG = new Set<number>() // bundles the current route may not cross (used to undo lane swaps)
  const place = (e: Edge): boolean => {
    const [a, b] = sectionOf(L, e)
    const allowed = a && b && a !== b ? pairIdx.get(pairKey(a, b))! : -2
    const G = gOf.get(e.id)!
    // any port on the planned side, with a small pull toward the pin-assigned one: ports and lane
    // are chosen together by the search instead of the port being fixed first
    const tries: [boolean, number, boolean, string][] = [[false, 0, true, ""], [false, 1, true, "its centred slot had no monotone route"], [false, 2, true, "no monotone route from the planned side"], [true, 2, true, "door slot taken"], [true, 2, false, "no monotone route exists (needs a name tag)"]]
    const bendsOf = (q: Placed) => { let b = 0; for (let i = 2; i < q.nodes.length; i++) if (q.nodes[i] - q.nodes[i - 1] !== q.nodes[i - 1] - q.nodes[i - 2]) b++; return b }
    for (let ti = 0; ti < tries.length; ti++) {
      const [flex, level, mono, why0] = tries[ti]
      let why = why0
      let p = route(e, G, allowed, flex, level, mono)
      // ports and lane together: if a free port on the same side gives a route with fewer bends
      // (no jog to clear a neighbour), take it over the centred slot
      if (p && level === 0) {
        const q = route(e, G, allowed, flex, 1, mono)
        if (q && bendsOf(q) < bendsOf(p)) { p = q; why = "moved off its centred slot: from there the line needed an extra jog" }
      }
      if (!p) continue
      placed.set(e.id, p)
      occupy(p, true)
      if (!mono) newTags.add(e.id)
      for (const [end, port] of [[0, p.from], [1, p.to]] as [0 | 1, Port][]) {
        const key = `${e.id}|${end}`
        if (portKey(port) !== prefPort.get(key) && why) portCause.set(key, why + blocker(prefPort.get(key)))
      }
      return true
    }
    return false
  }
  // what occupies a port that was wanted (for the explanation)
  const blocker = (pk?: string) => {
    if (!pk) return ""
    const owner = [...placed.values()].find((q) => portKey(q.from) === pk || portKey(q.to) === pk)
    if (owner) return ` (slot taken by ${(m.get(owner.edge.from)!.text ?? "").split("\n")[0]} → ${(m.get(owner.edge.to)!.text ?? "").split("\n")[0]})`
    return ""
  }

  // ---- direct links (chosen before any search): when two cards in a family face each other, the
  // ports and the lane are chosen together — one straight segment inside the overlap of the two
  // sides, else one Z whose cross segment runs in the middle of the gap between the cards ----
  const direct = new Set<string>()
  const okFree = (p: Port) => !usedPort.has(portKey(p)) && nodeG[p.n1] < 0 && nodeG[p.n2] < 0 && !stub[p.n1] && !stub[p.n2]
  const stepsBetween = (a: Pt, b: Pt): number[] => {
    const out: number[] = []
    const dx = Math.sign(b[0] - a[0]) * P, dy = Math.sign(b[1] - a[1]) * P
    let x = a[0], y = a[1]
    out.push(at(x, y))
    while (x !== b[0] || y !== b[1]) { x += dx; y += dy; out.push(at(x, y)) }
    return out
  }
  const pathOk = (ns: number[], cardsOf?: string[]): boolean => {
    for (let i = 1; i < ns.length; i++) {
      const k = ns[i - 1], q = ns[i]
      const nd = q - k === 1 ? 0 : q - k === -1 ? 1 : q - k === nx ? 2 : 3
      if (blocked[q] || (stub[q] && i < ns.length - 1)) return false
      if ((perpOnly[q] === 1 || perpOnly[k] === 1) && nd < 2) return false
      if ((perpOnly[q] === 2 || perpOnly[k] === 2) && nd >= 2) return false
      if (doorOwner[q] >= 0 || border[q]) return false
      if (edgeG[ue(k, q)] >= 0) return false
      const turnAtQ = i + 1 < ns.length && ns[i + 1] - q !== q - k
      if (nodeG[q] >= 0) {
        const horiz = nd < 2
        if (turnAtQ || near[q] || nodeXG[q] >= 0 || nodeM[q] === 3 || (horiz && nodeM[q] !== 2) || (!horiz && nodeM[q] !== 1)) return false
        const gc = groupCards.get(nodeG[q])
        if (gc && cardsOf && cardsOf.some((c) => gc.has(c))) return false
      }
    }
    return true
  }
  const placeDirect = (e: Edge, mode: "straight" | "z"): boolean => {
    const A = m.get(e.from)!.rect, B = m.get(e.to)!.rect
    const G = gOf.get(e.id)!
    // candidates are collected, then the one crossing the fewest existing lines wins (ties: the
    // first, i.e. the one closest to the middle)
    let bestC: { p: Placed; x: number; rank: number } | undefined
    let rank = 0
    const tryPath = (pa: Port, pb: Port, pts: Pt[]): boolean => {
      rank++
      if (!okFree(pa) || !okFree(pb) || pa === pb) return false
      const ns: number[] = []
      for (let i = 1; i < pts.length; i++) { const seg = stepsBetween(pts[i - 1], pts[i]); ns.push(...(i === 1 ? seg : seg.slice(1))) }
      if (!pathOk(ns, [e.from, e.to])) return false
      const x = ns.filter((k) => nodeG[k] >= 0).length
      if (!bestC || x < bestC.x || (x === bestC.x && rank < bestC.rank)) bestC = { p: { edge: e, g: G, nodes: ns, from: pa, to: pb, cost: 0 }, x, rank }
      return x === 0
    }
    const commit = () => { if (!bestC) return false; placed.set(e.id, bestC.p); occupy(bestC.p, true); direct.add(e.id); return true }
    const ap = allPorts.get(e.from) ?? [], bp = allPorts.get(e.to) ?? []
    // vertical (B below or above A) and horizontal (B right or left of A) arrangements
    const arr: { sa: Side; sb: Side; axis: 0 | 1 }[] = []
    if (B.y >= A.y + A.h + 80) arr.push({ sa: "BOTTOM", sb: "TOP", axis: 1 })
    if (A.y >= B.y + B.h + 80) arr.push({ sa: "TOP", sb: "BOTTOM", axis: 1 })
    if (B.x >= A.x + A.w + 80) arr.push({ sa: "RIGHT", sb: "LEFT", axis: 0 })
    if (A.x >= B.x + B.w + 80) arr.push({ sa: "LEFT", sb: "RIGHT", axis: 0 })
    for (const { sa, sb, axis } of arr) {
      const pa = ap.filter((p) => p.side === sa), pb = bp.filter((p) => p.side === sb)
      // lateral coordinate of a port: x for vertical links, y for horizontal ones
      const lat = (p: Port) => (axis === 1 ? X(p.n1) : Y(p.n1))
      if (mode === "straight") {
        const common = pa.filter((p) => pb.some((q) => lat(q) === lat(p)))
        if (!common.length) continue
        const lo = Math.max(Math.min(...pa.map(lat)), Math.min(...pb.map(lat))), hi = Math.min(Math.max(...pa.map(lat)), Math.max(...pb.map(lat)))
        const mid = (lo + hi) / 2
        for (const p of [...common].sort((u, v) => Math.abs(lat(u) - mid) - Math.abs(lat(v) - mid))) {
          const q = pb.find((t) => lat(t) === lat(p))!
          if (tryPath(p, q, [[X(p.n1), Y(p.n1)], [X(q.n1), Y(q.n1)]])) return commit()
        }
      } else {
        if (!pa.length || !pb.length) continue
        // ports nearest each other; cross segment in the middle of the gap (then ±20, ±40…)
        const tb = (axis === 1 ? center(B)[0] : center(B)[1]), ta = (axis === 1 ? center(A)[0] : center(A)[1])
        const sa2 = [...pa].sort((u, v) => Math.abs(lat(u) - tb) - Math.abs(lat(v) - tb)).slice(0, 4)
        const sb2 = [...pb].sort((u, v) => Math.abs(lat(u) - ta) - Math.abs(lat(v) - ta)).slice(0, 4)
        const a0 = axis === 1 ? (sa === "BOTTOM" ? A.y + A.h : A.y) : (sa === "RIGHT" ? A.x + A.w : A.x)
        const b0 = axis === 1 ? (sb === "TOP" ? B.y : B.y + B.h) : (sb === "LEFT" ? B.x : B.x + B.w)
        const midG = Math.round(((a0 + b0) / 2) / P) * P
        const lo = Math.min(a0, b0) + 60, hi = Math.max(a0, b0) - 60
        for (const off of [0, 20, -20, 40, -40, 60, -60, 80, -80]) {
          const c = midG + off
          if (c < lo || c > hi) continue
          for (const p of sa2) for (const q of sb2) {
            if (Math.abs(lat(p) - lat(q)) < 40) continue // a straight link (or a 20px jog), not a Z
            const pts: Pt[] = axis === 1 ? [[X(p.n1), Y(p.n1)], [X(p.n1), c], [X(q.n1), c], [X(q.n1), Y(q.n1)]] : [[X(p.n1), Y(p.n1)], [c, Y(p.n1)], [c, Y(q.n1)], [X(q.n1), Y(q.n1)]]
            if (tryPath(p, q, pts)) return commit()
          }
        }
      }
    }
    return commit()
  }

  // ---- layered routing inside families (before any search) ----
  const portByKey = new Map<string, Port>()
  for (const list of allPorts.values()) for (const p of list) portByKey.set(portKey(p), p)
  const commitPath = (e: Edge, pa: Port, pb: Port, pts: Pt[], why: string[]): boolean => {
    if (!okFree(pa) || !okFree(pb)) return false
    const ns: number[] = []
    for (let i = 1; i < pts.length; i++) { const seg = stepsBetween(pts[i - 1], pts[i]); ns.push(...(i === 1 ? seg : seg.slice(1))) }
    if (!pathOk(ns, [e.from, e.to])) return false
    const p: Placed = { edge: e, g: gOf.get(e.id)!, nodes: ns, from: pa, to: pb, cost: 0 }
    placed.set(e.id, p); occupy(p, true); direct.add(e.id)
    if (why.length) bendCause.set(e.id, why)
    return true
  }
  const layeredStage = () => {
    // 1. same-row neighbours: one straight horizontal between the side centres
    for (const e of intra) {
      if (mode.get(e.id) !== "row") continue
      const pa = portByKey.get(prefPort.get(`${e.id}|0`) ?? ""), pb = portByKey.get(prefPort.get(`${e.id}|1`) ?? "")
      if (pa && pb && Y(pa.n1) === Y(pb.n1)) commitPath(e, pa, pb, [[X(pa.n1), Y(pa.n1)], [X(pb.n1), Y(pb.n1)]], [])
    }
    // 1b. loop returns (the step sequence closes on itself): one U through the gap below the row
    for (const e of intra) {
      if (mode.get(e.id) !== "loopback") continue
      const pa = portByKey.get(prefPort.get(`${e.id}|0`) ?? ""), pb = portByKey.get(prefPort.get(`${e.id}|1`) ?? "")
      if (!pa || !pb) continue
      for (const y of [Y(pa.n1) + 40, Y(pa.n1) + 60, Y(pa.n1) + 80]) if (commitPath(e, pa, pb, [[X(pa.n1), Y(pa.n1)], [X(pa.n1), y], [X(pb.n1), y], [X(pb.n1), Y(pb.n1)]], ["loop return: closes the step sequence below its row"])) break
    }
    // 2. adjacent rows: per gap, one horizontal track each, ordered so links in the gap don't cross
    const gaps = new Map<string, Edge[]>()
    for (const e of intra) {
      if (mode.get(e.id) !== "channel") continue
      const A = m.get(e.from)!, B = m.get(e.to)!
      const k = `${A.section}|${Math.min(rowIdx(A), rowIdx(B))}`
      gaps.set(k, [...(gaps.get(k) ?? []), e])
    }
    for (const [k, es] of gaps) {
      const [sid, ri] = k.split("|")
      const rows = rowsOf.get(sid)!
      const upper = L.nodes.filter((n) => n.section === sid && n.rect.y === rows[Number(ri)])
      const top = Math.max(...upper.map((n) => n.rect.y + n.rect.h)), bot = rows[Number(ri) + 1]
      type CE = { e: Edge; pa: Port; pb: Port; xa: number; xb: number; down: boolean }
      const ces: CE[] = []
      for (const e of es) {
        const pa = portByKey.get(prefPort.get(`${e.id}|0`) ?? ""), pb = portByKey.get(prefPort.get(`${e.id}|1`) ?? "")
        if (!pa || !pb) continue
        ces.push({ e, pa, pb, xa: X(pa.n1), xb: X(pb.n1), down: Y(pb.n1) > Y(pa.n1) })
      }
      // straight drops first
      for (const c of ces.filter((c) => c.xa === c.xb)) commitPath(c.e, c.pa, c.pb, [[c.xa, Y(c.pa.n1)], [c.xb, Y(c.pb.n1)]], [])
      const bent = ces.filter((c) => c.xa !== c.xb && !direct.has(c.e.id))
      // crossings between two links in the gap if a sits above b (upper = nearer the top row)
      const topX = (c: CE) => (c.down ? c.xa : c.xb), botX = (c: CE) => (c.down ? c.xb : c.xa)
      const span = (c: CE) => [Math.min(c.xa, c.xb), Math.max(c.xa, c.xb)]
      const crossIfAbove = (a: CE, b: CE) => { const [b0, b1] = span(b), [a0, a1] = span(a); return (botX(a) > b0 && botX(a) < b1 ? 1 : 0) + (topX(b) > a0 && topX(b) < a1 ? 1 : 0) }
      // order: insertion by fewest crossings against those already placed above
      const ordered: CE[] = []
      for (const c of [...bent].sort((a, b) => span(a)[1] - span(a)[0] - (span(b)[1] - span(b)[0]))) {
        let bestI = 0, bestX = Infinity
        for (let i = 0; i <= ordered.length; i++) {
          let x = 0
          for (let j = 0; j < ordered.length; j++) x += j < i ? crossIfAbove(ordered[j], c) : crossIfAbove(c, ordered[j])
          if (x < bestX) { bestX = x; bestI = i }
        }
        ordered.splice(bestI, 0, c)
      }
      // left-edge packing that keeps that order for overlapping spans
      const track = new Map<CE, number>()
      for (const c of ordered) {
        let t = 0
        for (const o of ordered) { if (o === c) break; const [a0, a1] = span(o), [c0, c1] = span(c); if (a0 <= c1 + 20 && c0 <= a1 + 20) t = Math.max(t, track.get(o)! + 1) }
        track.set(c, t)
      }
      const T = Math.max(0, ...[...track.values()]) + 1
      const mid = Math.round(((top + bot) / 2) / P) * P
      for (const c of ordered) {
        const y = mid + Math.round(track.get(c)! - (T - 1) / 2) * P
        const why = [`track ${track.get(c)! + 1} of ${T} in the gap between rows ${Number(ri) + 1} and ${Number(ri) + 2}`]
        if (!commitPath(c.e, c.pa, c.pb, [[c.xa, Y(c.pa.n1)], [c.xa, y], [c.xb, y], [c.xb, Y(c.pb.n1)]], why)) {
          // the planned track is taken: try the others in the gap, nearest the middle first
          for (const off of [20, -20, 40, -40, 60, -60, 80, -80]) if (commitPath(c.e, c.pa, c.pb, [[c.xa, Y(c.pa.n1)], [c.xa, y + off], [c.xb, y + off], [c.xb, Y(c.pb.n1)]], [`${why[0]} (shifted ${off}px: planned track taken)`])) break
        }
      }
    }
  }

  // order: bundles (long first), members sorted along their window so lanes nest; then intra edges
  const len = (e: Edge) => { const a = center(m.get(e.from)!.rect), b = center(m.get(e.to)!.rect); return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) }
  const bundles = [...pairs.values()].sort((p, q) => q.reduce((s, e) => s + len(e), 0) / q.length - p.reduce((s, e) => s + len(e), 0) / p.length)
  const order: Edge[] = []
  if (opts.plan) order.push(...[...L.edges].sort((p, q) => len(p) - len(q))) // nearest first: short links take the inner lanes
  else {
    for (const es of bundles) order.push(...[...es].sort((p, q) => gOf.get(p.id)! - gOf.get(q.id)! || len(q) - len(p)))
    order.push(...[...intra].sort((p, q) => len(q) - len(p)))
  }
  // rip-up-and-retry: whole attempts, moving edges that failed to the front each time
  const reset = () => {
    nodeG.fill(-1); nodeC.fill(0); nodeM.fill(0); nodeXG.fill(-1); nodeXC.fill(0); nodeXM.fill(0)
    edgeG.fill(-1); edgeC.fill(0); stub.fill(0); usedPort.clear(); placed.clear(); groupCards.clear()
  }
  const attempt = (ord: Edge[]): Edge[] => {
    reset()
    direct.clear()
    const failed: Edge[] = []
    layeredStage()
    for (const e of ord) if (routable(e) && !direct.has(e.id) && !place(e)) failed.push(e)
    for (const e of failed.splice(0)) if (!place(e)) failed.push(e)
    for (let pass = 0; pass < (opts.passes ?? 1); pass++) {
      for (const e of ord) {
        if (direct.has(e.id) || !routable(e)) continue
        const p = placed.get(e.id)
        if (!p) { if (place(e)) failed.splice(failed.indexOf(e), 1); continue }
        occupy(p, false)
        placed.delete(e.id)
        if (!place(e)) { placed.set(e.id, p); occupy(p, true) }
        else if (placed.get(e.id)!.cost > p.cost) { occupy(placed.get(e.id)!, false); placed.set(e.id, p); occupy(p, true) }
      }
    }
    return failed
  }
  let ord = order
  let best: { order: Edge[]; failed: number } | undefined
  let failed: Edge[] = []
  for (let t = 0; t < (opts.attempts ?? 6); t++) {
    failed = attempt(ord)
    if (!best || failed.length < best.failed) best = { order: ord, failed: failed.length }
    if (!failed.length) break
    ord = [...failed, ...ord.filter((e) => !failed.includes(e))]
  }
  if (failed.length > best!.failed) failed = attempt(best!.order)

  // undo lane swaps: re-route one bundle of a swapping pair so it may not cross the other at all;
  // keep the change only if the total number of swaps drops
  const curRoutes = () => [...placed.values()].map((p) => ({ edge: p.edge.id, pts: simplify([p.from.border, ...p.nodes.map((k) => [X(k), Y(k)] as Pt), p.to.border]), native: false, bundle: groupKey(p.edge) } as Route))
  const swapInfo = () => { const T: any = { ...L, routes: curRoutes(), labels: [], doorNodes: [] }; const c = checks(T, titles); return { n: c.laneSwaps * 100 + c.laneSwapsInSections, pairs: (T.swapGutterPairs as [string, string][]).concat(T.swapPairs) } }
  if (!failed.length) {
    let info = swapInfo()
    const tried = new Set<string>()
    const gidOf = (bk: string) => groupIds.get(bk)!
    for (let it = 0; it < (opts.unswap ?? 80) && info.n > 0; it++) {
      // gutter swaps first (they are hard failures), then swaps inside sections
      const pair = info.pairs.find((p) => !tried.has(p.join("#")))
      if (!pair) break
      tried.add(pair.join("#"))
      const [A, B] = pair
      // strategies: re-route B avoiding A; re-route A avoiding B; re-route both (each order)
      const plans: [string[], string][] = [[[B], A], [[A], B], [[A, B], B], [[B, A], A]]
      for (const [rip, avoidKey] of plans) {
        const members = [...placed.values()].filter((p) => rip.includes(groupKey(p.edge)) && !direct.has(p.edge.id))
        for (const p of members) { occupy(p, false); placed.delete(p.edge.id) }
        let ok = true
        for (const bk of rip) {
          avoidG = bk === avoidKey ? new Set() : new Set([gidOf(bk === A ? B : A)])
          if (rip.length === 2 && bk === rip[0]) avoidG = new Set()
          for (const p of members.filter((q) => groupKey(q.edge) === bk)) if (!place(p.edge)) ok = false
        }
        avoidG = new Set()
        const ni = ok ? swapInfo() : undefined
        if (ok && ni!.n < info.n) { info = ni!; tried.clear(); break }
        for (const p of members) { const q = placed.get(p.edge.id); if (q) { occupy(q, false); placed.delete(p.edge.id) } }
        for (const p of members) { placed.set(p.edge.id, p); occupy(p, true) }
      }
    }
  }

  if (opts.policy === "B") for (const p of placed.values()) {
    if (mode.get(p.edge.id) !== "astar") continue
    const pts = simplify([p.from.border, ...p.nodes.map((k) => [X(k), Y(k)] as Pt), p.to.border])
    if (monotonePts(pts)) continue
    const len = pts.slice(1).reduce((a, q, i) => a + Math.abs(q[0] - pts[i][0]) + Math.abs(q[1] - pts[i][1]), 0)
    const man = Math.abs(pts[0][0] - pts[pts.length - 1][0]) + Math.abs(pts[0][1] - pts[pts.length - 1][1])
    if (len / Math.max(40, man) > 1.25 || pts.length - 2 > 4) newTags.add(p.edge.id)
  }
  ;(L as any).policy = opts.policy ?? "A"
  // links that could only be routed non-monotonically become name tags: take their wires back out
  for (const id of newTags) { const p = placed.get(id); if (p) { occupy(p, false); placed.delete(id) } }
  ;(L as any).newTags = [...newTags]

  // ---- geometry: each edge's polyline (for metrics/labels) + each bundle drawn once as chains ----
  L.routes = []
  for (const e of L.edges) {
    const p = placed.get(e.id)
    if (!p) continue
    const pts: Pt[] = simplify([p.from.border, ...p.nodes.map((k) => [X(k), Y(k)] as Pt), p.to.border])
    L.routes.push({ edge: e.id, pts, native: false, fromMagnet: p.from.side, toMagnet: p.to.side, bundle: groupKey(e) } as Route)
  }
  const pieces: any[] = []
  const kindOfG = new Map<number, string>()
  for (const e of L.edges) kindOfG.set(gOf.get(e.id)!, e.kind)
  const byG = new Map<number, Placed[]>()
  for (const p of placed.values()) byG.set(p.g, [...(byG.get(p.g) ?? []), p])
  for (const [G, ps] of byG) {
    // union graph of the bundle's unit edges (plus the two stub segments to the card borders)
    const adj = new Map<string, Set<string>>()
    const key = (p: Pt) => `${p[0]},${p[1]}`
    const link = (a: Pt, b: Pt) => { for (const [u, v] of [[a, b], [b, a]]) { const s = adj.get(key(u)) ?? new Set(); s.add(key(v)); adj.set(key(u), s) } }
    const ends = new Set<string>()
    for (const p of ps) {
      const pts: Pt[] = [p.from.border, ...p.nodes.map((k) => [X(k), Y(k)] as Pt), p.to.border]
      for (let i = 1; i < pts.length; i++) link(pts[i - 1], pts[i])
      ends.add(key(p.from.border)); ends.add(key(p.to.border))
    }
    // chains between junctions/ends, so dashes run continuously and nothing is drawn twice
    const seen = new Set<string>()
    const isStop = (k: string) => ends.has(k) || (adj.get(k)?.size ?? 0) !== 2
    const parse = (k: string) => k.split(",").map(Number) as Pt
    for (const start of adj.keys()) {
      if (!isStop(start)) continue
      for (const nb of adj.get(start)!) {
        const ek = [start, nb].sort().join("|")
        if (seen.has(ek)) continue
        const chain = [start]
        let prev = start, cur = nb
        seen.add(ek)
        while (true) {
          chain.push(cur)
          if (isStop(cur)) break
          const nxt = [...adj.get(cur)!].find((x) => x !== prev)!
          const k2 = [cur, nxt].sort().join("|")
          if (seen.has(k2)) break
          seen.add(k2)
          prev = cur; cur = nxt
        }
        pieces.push({ id: `g${G}.${pieces.length}`, kind: kindOfG.get(G), pts: simplify(chain.map(parse)), arrow: false, count: ps.length, role: "chain" })
      }
    }
    // arrowheads: one per edge at its target border
    for (const p of ps) {
      const pts = simplify([p.from.border, ...p.nodes.map((k) => [X(k), Y(k)] as Pt), p.to.border])
      pieces.push({ id: `a.${p.edge.id}`, kind: kindOfG.get(G), pts: pts.slice(-2), arrow: true, arrowOnly: true, count: 1, role: "arrow" })
    }
  }
  ;(L as any).pieces = pieces
  ;(L as any).doors = windows.map((w) => { const R = sec.get(w.s)!.rect; const c = (w.lo + w.hi) / 2; return { pt: w.side === "TOP" ? [c, R.y] : w.side === "BOTTOM" ? [c, R.y + R.h] : w.side === "LEFT" ? [R.x, c] : [R.x + R.w, c] } })
  ;(L as any).doorNodes = [...doorOwner.keys()].filter((k) => doorOwner[k] >= 0).map((k) => [X(k), Y(k)])
  L.labels = placeLabels(L, titles)
  // explanations: every port deviation and every bend gets a cause
  const explain: Record<string, any> = {}
  const nodesSorted = L.nodes.filter((n) => n.obstacle)
  for (const r of L.routes) {
    const e = L.edges.find((x) => x.id === r.edge)!
    const ends: any = {}
    for (const [end, card, pt] of [[0, e.from, r.pts[0]], [1, e.to, r.pts[r.pts.length - 1]]] as [0 | 1, string, Pt][]) {
      const R = m.get(card)!.rect
      const onTB = pt[1] <= R.y || pt[1] >= R.y + R.h
      const dev = onTB ? pt[0] - (R.x + R.w / 2) : pt[1] - (R.y + R.h / 2)
      ends[end ? "to" : "from"] = { side: onTB ? (pt[1] <= R.y ? "TOP" : "BOTTOM") : (pt[0] <= R.x + R.w / 2 ? "LEFT" : "RIGHT"), deviation: Math.round(dev), cause: portCause.get(`${e.id}|${end}`) ?? "" }
    }
    const bends: string[] = []
    const given = bendCause.get(e.id)
    for (let i = 1; i + 1 < r.pts.length; i++) {
      if (given) { bends.push(given[0]); continue }
      const a = r.pts[i - 1], b = r.pts[i]
      const dx = Math.sign(b[0] - a[0]), dy = Math.sign(b[1] - a[1])
      const ahead = { x: Math.min(b[0], b[0] + dx * 200), y: Math.min(b[1], b[1] + dy * 200), w: Math.abs(dx) * 200 || 1, h: Math.abs(dy) * 200 || 1 }
      const hit = nodesSorted.find((n) => n.id !== e.to && n.id !== e.from && ahead.x < n.rect.x + n.rect.w + 20 && n.rect.x - 20 < ahead.x + ahead.w && ahead.y < n.rect.y + n.rect.h + 20 && n.rect.y - 20 < ahead.y + ahead.h)
      const wall = L.sections.find((sc) => { const R = sc.rect; return (dx && ((b[0] < R.x && b[0] + dx * 200 >= R.x) || (b[0] > R.x + R.w && b[0] + dx * 200 <= R.x + R.w) || (b[0] > R.x && b[0] < R.x + R.w && (b[0] + dx * 200 <= R.x || b[0] + dx * 200 >= R.x + R.w)))) || (dy && ((b[1] < R.y && b[1] + dy * 200 >= R.y) || (b[1] > R.y && b[1] < R.y + R.h && (b[1] + dy * 200 <= R.y || b[1] + dy * 200 >= R.y + R.h)))) })
      bends.push(hit ? `turns before ${(hit.text ?? hit.id).split("\n")[0]}` : wall ? `turns at the ${wall.name} wall / door` : i === 1 || i + 2 === r.pts.length ? "turns toward its port" : "turns toward the target")
    }
    explain[e.id] = { mode: mode.get(e.id), from: ends.from, to: ends.to, bends }
  }
  ;(L as any).explain = explain
  L.checks = checks(L, titles)
  L.checks.unrouted = failed.length
  L.notes = [`${L.routes.length}/${L.edges.length} routed in ${byG.size} bundles/lanes; ${windows.length} door windows; ${failed.length} unrouted: ${failed.map((e) => e.id).join(",")}`]
  return L
}

// ---------------------------------------------------------------- labels
const segsOf = (L: Layout) => L.routes.flatMap((r) => r.pts.slice(1).map((q, i) => ({ edge: r.edge, bundle: r.bundle ?? r.edge, a: r.pts[i], b: q })))
const hitRect = (a: Pt, b: Pt, r: Rect, pad = 0) => Math.max(a[0], b[0]) > r.x - pad && Math.min(a[0], b[0]) < r.x + r.w + pad && Math.max(a[1], b[1]) > r.y - pad && Math.min(a[1], b[1]) < r.y + r.h + pad
const rectsHit = (a: Rect, b: Rect, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad
// caption text (13px Inter) runs ~6.6px per character; plan 7.5 + 24 so a label never truncates
export const labelSize = (t: string) => ({ w: Math.round(t.length * 7.5 + 24), h: 24 })

export function placeLabels(L: Layout, titles: Rect[]): Label[] {
  const segs = segsOf(L)
  const cards = L.nodes.map((n) => n.rect)
  const out: Label[] = []
  const borders = L.sections.flatMap((s) => { const R = s.rect; return [[[R.x, R.y], [R.x + R.w, R.y]], [[R.x, R.y + R.h], [R.x + R.w, R.y + R.h]], [[R.x, R.y], [R.x, R.y + R.h]], [[R.x + R.w, R.y], [R.x + R.w, R.y + R.h]]] as [Pt, Pt][] })
  const free = (r: Rect) => !segs.some((s) => hitRect(s.a, s.b, r, 3)) && !cards.some((c) => rectsHit(r, c, 8)) && !titles.some((t) => rectsHit(r, t, 8)) && !out.some((o) => rectsHit(r, o.rect, 6)) && !borders.some(([a, b]) => hitRect(a, b, r, 4))
  for (const r of L.routes) {
    const e = L.edges.find((x) => x.id === r.edge)!
    if (!e.label) continue
    const { w, h } = labelSize(e.label)
    let best: Rect | undefined
    // straight segments of its own line, last first (near the target reads best), skipping the stubs
    for (let i = r.pts.length - 1; i > 0 && !best; i--) {
      const a = r.pts[i - 1], b = r.pts[i]
      const vertical = a[0] === b[0]
      const L0 = Math.abs(vertical ? b[1] - a[1] : b[0] - a[0])
      const need = (vertical ? h : w) + 48
      if (L0 < need) continue
      for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) {
        const cx = a[0] + (b[0] - a[0]) * t, cy = a[1] + (b[1] - a[1]) * t
        for (const sgn of [1, -1]) {
          const rect = vertical ? { x: sgn > 0 ? cx + 6 : cx - 6 - w, y: cy - h / 2, w, h } : { x: cx - w / 2, y: sgn > 0 ? cy - 6 - h : cy + 6, w, h }
          const rr = { x: Math.round(rect.x), y: Math.round(rect.y), w, h }
          if (free(rr)) { best = rr; break }
        }
        if (best) break
      }
    }
    if (best) out.push({ edge: e.id, text: e.label, rect: best })
  }
  return out
}

// ---------------------------------------------------------------- self-checks
export function checks(L: Layout, titles: Rect[]): Record<string, number> {
  const segs = segsOf(L)
  const edge = new Map(L.edges.map((e) => [e.id, e]))
  const cards = L.nodes.filter((n) => n.obstacle)
  let swapsInside = 0
  let minPitch = Infinity, pitchViolations = 0, shortJogs = 0, clearance = 0, borderRuns = 0, titleHits = 0, portViolations = 0, nearCross = 0, swaps = 0, labelHits = 0
  // parallel pitch
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const A = segs[i], B = segs[j]
    if (A.edge === B.edge || A.bundle === B.bundle) continue
    const hA = A.a[1] === A.b[1], hB = B.a[1] === B.b[1]
    if (hA !== hB) continue
    const [p, q] = hA ? [[A.a[0], A.b[0]], [B.a[0], B.b[0]]] : [[A.a[1], A.b[1]], [B.a[1], B.b[1]]]
    const ov = Math.min(Math.max(...p), Math.max(...q)) - Math.max(Math.min(...p), Math.min(...q))
    if (ov <= 0) continue
    const d = hA ? Math.abs(A.a[1] - B.a[1]) : Math.abs(A.a[0] - B.a[0])
    minPitch = Math.min(minPitch, d)
    if (d < 16) pitchViolations++
  }
  // short jogs (interior segments) and clearance
  for (const r of L.routes) {
    for (let i = 1; i + 2 < r.pts.length; i++) { const a = r.pts[i], b = r.pts[i + 1]; if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 24) shortJogs++ }
    const e = edge.get(r.edge)!
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const a = r.pts[i], b = r.pts[i + 1]
      const stub = i === 0 || i + 2 === r.pts.length
      for (const c of cards) {
        if ((c.id === e.from || c.id === e.to) && stub) continue
        if (hitRect(a, b, c.rect, 16)) { clearance++; break }
      }
      for (const t of titles) if (hitRect(a, b, t, 0)) titleHits++
      for (const s of L.sections) {
        const R = s.rect
        const h = a[1] === b[1]
        const lines = h ? [R.y, R.y + R.h] : [R.x, R.x + R.w]
        const [lo, hi] = h ? [R.x, R.x + R.w] : [R.y, R.y + R.h]
        const c = h ? a[1] : a[0]
        const [u, v] = h ? [Math.min(a[0], b[0]), Math.max(a[0], b[0])] : [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
        if (lines.some((l) => Math.abs(l - c) < 12) && v > lo && u < hi && v - u > 0) borderRuns++
      }
    }
  }
  // ports: spacing per card side and corner distance
  const ends = new Map<string, number[]>()
  for (const r of L.routes) {
    const e = edge.get(r.edge)!
    for (const [p, card] of [[r.pts[0], e.from], [r.pts[r.pts.length - 1], e.to]] as [Pt, string][]) {
      const c = L.nodes.find((n) => n.id === card)!.rect
      const side = p[1] === c.y ? "T" : p[1] === c.y + c.h ? "B" : p[0] === c.x ? "L" : p[0] === c.x + c.w ? "R" : "N" // N: a chevron notch
      const t = side === "T" || side === "B" ? p[0] - c.x : p[1] - c.y
      const len = side === "T" || side === "B" ? c.w : c.h
      if (t < 16 || len - t < 16) portViolations++
      const k = `${card}|${side}`
      ends.set(k, [...(ends.get(k) ?? []), t])
    }
  }
  let tightPorts = 0
  for (const ts of ends.values()) { ts.sort((a, b) => a - b); for (let i = 1; i < ts.length; i++) { if (ts[i] - ts[i - 1] < 20) portViolations++; if (ts[i] - ts[i - 1] < 40) tightPorts++ } }
  // stubs: first/last segment perpendicular to its side, ≥ 24px; arrowhead points into the card
  let stubViolations = 0, arrowDirection = 0
  for (const r of L.routes) {
    const e = edge.get(r.edge)!
    for (const [id, p, q, isEnd] of [[e.from, r.pts[0], r.pts[1], false], [e.to, r.pts[r.pts.length - 1], r.pts[r.pts.length - 2], true]] as [string, Pt, Pt, boolean][]) {
      const c = L.nodes.find((n) => n.id === id)!.rect
      const side = p[1] <= c.y ? "T" : p[1] >= c.y + c.h ? "B" : p[0] <= c.x + c.w / 2 ? "L" : "R"
      const perp = side === "T" || side === "B" ? p[0] === q[0] : p[1] === q[1]
      const len = Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1])
      if (!perp || len < 24) stubViolations++
      if (isEnd) {
        const dx = Math.sign(p[0] - q[0]), dy = Math.sign(p[1] - q[1])
        const inward = side === "T" ? dy > 0 && !dx : side === "B" ? dy < 0 && !dx : side === "L" ? dx > 0 && !dy : dx < 0 && !dy
        if (!inward) arrowDirection++
      }
    }
  }
  // crossings: near doors/ports, and lane swaps (two lanes that run side by side and also cross)
  const doorNodes = ((L as any).doorNodes ?? []) as Pt[]
  const crossAt = (A: { a: Pt; b: Pt }, B: { a: Pt; b: Pt }): Pt | undefined => {
    const hA = A.a[1] === A.b[1], hB = B.a[1] === B.b[1]
    if (hA === hB) return undefined
    const H = hA ? A : B, V = hA ? B : A
    const x = V.a[0], y = H.a[1]
    if (x > Math.min(H.a[0], H.b[0]) && x < Math.max(H.a[0], H.b[0]) && y > Math.min(V.a[1], V.b[1]) && y < Math.max(V.a[1], V.b[1])) return [x, y]
    return undefined
  }
  // per bundle (members share lanes by design), segments deduplicated
  const byRoute = new Map<string, { a: Pt; b: Pt }[]>()
  const segSeen = new Set<string>()
  for (const s of segs) {
    const k = `${s.bundle}|${s.a}|${s.b}`
    if (segSeen.has(k)) continue
    segSeen.add(k)
    byRoute.set(s.bundle, [...(byRoute.get(s.bundle) ?? []), s])
  }
  const rs = [...byRoute.entries()]
  let crossings = 0
  const swapPts: Pt[] = []
  ;(L as any).swapPts = swapPts
  const swapPairs: [string, string][] = []
  ;(L as any).swapPairs = swapPairs
  const swapGutterPairs: [string, string][] = []
  ;(L as any).swapGutterPairs = swapGutterPairs
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const xs: Pt[] = [], stretches: Rect[] = []
    const xSeen = new Set<string>()
    for (const A of rs[i][1]) for (const B of rs[j][1]) {
      const x = crossAt(A, B)
      if (x && !xSeen.has(`${x}`)) {
        xSeen.add(`${x}`)
        crossings++
        xs.push(x)
        if (doorNodes.some((d) => Math.abs(d[0] - x[0]) <= 40 && Math.abs(d[1] - x[1]) <= 40)) nearCross++
        if (cards.some((c) => hitRect(x, x, c.rect, 16))) nearCross++ // on a stub
      }
      const hA = A.a[1] === A.b[1], hB = B.a[1] === B.b[1]
      if (hA === hB) {
        const d = hA ? Math.abs(A.a[1] - B.a[1]) : Math.abs(A.a[0] - B.a[0])
        const [p, q] = hA ? [[A.a[0], A.b[0]], [B.a[0], B.b[0]]] : [[A.a[1], A.b[1]], [B.a[1], B.b[1]]]
        const ov = Math.min(Math.max(...p), Math.max(...q)) - Math.max(Math.min(...p), Math.min(...q))
        if (d <= 20 && ov >= 120) stretches.push({ x: Math.min(A.a[0], A.b[0], B.a[0], B.b[0]), y: Math.min(A.a[1], A.b[1], B.a[1], B.b[1]), w: Math.abs(Math.max(A.a[0], A.b[0], B.a[0], B.b[0]) - Math.min(A.a[0], A.b[0], B.a[0], B.b[0])), h: Math.abs(Math.max(A.a[1], A.b[1], B.a[1], B.b[1]) - Math.min(A.a[1], A.b[1], B.a[1], B.b[1])) })
      }
    }
    const sw = xs.filter((x) => stretches.some((s) => hitRect(x, x, s, 120)))
    const inSec = (x: Pt) => L.sections.some((s) => x[0] > s.rect.x && x[0] < s.rect.x + s.rect.w && x[1] > s.rect.y && x[1] < s.rect.y + s.rect.h)
    if (sw.some((x) => !inSec(x))) { swaps++; swapPts.push(...sw.filter((x) => !inSec(x))) } else if (sw.length) swapsInside++
    if (sw.length) swapPairs.push([rs[i][0], rs[j][0]])
    if (sw.some((x) => !inSec(x))) swapGutterPairs.push([rs[i][0], rs[j][0]])
  }
  // arrowheads (14 × 12px at each target border) must not touch other bundles' lines
  let arrowHits = 0
  for (const r of L.routes) {
    const a = r.pts[r.pts.length - 2], b = r.pts[r.pts.length - 1]
    const vx = Math.sign(b[0] - a[0]), vy = Math.sign(b[1] - a[1])
    const box: Rect = vx ? { x: Math.min(b[0], b[0] - vx * 14), y: b[1] - 6, w: 14, h: 12 } : { x: b[0] - 6, y: Math.min(b[1], b[1] - vy * 14), w: 12, h: 14 }
    if (segs.some((s) => s.bundle !== (r.bundle ?? r.edge) && hitRect(s.a, s.b, box, 2))) arrowHits++
  }
  // labels
  for (const l of L.labels ?? []) {
    if (segs.some((s) => hitRect(s.a, s.b, l.rect, 2))) labelHits++
    if (cards.some((c) => rectsHit(l.rect, c.rect))) labelHits++
    if (titles.some((t) => rectsHit(l.rect, t))) labelHits++
  }
  const labels = L.labels ?? []
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) if (rectsHit(labels[i].rect, labels[j].rect)) labelHits++
  const wanted = L.edges.filter((e) => e.label).length
  // quality scores: detour ratio, wire length, bends, perimeter wrapping, box runs, crossing pairs
  const lenOf = (pts: Pt[]) => pts.slice(1).reduce((a, q, i) => a + Math.abs(q[0] - pts[i][0]) + Math.abs(q[1] - pts[i][1]), 0)
  const ratios = L.routes.map((r) => { const a = r.pts[0], b = r.pts[r.pts.length - 1]; return lenOf(r.pts) / Math.max(40, Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])) }).sort((a, b) => a - b)
  const wire = [...byRoute.values()].reduce((a, ss) => a + ss.reduce((b, sg) => b + Math.abs(sg.b[0] - sg.a[0]) + Math.abs(sg.b[1] - sg.a[1]), 0), 0)
  const secs = L.sections.map((s) => s.rect)
  const bx0 = Math.min(...secs.map((r) => r.x)), by0 = Math.min(...secs.map((r) => r.y)), bx1 = Math.max(...secs.map((r) => r.x + r.w)), by1 = Math.max(...secs.map((r) => r.y + r.h))
  let perimeterWraps = 0, boxRuns = 0
  const nodeSec = new Map(L.nodes.map((n) => [n.id, n.section]))
  for (const r of L.routes) {
    if (r.pts.some((p) => p[0] < bx0 || p[0] > bx1 || p[1] < by0 || p[1] > by1)) perimeterWraps++
    const e = edge.get(r.edge)!
    for (const sc of L.sections) {
      if (nodeSec.get(e.from) === sc.id || nodeSec.get(e.to) === sc.id) continue
      const R = sc.rect
      let sides = 0
      for (const [horiz, line, lo, hi] of [[true, R.y, R.x, R.x + R.w], [true, R.y + R.h, R.x, R.x + R.w], [false, R.x, R.y, R.y + R.h], [false, R.x + R.w, R.y, R.y + R.h]] as [boolean, number, number, number][]) {
        let run = 0
        for (let i = 0; i + 1 < r.pts.length; i++) {
          const a = r.pts[i], b = r.pts[i + 1]
          if (horiz !== (a[1] === b[1])) continue
          const c = horiz ? a[1] : a[0]
          if (Math.abs(c - line) > 140) continue
          const u = Math.max(lo, Math.min(horiz ? a[0] : a[1], horiz ? b[0] : b[1])), v = Math.min(hi, Math.max(horiz ? a[0] : a[1], horiz ? b[0] : b[1]))
          run += Math.max(0, v - u)
        }
        if (run >= 0.25 * (hi - lo)) sides++
      }
      if (sides >= 2) boxRuns++
    }
  }
  // geometry defects: there-and-back jogs, missed straight links, Z's with extra bends, shared
  // trunks splitting onto one card side, arrows into a slanted end
  let sJogs = 0, cornerPorts = 0, nestingViolations = 0
  let thereAndBack = 0, straightMissed = 0, zExtraBends = 0, sharedSplits = 0, slantedEntries = 0, bendsMax = 0
  const flat = (n: typeof L.nodes[number], side: "H" | "V"): [number, number] => {
    const r = n.rect, sh = String(n.style?.shape ?? "")
    const rad = sh === "ROUNDED_RECTANGLE" || sh === "" ? Math.min(r.w, r.h) / 2 : 0
    if (side === "H") return sh === "HEXAGON" ? [r.x + r.w * 0.14 + 16, r.x + r.w - r.w * 0.14 - 16] : sh === "CHEVRON" ? [r.x + 20, r.x + r.w - r.w * 0.12 - 16] : [r.x + Math.max(20, rad + 16), r.x + r.w - Math.max(20, rad + 16)]
    return sh === "HEXAGON" || sh === "CHEVRON" || sh === "ELLIPSE" || rad >= r.h / 2 - 1 ? [r.y + r.h / 2, r.y + r.h / 2] : [r.y + 20, r.y + r.h - 20]
  }
  const nodeById = new Map(L.nodes.map((n) => [n.id, n]))
  const clearStrip = (x0: number, y0: number, x1: number, y1: number, skip: string[]) => !cards.some((c) => !skip.includes(c.id) && hitRect([x0, y0], [x1, y1], c.rect, 16))
  for (const r of L.routes) {
    const bends = Math.max(0, r.pts.length - 2)
    bendsMax = Math.max(bendsMax, bends)
    for (let i = 1; i + 2 < r.pts.length; i++) {
      // S-jog: a short sideways step (≤ 60px) between two runs going the same way
      const a = r.pts[i - 1], b = r.pts[i], c = r.pts[i + 1], d = r.pts[i + 2]
      const mid = Math.abs(c[0] - b[0]) + Math.abs(c[1] - b[1])
      const sameWay = Math.sign(b[0] - a[0]) === Math.sign(d[0] - c[0]) && Math.sign(b[1] - a[1]) === Math.sign(d[1] - c[1])
      if (mid <= 60 && sameWay) sJogs++
    }
    // step out and back: run, short sideways step, run, short step back, run on the first line
    for (let i = 0; i + 5 < r.pts.length; i++) {
      const a = r.pts[i], b = r.pts[i + 1], c = r.pts[i + 2], d = r.pts[i + 3], f = r.pts[i + 4], g = r.pts[i + 5]
      const vert = a[0] === b[0]
      const sameLine = vert ? a[0] === f[0] && f[0] === g[0] : a[1] === f[1] && f[1] === g[1]
      const out = Math.abs(c[0] - b[0]) + Math.abs(c[1] - b[1]), back = Math.abs(f[0] - d[0]) + Math.abs(f[1] - d[1])
      if (sameLine && out <= 120 && back <= 120) thereAndBack++
    }
    for (let i = 0; i + 3 < r.pts.length; i++) {
      const a = r.pts[i], b = r.pts[i + 1], c = r.pts[i + 2], d = r.pts[i + 3]
      const v1 = a[0] === b[0], v3 = c[0] === d[0]
      const midLen = Math.abs(c[0] - b[0]) + Math.abs(c[1] - b[1])
      if (v1 && v3 && a[0] === c[0] && midLen <= 120) thereAndBack++
      else if (!v1 && !v3 && a[1] === c[1] && midLen <= 120) thereAndBack++
      else if (v1 && v3 && b[0] === d[0] && false) thereAndBack++
    }
    const e = edge.get(r.edge)!
    const A = nodeById.get(e.from)!, B = nodeById.get(e.to)!
    if (A.section && A.section === B.section) {
      const ar = A.rect, br = B.rect
      for (const [vert, apart] of [[true, br.y >= ar.y + ar.h + 80 || ar.y >= br.y + br.h + 80], [false, br.x >= ar.x + ar.w + 80 || ar.x >= br.x + br.w + 80]] as [boolean, boolean][]) {
        if (!apart) continue
        const [p0, p1] = flat(A, vert ? "H" : "V"), [q0, q1] = flat(B, vert ? "H" : "V")
        const lo = Math.max(p0, q0), hi = Math.min(p1, q1)
        const yTop = vert ? Math.min(ar.y + ar.h, br.y + br.h) : 0, yBot = vert ? Math.max(ar.y, br.y) : 0
        const xL = vert ? 0 : Math.min(ar.x + ar.w, br.x + br.w), xR = vert ? 0 : Math.max(ar.x, br.x)
        let straightOk = false
        for (let c = Math.ceil(lo / 20) * 20; c <= hi && !straightOk; c += 20) straightOk = vert ? clearStrip(c, yTop, c, yBot, [A.id, B.id]) : clearStrip(xL, c, xR, c, [A.id, B.id])
        const cA = vert ? ar.x + ar.w / 2 : ar.y + ar.h / 2, cB = vert ? br.x + br.w / 2 : br.y + br.h / 2
        if (straightOk && Math.abs(cA - cB) <= 40 && bends > 0) straightMissed++
        const zClear = vert ? clearStrip(Math.min(ar.x, br.x), yTop, Math.max(ar.x + ar.w, br.x + br.w), yBot, [A.id, B.id]) : clearStrip(xL, Math.min(ar.y, br.y), xR, Math.max(ar.y + ar.h, br.y + br.h), [A.id, B.id])
        if (!straightOk && zClear && bends > 2) zExtraBends++
      }
    }
    const end = r.pts[r.pts.length - 1], sh = String(B.style?.shape ?? "")
    if ((sh === "HEXAGON" || sh === "CHEVRON" || sh === "ROUNDED_RECTANGLE") && end[1] > B.rect.y && end[1] < B.rect.y + B.rect.h && Math.abs(end[1] - (B.rect.y + B.rect.h / 2)) > 10) slantedEntries++
    // ports must sit on the flat part of a side (outside the corner radius / slant, + 16px)
    for (const [n, p] of [[A, r.pts[0]], [B, end]] as [typeof A, Pt][]) {
      const R = n.rect
      if (p[1] === R.y || p[1] === R.y + R.h) { const [f0, f1] = flat(n, "H"); if (p[0] < f0 - 0.5 || p[0] > f1 + 0.5) cornerPorts++ }
      else if (p[0] === R.x || p[0] === R.x + R.w) { const [f0, f1] = flat(n, "V"); if (p[1] < f0 - 10 || p[1] > f1 + 10) cornerPorts++ }
    }
  }
  // shared trunks: two edges on the same card side that share a segment inside that card's family
  const sideOf = (n: typeof L.nodes[number], p: Pt) => (p[1] <= n.rect.y ? "T" : p[1] >= n.rect.y + n.rect.h ? "B" : p[0] <= n.rect.x + n.rect.w / 2 ? "L" : "R")
  const sideEnds = new Map<string, { r: Route; sec: string }[]>()
  for (const r of L.routes) {
    const e = edge.get(r.edge)!
    for (const [id, p] of [[e.from, r.pts[0]], [e.to, r.pts[r.pts.length - 1]]] as [string, Pt][]) {
      const n = nodeById.get(id)!
      const k = `${id}|${sideOf(n, p)}`
      sideEnds.set(k, [...(sideEnds.get(k) ?? []), { r, sec: n.section ?? "" }])
    }
  }
  const inSecRect = (p: Pt, sid: string) => { const R = L.sections.find((x) => x.id === sid)?.rect; return !!R && p[0] >= R.x && p[0] <= R.x + R.w && p[1] >= R.y && p[1] <= R.y + R.h }
  for (const list of sideEnds.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const A = list[i].r, B = list[j].r
    let shared = false
    for (let s = 0; s + 1 < A.pts.length && !shared; s++) for (let t = 0; t + 1 < B.pts.length && !shared; t++) {
      const a = A.pts[s], b = A.pts[s + 1], c = B.pts[t], d = B.pts[t + 1]
      const h = a[1] === b[1] && c[1] === d[1] && a[1] === c[1], v = a[0] === b[0] && c[0] === d[0] && a[0] === c[0]
      if (!h && !v) continue
      const [p0, p1] = h ? [Math.min(a[0], b[0]), Math.max(a[0], b[0])] : [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
      const [q0, q1] = h ? [Math.min(c[0], d[0]), Math.max(c[0], d[0])] : [Math.min(c[1], d[1]), Math.max(c[1], d[1])]
      const o0 = Math.max(p0, q0), o1 = Math.min(p1, q1)
      if (o1 - o0 > 0) { const mid: Pt = h ? [(o0 + o1) / 2, a[1]] : [a[0], (o0 + o1) / 2]; if (inSecRect(mid, list[i].sec)) shared = true }
    }
    if (shared) sharedSplits++
    // nesting: two links leaving (or entering) the same side must not cross each other at all
    let crossed = false
    for (let s2 = 0; s2 + 1 < A.pts.length && !crossed; s2++) for (let t = 0; t + 1 < B.pts.length && !crossed; t++) {
      const a = A.pts[s2], b = A.pts[s2 + 1], c = B.pts[t], d = B.pts[t + 1]
      const hA = a[1] === b[1], hB = c[1] === d[1]
      if (hA === hB) continue
      const H = hA ? [a, b] : [c, d], V = hA ? [c, d] : [a, b]
      const x = V[0][0], y = H[0][1]
      if (x > Math.min(H[0][0], H[1][0]) && x < Math.max(H[0][0], H[1][0]) && y > Math.min(V[0][1], V[1][1]) && y < Math.max(V[0][1], V[1][1])) crossed = true
    }
    if (crossed) nestingViolations++
  }
  // monotone inside sections, detour inside sections, centred ports and their causes
  let nonMonotone = 0, sectionDetour = 0, unexplainedPorts = 0, offCenterAlone = 0, devSum = 0, devN = 0, centred = 0
  const ex = ((L as any).explain ?? {}) as Record<string, any>
  const secRect = (id?: string) => L.sections.find((x) => x.id === id)?.rect
  const inRect = (p: Pt, R?: Rect) => !!R && p[0] >= R.x && p[0] <= R.x + R.w && p[1] >= R.y && p[1] <= R.y + R.h
  const dXr = (p: Pt, R: Rect) => Math.max(0, R.x - p[0], p[0] - R.x - R.w), dYr = (p: Pt, R: Rect) => Math.max(0, R.y - p[1], p[1] - R.y - R.h)
  const sideCount = new Map<string, number>()
  for (const r of L.routes) {
    const e = edge.get(r.edge)!
    for (const [id, p] of [[e.from, r.pts[0]], [e.to, r.pts[r.pts.length - 1]]] as [string, Pt][]) {
      const n = nodeById.get(id)!
      const k = `${id}|${sideOf(n, p)}`
      sideCount.set(k, (sideCount.get(k) ?? 0) + 1)
    }
  }
  for (const r of L.routes) {
    const e = edge.get(r.edge)!
    const A = nodeById.get(e.from)!, B = nodeById.get(e.to)!
    const SS = secRect(A.section), TS = secRect(B.section)
    let bad = false
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i]
      if (inRect(a, TS) && inRect(b, TS) && (dXr(b, B.rect) > dXr(a, B.rect) || dYr(b, B.rect) > dYr(a, B.rect))) bad = true
      if (SS !== TS && inRect(a, SS) && inRect(b, SS) && (dXr(b, A.rect) < dXr(a, A.rect) || dYr(b, A.rect) < dYr(a, A.rect))) bad = true
    }
    if (bad && e.kind !== "loop") nonMonotone++
    if (A.section && A.section === B.section) {
      const s0 = r.pts[0], s1 = r.pts[r.pts.length - 1]
      const len = r.pts.slice(1).reduce((acc, q, i) => acc + Math.abs(q[0] - r.pts[i][0]) + Math.abs(q[1] - r.pts[i][1]), 0)
      if (len / Math.max(40, Math.abs(s0[0] - s1[0]) + Math.abs(s0[1] - s1[1])) > 1.25) sectionDetour++
    }
    for (const [n, p, end] of [[A, r.pts[0], "from"], [B, r.pts[r.pts.length - 1], "to"]] as [typeof A, Pt, string][]) {
      const R = n.rect
      const onTB = p[1] <= R.y || p[1] >= R.y + R.h
      const dev = Math.abs(onTB ? p[0] - (R.x + R.w / 2) : p[1] - (R.y + R.h / 2))
      const len = onTB ? R.w : R.h
      devSum += dev; devN++
      if (dev < 1) centred++
      const cause = ex[r.edge]?.[end]?.cause
      if (dev >= 1 && !cause) unexplainedPorts++
      if ((sideCount.get(`${n.id}|${sideOf(n, p)}`) ?? 0) === 1 && dev > 0.25 * len) offCenterAlone++
    }
  }
  // global monotonicity (the loop's closing arrow is exempt) and wall crossings only at doors
  let nonMonotoneGlobal = 0, wallOutsideDoor = 0
  const doorSet = new Set((((L as any).doorNodes ?? []) as Pt[]).map((d) => `${d[0]},${d[1]}`))
  for (const r of L.routes) {
    const e = edge.get(r.edge)!
    if (e.kind !== "loop") {
      let sx = 0, sy = 0, bad = false
      for (let i = 1; i < r.pts.length; i++) {
        const dx = Math.sign(r.pts[i][0] - r.pts[i - 1][0]), dy = Math.sign(r.pts[i][1] - r.pts[i - 1][1])
        if (dx) { if (sx && dx !== sx) bad = true; sx = dx }
        if (dy) { if (sy && dy !== sy) bad = true; sy = dy }
      }
      if (bad && (L as any).policy === "B") {
        const len = r.pts.slice(1).reduce((acc, q, i) => acc + Math.abs(q[0] - r.pts[i][0]) + Math.abs(q[1] - r.pts[i][1]), 0)
        const man = Math.abs(r.pts[0][0] - r.pts[r.pts.length - 1][0]) + Math.abs(r.pts[0][1] - r.pts[r.pts.length - 1][1])
        const sameFam = L.nodes.find((n) => n.id === e.from)?.section === L.nodes.find((n) => n.id === e.to)?.section
        if (sameFam || len / Math.max(40, man) > 1.25 || r.pts.length - 2 > 4) nonMonotoneGlobal++
      } else if (bad) nonMonotoneGlobal++
    }
    if (doorSet.size) for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i]
      for (const sc of L.sections) {
        const R = sc.rect
        if (a[0] === b[0]) {
          for (const yy of [R.y, R.y + R.h]) if (a[0] > R.x && a[0] < R.x + R.w && Math.min(a[1], b[1]) < yy && Math.max(a[1], b[1]) > yy && !doorSet.has(`${a[0]},${yy}`)) wallOutsideDoor++
        } else {
          for (const xx of [R.x, R.x + R.w]) if (a[1] > R.y && a[1] < R.y + R.h && Math.min(a[0], b[0]) < xx && Math.max(a[0], b[0]) > xx && !doorSet.has(`${xx},${a[1]}`)) wallOutsideDoor++
        }
      }
    }
  }
  const crossingPairs = new Set<string>()
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    if (rs[i][1].some((A) => rs[j][1].some((B) => crossAt(A, B)))) crossingPairs.add(`${i}#${j}`)
  }
  return {
    minPitch: minPitch === Infinity ? 0 : minPitch, pitchViolations, shortJogs, portViolations, clearance, borderRuns, titleHits, labelHits,
    crossings, crossingPairs: crossingPairs.size, nearCross, arrowHits, laneSwaps: swaps, perimeterWraps, boxRuns,
    detourMax: Math.round((ratios[ratios.length - 1] ?? 0) * 100) / 100, detourP95: Math.round((ratios[Math.floor(ratios.length * 0.95)] ?? 0) * 100) / 100,
    stubViolations, arrowDirection, tightPorts,
    thereAndBack, sJogs, cornerPorts, nestingViolations, nonMonotone, nonMonotoneGlobal, wallOutsideDoor, sectionDetour, unexplainedPorts, offCenterAlone,
    meanPortDeviation: Math.round(devSum / Math.max(1, devN)), centredShare: Math.round((centred / Math.max(1, devN)) * 100) / 100,
    straightMissed, zExtraBends, sharedSplits, slantedEntries, bendsMax,
    wireLength: Math.round(wire), bendsPerEdge: Math.round((L.routes.reduce((a, r) => a + Math.max(0, r.pts.length - 2), 0) / Math.max(1, L.routes.length)) * 100) / 100, laneSwapsInSections: swapsInside, labelsPlaced: labels.length, labelsDropped: wanted - labels.length, labelsTruncated: labels.filter((l) => l.rect.w < labelSize(l.text).w).length,
  }
}

export const HARD_CHECKS = ["pitchViolations", "shortJogs", "portViolations", "clearance", "borderRuns", "titleHits", "labelHits", "labelsTruncated", "nearCross", "arrowHits", "laneSwaps", "perimeterWraps", "unrouted", "tagHits", "tagsUnplaced", "thereAndBack", "straightMissed", "zExtraBends", "sharedSplits", "slantedEntries", "cornerPorts", "nestingViolations", "nonMonotone", "nonMonotoneGlobal", "wallOutsideDoor", "sectionDetour", "unexplainedPorts", "offCenterAlone", "pillsInCorridor", "simplificationsLeft", "stubViolations", "arrowDirection", "tagsMissing", "sJogs"]

// Widen every gutter by `extra` px (experiment pages only: it moves sections and their cards).
// Each thing shifts by `extra` × the number of section edges that lie before it on that axis.
export function spread(L0: Layout, extra: number): Layout {
  const L = clone(L0)
  const rights = [...new Set(L.sections.map((s) => s.rect.x + s.rect.w).concat((L.blocks ?? []).map((b) => b.x + b.w)))]
  const bottoms = [...new Set(L.sections.map((s) => s.rect.y + s.rect.h).concat((L.blocks ?? []).map((b) => b.y + b.h)))]
  const dx = (x: number) => rights.filter((r) => r <= x).length * extra
  const dy = (y: number) => bottoms.filter((b) => b <= y).length * extra
  const shiftOf = new Map<string, [number, number]>()
  for (const s of L.sections) {
    const d: [number, number] = [dx(s.rect.x), dy(s.rect.y)]
    shiftOf.set(s.id, d)
    s.rect = { ...s.rect, x: s.rect.x + d[0], y: s.rect.y + d[1] }
  }
  for (const n of L.nodes) {
    const d = n.section ? shiftOf.get(n.section)! : [dx(n.rect.x), dy(n.rect.y)]
    n.rect = { ...n.rect, x: n.rect.x + d[0], y: n.rect.y + d[1] }
  }
  L.blocks = (L.blocks ?? []).map((b) => ({ ...b, x: b.x + dx(b.x), y: b.y + dy(b.y) }))
  return L
}

// Drawing pieces from final routes: each bundle's union drawn once as chains (dashes stay continuous,
// nothing drawn twice), plus one arrowhead piece per link at its target.
export function piecesFromRoutes(L: Layout): any[] {
  const kindOf = new Map(L.edges.map((e) => [e.id, e.kind]))
  const byB = new Map<string, Route[]>()
  for (const r of L.routes) byB.set(r.bundle ?? r.edge, [...(byB.get(r.bundle ?? r.edge) ?? []), r])
  const pieces: any[] = []
  const key = (p: Pt) => `${p[0]},${p[1]}`
  const parse = (k: string) => k.split(",").map(Number) as Pt
  for (const [b, rs] of byB) {
    const adj = new Map<string, Set<string>>()
    const ends = new Set<string>()
    const link = (u: Pt, v: Pt) => { for (const [a, c] of [[u, v], [v, u]]) { const set = adj.get(key(a)) ?? new Set(); set.add(key(c)); adj.set(key(a), set) } }
    for (const r of rs) {
      ends.add(key(r.pts[0])); ends.add(key(r.pts[r.pts.length - 1]))
      for (let i = 1; i < r.pts.length; i++) {
        const a = r.pts[i - 1], c = r.pts[i]
        // split into 20px steps (port borders may be off-lattice: keep their exact point)
        const steps: Pt[] = [a]
        const dx = Math.sign(c[0] - a[0]), dy = Math.sign(c[1] - a[1])
        let x = a[0], y = a[1]
        while (Math.abs(c[0] - x) > 20 || Math.abs(c[1] - y) > 20) { x += dx * 20; y += dy * 20; steps.push([x, y]) }
        steps.push(c)
        for (let j = 1; j < steps.length; j++) if (key(steps[j - 1]) !== key(steps[j])) link(steps[j - 1], steps[j])
      }
    }
    const kind = kindOf.get(rs[0].edge)
    const seen = new Set<string>()
    const stop = (k: string) => ends.has(k) || (adj.get(k)?.size ?? 0) !== 2
    for (const start of adj.keys()) {
      if (!stop(start)) continue
      for (const nb of adj.get(start)!) {
        const ek = [start, nb].sort().join("|")
        if (seen.has(ek)) continue
        seen.add(ek)
        const chain = [start]
        let prev = start, cur = nb
        while (true) {
          chain.push(cur)
          if (stop(cur)) break
          const nxt = [...adj.get(cur)!].find((x) => x !== prev)!
          const k2 = [cur, nxt].sort().join("|")
          if (seen.has(k2)) break
          seen.add(k2)
          prev = cur; cur = nxt
        }
        pieces.push({ id: `${b}.${pieces.length}`, kind, pts: simplify(chain.map(parse)), arrow: false, count: rs.length, role: "chain" })
      }
    }
    for (const r of rs) pieces.push({ id: `a.${r.edge}`, kind, pts: r.pts.slice(-2), arrow: true, arrowOnly: true, count: 1, role: "arrow" })
  }
  return pieces
}

export function monotonePts(pts: Pt[]): boolean {
  let sx = 0, sy = 0
  for (let i = 1; i < pts.length; i++) {
    const dx = Math.sign(pts[i][0] - pts[i - 1][0]), dy = Math.sign(pts[i][1] - pts[i - 1][1])
    if (dx) { if (sx && dx !== sx) return false; sx = dx }
    if (dy) { if (sy && dy !== sy) return false; sy = dy }
  }
  return true
}
