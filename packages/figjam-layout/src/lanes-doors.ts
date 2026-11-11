import type { GlobalPlan } from "./global"

// Doors for the "lanes" router: one window per (section, other section) on the section border,
// aligned when the sections face, with one slot per edge so lanes nest instead of crossing.
import { sectionOf } from "./engine"
import {
  OPP,
  P,
  isHoriz,
  nodeOf,
  pairKey,
  sectionRect,
  sideSpan,
  wallCoord,
  wallPoint,
  facing,
  type Board,
  type Grid,
  type Pairs,
  type Window,
} from "./lanes-grid"
import {
  center,
  must,
  type Edge,
  type Layout,
  type Pt,
  type Rect,
  type Side,
} from "./model"

const SIDES: Array<Side> = ["TOP", "BOTTOM", "LEFT", "RIGHT"]
const OUT: Record<Side, Pt> = {
  TOP: [0, -1],
  BOTTOM: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
}

export function splitPairs(L: Layout): Pairs {
  const inter: Array<Edge> = [],
    intra: Array<Edge> = []
  for (const e of L.edges) {
    const [a, b] = sectionOf(L, e)
    ;(a && b && a !== b ? inter : intra).push(e)
  }
  const pairs = new Map<string, Array<Edge>>()
  for (const e of inter) {
    const [a, b] = sectionOf(L, e) as [string, string]
    const k = pairKey(a, b)
    pairs.set(k, [...(pairs.get(k) ?? []), e])
  }
  const pairIdx = new Map([...pairs.keys()].map((k, i) => [k, i]))
  return { inter, intra, pairs, pairIdx, pairKeys: [...pairs.keys()] }
}

// Every lattice node on a section border.
export function markBorders(L: Layout, g: Grid): void {
  const { at, border } = g
  for (const s of L.sections) {
    const R = s.rect
    for (let x = R.x; x <= R.x + R.w; x += P) {
      border[at(x, R.y)] = 1
      border[at(x, R.y + R.h)] = 1
    }
    for (let y = R.y; y <= R.y + R.h; y += P) {
      border[at(R.x, y)] = 1
      border[at(R.x + R.w, y)] = 1
    }
  }
}

// ---- which sides a family pair talks through ----
type Solid = { id: string; r: Rect }
type SideQuery = {
  A: Rect
  B: Rect
  ca: Array<Pt>
  cb: Array<Pt>
  skip: Array<string>
  solids: Array<Solid>
}

function solidsOf(L: Layout): Array<Solid> {
  return [
    ...L.sections.map((s) => ({ id: s.id, r: s.rect })),
    ...(L.blocks ?? []).map((r, i) => ({ id: `block${i}`, r })),
  ]
}

function segCuts(solids: Array<Solid>, seg: [Pt, Pt], skip: Array<string>) {
  const [p, q] = seg
  return solids.some(
    (s) =>
      !skip.includes(s.id)
      && Math.max(p[0], q[0]) > s.r.x
      && Math.min(p[0], q[0]) < s.r.x + s.r.w
      && Math.max(p[1], q[1]) > s.r.y
      && Math.min(p[1], q[1]) < s.r.y + s.r.h,
  )
}

function med(ps: Array<Pt>, i: number) {
  const v = ps.map((p) => p[i]).sort((x, y) => x - y)
  return v[Math.floor(v.length / 2)]
}

// door estimate: median of the cards that use it, projected onto the side, 120px outside
function doorEstimate(R: Rect, s: Side, ps: Array<Pt>): Pt {
  const cx = Math.min(Math.max(med(ps, 0), R.x + 160), R.x + R.w - 160),
    cy = Math.min(Math.max(med(ps, 1), R.y + 160), R.y + R.h - 160)
  if (s === "LEFT") return [R.x - 120, cy]
  if (s === "RIGHT") return [R.x + R.w + 120, cy]
  if (s === "TOP") return [cx, R.y - 120]
  return [cx, R.y + R.h + 120]
}

// mean Manhattan distance from the cards to the door
function meanDist(ps: Array<Pt>, p: Pt) {
  return (
    ps.reduce((s, q) => s + Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]), 0)
    / Math.max(1, ps.length)
  )
}

