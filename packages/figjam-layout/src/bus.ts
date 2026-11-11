// Strategy C ("bus"): section-level bundling. All edges between two families leave through one door
// on the side facing the other family, run as one trunk lane per edge kind through the gutters, and
// split near their targets. Intra-section edges stay native unless libavoid's route is cleaner.
import { avoid, facingSide, pickMagnets, sectionOf } from "./engine.ts"
import { bestMagnets, center, score, simplify, type Edge, type Layout, type Pt, type Rect, type Route, type Side } from "./model.ts"

export type Piece = { id: string; kind: string; pts: Pt[]; arrow: boolean; count: number; role: "trunk" | "feeder" | "intra" }

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const diag = (p: Pt[]) => p.some((a, i) => i > 0 && a[0] !== p[i - 1][0] && a[1] !== p[i - 1][1])

export async function bus(L0: Layout, opts: { pitch?: number; intra?: "auto" | "cards" | "native" | "routed"; walls?: boolean; name?: string; wallIn?: number; drawAll?: boolean } = {}): Promise<Layout> {
  const Avoid = await avoid()
  const pitch = opts.pitch ?? 20
  const L = clone(L0)
  L.name = opts.name ?? `bus${opts.intra && opts.intra !== "auto" ? "-" + opts.intra : ""}`
  const m = new Map(L.nodes.map((n) => [n.id, n]))
  const sec = new Map(L.sections.map((s) => [s.id, s]))
  const inter: Edge[] = []
  const intra: Edge[] = []
  for (const e of L.edges) { const [a, b] = sectionOf(L, e); (a && b && a !== b ? inter : intra).push(e) }

  // 1. doors: one per (section, other section), on the side facing it, placed where the two overlap.
  type Door = { key: string; s: string; t: string; side: Side; at: number; pt: Pt; lanes: number }
  const doors = new Map<string, Door>()
  const kindsPerPair = new Map<string, Set<string>>()
  for (const e of inter) {
    const [a, b] = sectionOf(L, e) as [string, string]
    const k = [a, b].sort().join("|")
    kindsPerPair.set(k, (kindsPerPair.get(k) ?? new Set()).add(e.kind))
  }
  const doorOf = (s: string, t: string): Door => {
    const key = `${s}>${t}`
    if (doors.has(key)) return doors.get(key)!
    const S = sec.get(s)!.rect, T = sec.get(t)!.rect
    const side = facingSide(S, T)
    const horiz = side === "TOP" || side === "BOTTOM"
    const [lo, hi] = horiz ? [S.x, S.x + S.w] : [S.y, S.y + S.h]
    const [tlo, thi] = horiz ? [T.x, T.x + T.w] : [T.y, T.y + T.h]
    const olo = Math.max(lo, tlo), ohi = Math.min(hi, thi)
    // overlap → middle of the overlap; else the end nearest the other section
    // door where its feeders are: median projection of the cards that use it (both ends when the
    // two sections face each other, so the trunk crosses the gutter straight)
    const facing = olo < ohi
    const users = inter.filter((e) => { const [x, y] = sectionOf(L, e); return (x === s && y === t) || (x === t && y === s) })
    const proj = users.flatMap((e) => [e.from, e.to]).filter((id) => facing || m.get(id)!.section === s).map((id) => { const c = center(m.get(id)!.rect); return horiz ? c[0] : c[1] }).sort((a, b) => a - b)
    let at = proj.length ? proj[Math.floor(proj.length / 2)] : (olo + ohi) / 2
    if (facing) at = Math.min(Math.max(at, olo + 120), ohi - 120)
    else at = tlo >= hi ? Math.max(at, hi - 480) : Math.min(at, lo + 480) // bias toward the other family
    at = Math.min(Math.max(at, lo + 160), hi - 120)
    const lanes = kindsPerPair.get([s, t].sort().join("|"))?.size ?? 1
    const d: Door = { key, s, t, side, at, pt: [0, 0], lanes }
    doors.set(key, d)
    return d
  }
  for (const e of inter) { const [a, b] = sectionOf(L, e) as [string, string]; doorOf(a, b); doorOf(b, a) }
  // spread doors on one side
  const bySide = new Map<string, Door[]>()
  for (const d of doors.values()) bySide.set(`${d.s}|${d.side}`, [...(bySide.get(`${d.s}|${d.side}`) ?? []), d])
  for (const list of bySide.values()) {
    list.sort((a, b) => a.at - b.at)
    for (let i = 1; i < list.length; i++) {
      const need = (list[i - 1].lanes + list[i].lanes) * pitch + 80
      if (list[i].at - list[i - 1].at < need) list[i].at = list[i - 1].at + need
    }
  }
  for (const d of doors.values()) {
    const S = sec.get(d.s)!.rect
    d.pt = d.side === "TOP" ? [d.at, S.y] : d.side === "BOTTOM" ? [d.at, S.y + S.h] : d.side === "LEFT" ? [S.x, d.at] : [S.x + S.w, d.at]
  }

  // 2. router: cards + section walls with door gaps
  const router = new Avoid.Router(Avoid.RouterFlag.OrthogonalRouting.value)
  router.setRoutingParameter(Avoid.RoutingParameter.shapeBufferDistance, 20)
  router.setRoutingParameter(Avoid.RoutingParameter.idealNudgingDistance, pitch)
  router.setRoutingParameter(Avoid.RoutingParameter.segmentPenalty, 60)
  router.setRoutingParameter(Avoid.RoutingParameter.crossingPenalty, 2000)
  router.setRoutingOption(Avoid.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes, true)
  router.setRoutingOption(Avoid.RoutingOption.performUnifyingNudgingPreprocessingStep, true)
  const rect = (x0: number, y0: number, x1: number, y1: number) => new Avoid.Rectangle(new Avoid.Point(x0, y0), new Avoid.Point(x1, y1))
  const shapes = new Map<string, any>()
  for (const n of L.nodes) if (n.obstacle) shapes.set(n.id, new Avoid.ShapeRef(router, rect(n.rect.x, n.rect.y, n.rect.x + n.rect.w, n.rect.y + n.rect.h)))
  const W = opts.wallIn ?? 60
  for (const s of opts.walls === false ? [] : L.sections) {
    const R = s.rect
    for (const side of ["TOP", "BOTTOM", "LEFT", "RIGHT"] as Side[]) {
      const horiz = side === "TOP" || side === "BOTTOM"
      const [lo, hi] = horiz ? [R.x, R.x + R.w] : [R.y, R.y + R.h]
      const cuts = [...doors.values()].filter((d) => d.s === s.id && d.side === side).map((d) => { const g = 40 + d.lanes * pitch; return [d.at - g, d.at + g] }).sort((a, b) => a[0] - b[0])
      let cur = lo
      const spans: [number, number][] = []
      for (const [c0, c1] of cuts) { if (c0 > cur) spans.push([cur, c0]); cur = Math.max(cur, c1) }
      if (cur < hi) spans.push([cur, hi])
      for (const [a, b] of spans) {
        if (b - a < 2) continue
        if (side === "TOP") new Avoid.ShapeRef(router, rect(a, R.y - 4, b, R.y + W))
        if (side === "BOTTOM") new Avoid.ShapeRef(router, rect(a, R.y + R.h - W, b, R.y + R.h + 4))
        if (side === "LEFT") new Avoid.ShapeRef(router, rect(R.x - 4, a, R.x + W, b))
        if (side === "RIGHT") new Avoid.ShapeRef(router, rect(R.x + R.w - W, a, R.x + R.w + 4, b))
      }
    }
  }
  let cls = 1
  const pinCls = new Map<string, number>()
  const pins = (id: string) => {
    if (!pinCls.has(id)) {
      const c = cls++
      for (const [x, y, d] of [[0.5, 0, 1], [0.5, 1, 2], [0, 0.5, 4], [1, 0.5, 8]]) new Avoid.ShapeConnectionPin(shapes.get(id), c, x, y, true, 0, d).setExclusive(false)
      pinCls.set(id, c)
    }
    return new Avoid.ConnEnd(shapes.get(id), pinCls.get(id)!)
  }
  const pointEnd = (p: Pt) => new Avoid.ConnEnd(new Avoid.Point(p[0], p[1]))
  const conns = new Map<string, any>()
  const conn = (key: string, a: any, b: any) => {
    if (!conns.has(key)) { const r = new Avoid.ConnRef(router, a, b); r.setRoutingType(Avoid.ConnType.ConnType_Orthogonal); conns.set(key, r) }
    return key
  }
  // 3. trunks per (pair, kind); feeders per (card, door, kind, direction); intra per edge
  const parts = new Map<string, { trunk: string; tRev: boolean; fOut: string; fIn: string }>()
  const counts = new Map<string, number>()
  for (const e of inter) {
    const [a, b] = sectionOf(L, e) as [string, string]
    const dA = doors.get(`${a}>${b}`)!, dB = doors.get(`${b}>${a}`)!
    const [p, q] = [a, b].sort()
    const tk = conn(`trunk|${p}|${q}|${e.kind}`, pointEnd(doors.get(`${p}>${q}`)!.pt), pointEnd(doors.get(`${q}>${p}`)!.pt))
    const fo = conn(`out|${e.from}|${dA.key}|${e.kind}`, pins(e.from), pointEnd(dA.pt))
    const fi = conn(`in|${e.to}|${dB.key}|${e.kind}`, pins(e.to), pointEnd(dB.pt))
    for (const k of [tk, fo, fi]) counts.set(k, (counts.get(k) ?? 0) + 1)
    parts.set(e.id, { trunk: tk, tRev: p !== a, fOut: fo, fIn: fi })
  }
  for (const e of intra) conn(`intra|${e.id}`, pins(e.from), pins(e.to))
  router.processTransaction()
  const read = (k: string): Pt[] => {
    const pl = conns.get(k).displayRoute()
    const pts: Pt[] = []
    for (let i = 0; i < pl.size(); i++) pts.push([pl.at(i).x, pl.at(i).y])
    return simplify(pts)
  }
  const routes: Route[] = []
  for (const e of inter) {
    const P = parts.get(e.id)!
    const t = read(P.trunk)
    const pts = simplify([...read(P.fOut), ...(P.tRev ? [...t].reverse() : t), ...[...read(P.fIn)].reverse()])
    routes.push({ edge: e.id, pts, native: false, bundle: P.trunk } as Route)
  }
  // 4. intra: native (best magnets) unless it hits a card or crosses; then libavoid's route
  L.routes = routes
  const obstacles = L.nodes.filter((n) => n.obstacle)
  const intraDrawn: string[] = []
  for (const e of intra) {
    const a = m.get(e.from)!.rect, b = m.get(e.to)!.rect
    const obs = obstacles.filter((n) => n.id !== e.from && n.id !== e.to).map((n) => n.rect)
    const nat = bestMagnets(a, b, obs, L.routes.map((r) => r.pts))
    const routed = read(`intra|${e.id}`)
    const natCost = costOf(nat.pts, obs, L.routes)
    const useRouted = opts.intra === "routed" || (opts.intra !== "native" && !diag(routed) && (opts.intra === "cards" ? natCost >= 10 : natCost > 0) && costOf(routed, obs, L.routes) < natCost)
    if (useRouted) { L.routes.push({ edge: e.id, pts: routed, native: false }); intraDrawn.push(e.id) }
    else L.routes.push({ edge: e.id, pts: nat.pts, native: true, fromMagnet: nat.sa, toMagnet: nat.sb })
  }
  // 5. pieces to draw: each trunk/feeder once (shared), intra drawn edges; arrows on in-feeders
  const kindOf = new Map(L.edges.map((e) => [e.id, e.kind]))
  const pieces: Piece[] = []
  for (const [k, n] of counts) {
    const role = k.startsWith("trunk") ? "trunk" : "feeder"
    const pts = k.startsWith("in|") ? [...read(k)].reverse() : read(k)
    pieces.push({ id: k, kind: k.split("|").pop()!, pts, arrow: k.startsWith("in|"), count: n, role })
  }
  for (const id of intraDrawn) pieces.push({ id: `intra|${id}`, kind: kindOf.get(id)!, pts: L.routes.find((r) => r.edge === id)!.pts, arrow: true, count: 1, role: "intra" })
  // drawAll: native picks are drawn as vectors too (their elbow geometry), so every edge can live in one group
  if (opts.drawAll) for (const r of L.routes) if (r.native) { r.native = false; pieces.push({ id: `intra|${r.edge}`, kind: kindOf.get(r.edge)!, pts: r.pts, arrow: true, count: 1, role: "intra" }) }
  ;(L as any).pieces = pieces
  ;(L as any).doors = [...doors.values()].map((d) => ({ pt: d.pt }))
  L.notes = [`${inter.length} inter edges in ${[...counts.keys()].filter((k) => k.startsWith("trunk")).length} trunks via ${doors.size} doors; intra: ${intra.length - intraDrawn.length} native, ${intraDrawn.length} routed`]
  void center; void pickMagnets; void score
  return L
}

function segX(a: Pt, b: Pt, c: Pt, d: Pt) {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0
}
function hits(p: Pt, q: Pt, r: Rect) {
  const [x0, x1] = [Math.min(p[0], q[0]), Math.max(p[0], q[0])], [y0, y1] = [Math.min(p[1], q[1]), Math.max(p[1], q[1])]
  return x1 > r.x + 2 && x0 < r.x + r.w - 2 && y1 > r.y + 2 && y0 < r.y + r.h - 2
}
function costOf(pts: Pt[], obs: Rect[], others: Route[]) {
  let c = 0
  for (const o of obs) for (let i = 0; i + 1 < pts.length; i++) if (hits(pts[i], pts[i + 1], o)) { c += 10; break }
  for (const r of others) for (let i = 0; i + 1 < pts.length; i++) for (let j = 0; j + 1 < r.pts.length; j++) if (segX(pts[i], pts[i + 1], r.pts[j], r.pts[j + 1])) c += 1
  return c
}