function sidePairCost(q: SideQuery, sa: Side, sb: Side): number {
  const { A, B, ca, cb, skip, solids } = q
  const pa = doorEstimate(A, sa, ca),
    pb = doorEstimate(B, sb, cb)
  const dir =
    OUT[sa][0] * (center(B)[0] - center(A)[0])
    + OUT[sa][1] * (center(B)[1] - center(A)[1])
  const dirB =
    OUT[sb][0] * (center(A)[0] - center(B)[0])
    + OUT[sb][1] * (center(A)[1] - center(B)[1])
  let c =
    Math.abs(pa[0] - pb[0])
    + Math.abs(pa[1] - pb[1])
    + meanDist(ca, pa)
    + meanDist(cb, pb)
    + (dir < 0 ? 3000 : 0)
    + (dirB < 0 ? 3000 : 0)
  const l1 =
    segCuts(solids, [pa, [pb[0], pa[1]]], skip)
    || segCuts(solids, [[pb[0], pa[1]], pb], skip)
  const l2 =
    segCuts(solids, [pa, [pa[0], pb[1]]], skip)
    || segCuts(solids, [[pa[0], pb[1]], pb], skip)
  if (l1 && l2) c += 6000
  return c
}

// The pair of sides whose doors join by the shortest path that doesn't cut through a third
// section (so families two apart use a side gutter).
function chooseSides(
  b: Board,
  ab: [string, string],
  es: Array<Edge>,
): [Side, Side] {
  const [a, bb] = ab
  const A = sectionRect(b, a),
    B = sectionRect(b, bb)
  let best: [Side, Side] = [facing(A, B), facing(B, A)],
    bc = Infinity
  const cardsIn = (s: string) =>
    es
      .flatMap((e) => [e.from, e.to])
      .filter((id) => nodeOf(b, id).section === s)
      .map((id) => center(nodeOf(b, id).rect))
  const q: SideQuery = {
    A,
    B,
    ca: cardsIn(a),
    cb: cardsIn(bb),
    skip: [a, bb],
    solids: solidsOf(b.L),
  }
  for (const sa of SIDES)
    for (const sb of SIDES) {
      const c = sidePairCost(q, sa, sb)
      if (c < bc) {
        bc = c
        best = [sa, sb]
      }
    }
  return best
}

// ---- window placement ----
function planWindows(b: Board, pr: Pairs, plan: GlobalPlan): Array<Window> {
  const windows: Array<Window> = []
  for (const w of plan.windows) {
    const pi = pr.pairIdx.get(w.pair)
    if (pi === undefined) continue
    const R = sectionRect(b, w.s)
    const [slo, shi] = sideSpan(R, w.side)
    const members = (pr.pairs.get(w.pair) ?? []).filter((e) =>
      w.bundles.includes(`${w.pair}|${e.kind}`),
    ).length
    const width = (members + 2) * P
    const lo = Math.min(
      Math.max(Math.round(((w.lo + w.hi) / 2 - width / 2) / P) * P, slo + 80),
      shi - 80 - width,
    )
    windows.push({
      s: w.s,
      side: w.side,
      lo,
      hi: lo + width,
      pair: pi,
      bundles: w.bundles,
    })
  }
  // facing windows of one pair that overlap: same span, so lanes keep their coordinate across
  for (const a of windows)
    for (const c of windows) {
      if (
        a === c
        || a.pair !== c.pair
        || OPP[a.side] !== c.side
        || a.aligned
        || c.aligned
      )
        continue
      if (Math.min(a.hi, c.hi) - Math.max(a.lo, c.lo) > -200) {
        const lo = Math.round((a.lo + c.lo) / 2 / P) * P,
          width = Math.max(a.hi - a.lo, c.hi - c.lo)
        a.lo = lo
        c.lo = lo
        a.hi = lo + width
        c.hi = lo + width
        a.aligned = true
        c.aligned = true
      }
    }
  return windows
}

// The coordinate of a card's centre along a side's axis.
function projector(b: Board, side: Side) {
  const horiz = isHoriz(side)
  return (id: string) => {
    const c = center(nodeOf(b, id).rect)
    return horiz ? c[0] : c[1]
  }
}

function median(ps: Array<number>): number | undefined {
  const v = [...ps].sort((p, q) => p - q)
  return v.length > 0 ? v[Math.floor(v.length / 2)] : undefined
}

// A window of `width` centred on the median of `ps`, kept inside [l, h].
function windowAt(
  ps: Array<number>,
  bounds: [number, number],
  width: number,
): [number, number] {
  const [l, h] = bounds
  let c = median(ps) ?? (l + h) / 2
  c = Math.min(Math.max(c, l + width / 2), h - width / 2)
  const w0 = Math.round((c - width / 2) / P) * P
  return [w0, w0 + width]
}

// Windows for one family pair when there is no global plan: one shared span when the sides face
// and overlap enough, else one window per side near the cards that use it.
function pairWindows(b: Board, pr: Pairs, k: string): [Window, Window] {
  const es = must(pr.pairs.get(k), `pair ${k}`)
  const [a, bb] = k.split("|")
  const A = sectionRect(b, a),
    B = sectionRect(b, bb)
  const [sa, sb] = chooseSides(b, [a, bb], es)
  const width = (es.length + 2) * P
  const horiz = isHoriz(sa)
  const proj = projector(b, sa)
  const pair = must(pr.pairIdx.get(k), `pair ${k}`)
  const [ol, oh] =
    horiz ?
      [Math.max(A.x, B.x), Math.min(A.x + A.w, B.x + B.w)]
    : [Math.max(A.y, B.y), Math.min(A.y + A.h, B.y + B.h)]
  const [slo, shi] = sideSpan(A, sa)
  if (sa === OPP[sb] && oh - ol >= width + 160) {
    const ids = es.flatMap((e) => [e.from, e.to])
    const [lo, hi] = windowAt(
      ids.map((id) => proj(id)),
      [Math.max(slo + 80, ol), Math.min(shi - 80, oh)],
      width,
    )
    return [
      { s: a, side: sa, lo, hi, pair, aligned: true },
      { s: bb, side: sb, lo, hi, pair, aligned: true },
    ]
  }
  const ends = es.flatMap((e) => [e.from, e.to])
  const ia = ends.filter((id) => nodeOf(b, id).section === a)
  const ib = ends.filter((id) => nodeOf(b, id).section === bb)
  const projB = projector(b, sb)
  const [la, ha] = windowAt(
    ia.map((id) => proj(id)),
    [Math.max(slo + 80, -Infinity), Math.min(shi - 80, Infinity)],
    width,
  )
  const [blo, bhi] = sideSpan(B, sb)
  let cb = median(ib.map((id) => projB(id))) ?? (blo + bhi) / 2
  cb = Math.min(Math.max(cb, blo + 80 + width / 2), bhi - 80 - width / 2)
  const lb = Math.round((cb - width / 2) / P) * P
  return [
    { s: a, side: sa, lo: la, hi: ha, pair },
    { s: bb, side: sb, lo: lb, hi: lb + width, pair },
  ]
}

// windows on one side must not overlap: push apart (keeping a 40px wall between)
function pushApart(windows: Array<Window>, ws: Array<Window>): void {
  ws.sort((a, b) => a.lo - b.lo)
  for (let i = 1; i < ws.length; i++) {
    const w = ws[i]
    if (w.lo >= ws[i - 1].hi + 40) continue
    const d = ws[i - 1].hi + 40 - w.lo
    w.lo += d
    w.hi += d
    if (w.aligned) {
      // keep facing doors aligned
      const o = must(
        windows.find((x) => x.pair === w.pair && x !== w),
        "facing window",
      )
      o.lo += d
      o.hi += d
    }
  }
}

export function placeWindows(b: Board, pr: Pairs): Array<Window> {
  const windows: Array<Window> = []
  if (b.opts.plan) windows.push(...planWindows(b, pr, b.opts.plan))
  else for (const k of pr.pairs.keys()) windows.push(...pairWindows(b, pr, k))
  if (process.env.LANES_DEBUG)
    for (const w of windows)
      console.error(
        "win",
        must(b.sec.get(w.s), "section").name,
        w.side,
        w.lo,
        w.hi,
        pr.pairKeys[w.pair]
          .split("|")
          .map((s) => must(b.sec.get(s), "section").name)
          .join(" / "),
      )
  const bySide = new Map<string, Array<Window>>()
  for (const w of windows)
    bySide.set(`${w.s}|${w.side}`, [
      ...(bySide.get(`${w.s}|${w.side}`) ?? []),
      w,
    ])
  for (let rep = 0; rep < 3; rep++)
    for (const ws of bySide.values()) pushApart(windows, ws)
  return windows
}

// ---- bundles ----
// groups: edges between the same two families with the same kind form one bundle — they may
// share lanes (merge after leaving their cards, split before reaching them); everything else
// only meets at right-angle crossings. Intra-family edges are their own group.
export function groupKeyOf(L: Layout, e: Edge): string {
  const [a, b] = sectionOf(L, e)
  return a && b && a !== b ? `${pairKey(a, b)}|${e.kind}` : `e|${e.id}`
}

export type Groups = {
  groupIds: Map<string, number>
  gOf: Map<string, number>
  gKeyOf: Map<number, string>
  edgeIdx: Map<string, number>
}

export function groupEdges(L: Layout): Groups {
  const groupIds = new Map<string, number>()
  for (const e of L.edges)
    if (!groupIds.has(groupKeyOf(L, e)))
      groupIds.set(groupKeyOf(L, e), groupIds.size)
  const gOf = new Map(
    L.edges.map((e) => [e.id, must(groupIds.get(groupKeyOf(L, e)), "group")]),
  )
  const gKeyOf = new Map([...groupIds.entries()].map(([k, v]) => [v, k]))
  const edgeIdx = new Map(L.edges.map((e, i) => [e.id, i]))
  return { groupIds, gOf, gKeyOf, edgeIdx }
}

// ---- door slots ----
// The edges of one window, one slot each, in order: bundles ordered by where their cards sit inside
// the section (left-edge style); a bundle's members take adjacent slots (nearest first) and merge
// only outside, in the gutter — never on the card side or inside the section.
function windowSlots(
  b: Board,
  dg: { pr: Pairs; gr: Groups },
  w: Window,
): Array<number> {
  const { pr, gr } = dg
  const { gOf, gKeyOf, edgeIdx } = gr
  const coord = projector(b, w.side)
  const es = must(pr.pairs.get(pr.pairKeys[w.pair]), "window pair")
  const inside = (e: Edge) =>
    nodeOf(b, e.from).section === w.s ? e.from : e.to
  const outside = (e: Edge) =>
    nodeOf(b, e.from).section === w.s ? e.to : e.from
  const gs = [...new Set(es.map((e) => must(gOf.get(e.id), "group")))].filter(
    (g) => !w.bundles || w.bundles.includes(must(gKeyOf.get(g), "group key")),
  )
  const key = (g: number) => {
    const mem = es.filter((e) => gOf.get(e.id) === g)
    const v = mem.map((e) => coord(inside(e))).sort((a, c) => a - c)
    const o = mem.map((e) => coord(outside(e))).sort((a, c) => a - c)
    return [v[Math.floor(v.length / 2)], o[Math.floor(o.length / 2)]]
  }
  if (w.aligned) {
    // facing windows share one order (both ends), so bundles of a pair never cross in the gutter
    const both = (g: number) => {
      const mem = es.filter((e) => gOf.get(e.id) === g)
      const v = mem
        .flatMap((e) => [coord(e.from), coord(e.to)])
        .sort((a, c) => a - c)
      return v[Math.floor(v.length / 2)]
    }
    gs.sort((a, c) => both(a) - both(c) || a - c)
  } else gs.sort((a, c) => key(a)[0] - key(c)[0] || key(a)[1] - key(c)[1])
  const slots: Array<number> = []
  for (const g of gs) {
    const mem = es
      .filter((e) => gOf.get(e.id) === g)
      .sort((a, c) => coord(inside(a)) - coord(inside(c)))
    for (const e of mem) slots.push(must(edgeIdx.get(e.id), "edge index"))
  }
  return slots
}

// Each bundle gets one slot in each window, so lanes nest instead of crossing at the door; walls
// outside the windows are blocked.
export function markDoors(
  b: Board,
  g: Grid,
  dg: { pr: Pairs; gr: Groups; windows: Array<Window> },
): void {
  const { at, doorOwner, doorSlot, perpOnly } = g
  for (const w of dg.windows) {
    const R = sectionRect(b, w.s)
    const horiz = isHoriz(w.side)
    const slots = windowSlots(b, dg, w)
    let i = 0
    for (let c = w.lo + P; c < w.hi; c += P) {
      const k = at(...wallPoint(R, w.side, c))
      doorOwner[k] = w.pair
      if (i < slots.length) doorSlot[k] = slots[i++]
    }
    // approach band: 40px on both sides of the window, perpendicular moves only, so every slot has
    // a straight approach and lateral runs (and crossings) happen ≥ 60px from the wall
    const wall = wallCoord(R, w.side)
    for (let c = w.lo; c <= w.hi; c += P)
      for (const dpt of [-2, -1, 1, 2]) {
        const k = horiz ? at(c, wall + dpt * P) : at(wall + dpt * P, c)
        perpOnly[k] = horiz ? 1 : 2
      }
  }
  for (let k = 0; k < g.N; k++)
    if (g.border[k] && doorOwner[k] < 0) g.blocked[k] = 1
}
