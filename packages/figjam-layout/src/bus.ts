// Strategy C ("bus"): section-level bundling. All edges between two families leave through one door
// on the side facing the other family, run as one trunk lane per edge kind through the gutters, and
// split near their targets. Intra-section edges stay native unless libavoid's route is cleaner.
import {
  addWall,
  avoid,
  cardShapes,
  doorPoint,
  facingSide,
  hasDiagonal,
  pinClasses,
  readRoute,
  sectionOf,
  type AvoidApi,
  type AvoidConnEnd,
  type AvoidConnRef,
  type Avoider,
  type AvoidShapeRef,
} from "./engine"
import {
  bestMagnets,
  center,
  jsonClone,
  last,
  must,
  SIDES,
  simplify,
  type Edge,
  type Layout,
  type Node,
  type Piece,
  type Pt,
  type Rect,
  type Route,
  type Section,
  type Side,
} from "./model"

export type BusOptions = {
  pitch?: number
  intra?: "auto" | "cards" | "native" | "routed"
  walls?: boolean
  name?: string
  wallIn?: number
  drawAll?: boolean
}

type BusDoor = {
  key: string
  s: string
  t: string
  side: Side
  at: number
  pt: Pt
  lanes: number
}

// The edges split by whether they cross sections, and the doors the crossing ones use.
type BusPlan = {
  L: Layout
  inter: Array<Edge>
  intra: Array<Edge>
  doors: Map<string, BusDoor>
}

// One edge's way through the bus: out-feeder, trunk (reversed when the edge runs q→p), in-feeder.
type Parts = { trunk: string; tRev: boolean; fOut: string; fIn: string }

// What placing a door needs to see: the cards, sections, inter edges, and kinds per section pair.
type DoorContext = {
  L: Layout
  m: Map<string, Node>
  sec: Map<string, Section>
  inter: Array<Edge>
  kindsPerPair: Map<string, Set<string>>
  doors: Map<string, BusDoor>
}

// An inter-section edge's (from, to) sections; both exist by construction.
function sectionPair(L: Layout, e: Edge): [string, string] {
  const [a, b] = sectionOf(L, e)
  return [must(a, `section of ${e.from}`), must(b, `section of ${e.to}`)]
}

function sectionRect(sec: Map<string, Section>, id: string): Rect {
  return must(sec.get(id), `section ${id}`).rect
}

// Where along its side a door sits.
// overlap → middle of the overlap; else the end nearest the other section
// door where its feeders are: median projection of the cards that use it (both ends when the
// two sections face each other, so the trunk crosses the gutter straight)
function doorAt(
  ctx: DoorContext,
  door: { s: string; t: string; side: Side },
): number {
  const { s, t, side } = door
  const S = sectionRect(ctx.sec, s),
    T = sectionRect(ctx.sec, t)
  const horiz = side === "TOP" || side === "BOTTOM"
  const [lo, hi] = horiz ? [S.x, S.x + S.w] : [S.y, S.y + S.h]
  const [tlo, thi] = horiz ? [T.x, T.x + T.w] : [T.y, T.y + T.h]
  const olo = Math.max(lo, tlo),
    ohi = Math.min(hi, thi)
  const facing = olo < ohi
  const users = ctx.inter.filter((e) => {
    const [x, y] = sectionOf(ctx.L, e)
    return (x === s && y === t) || (x === t && y === s)
  })
  const proj = users
    .flatMap((e) => [e.from, e.to])
    .filter((id) => facing || must(ctx.m.get(id), `card ${id}`).section === s)
    .map((id) => {
      const c = center(must(ctx.m.get(id), `card ${id}`).rect)
      return horiz ? c[0] : c[1]
    })
    .sort((a, b) => a - b)
  let at = proj.length > 0 ? proj[Math.floor(proj.length / 2)] : (olo + ohi) / 2
  if (facing) at = Math.min(Math.max(at, olo + 120), ohi - 120)
  else at = tlo >= hi ? Math.max(at, hi - 480) : Math.min(at, lo + 480) // bias toward the other family
  return Math.min(Math.max(at, lo + 160), hi - 120)
}

// 1. doors: one per (section, other section), on the side facing it, placed where the two overlap.
function doorOf(ctx: DoorContext, s: string, t: string): BusDoor {
  const key = `${s}>${t}`
  const known = ctx.doors.get(key)
  if (known) return known
  const side = facingSide(sectionRect(ctx.sec, s), sectionRect(ctx.sec, t))
  const at = doorAt(ctx, { s, t, side })
  const lanes = ctx.kindsPerPair.get([s, t].sort().join("|"))?.size ?? 1
  const d: BusDoor = { key, s, t, side, at, pt: [0, 0], lanes }
  ctx.doors.set(key, d)
  return d
}

// spread doors on one side
function spreadDoors(doors: Map<string, BusDoor>, pitch: number): void {
  const bySide = new Map<string, Array<BusDoor>>()
  for (const d of doors.values())
    bySide.set(`${d.s}|${d.side}`, [
      ...(bySide.get(`${d.s}|${d.side}`) ?? []),
      d,
    ])
  for (const list of bySide.values()) {
    list.sort((a, b) => a.at - b.at)
    for (let i = 1; i < list.length; i++) {
      const need = (list[i - 1].lanes + list[i].lanes) * pitch + 80
      if (list[i].at - list[i - 1].at < need) list[i].at = list[i - 1].at + need
    }
  }
}

function busDoors(
  L: Layout,
  inter: Array<Edge>,
  pitch: number,
): Map<string, BusDoor> {
  const sec = new Map(L.sections.map((s) => [s.id, s]))
  const kindsPerPair = new Map<string, Set<string>>()
  for (const e of inter) {
    const [a, b] = sectionPair(L, e)
    const k = [a, b].sort().join("|")
    kindsPerPair.set(k, (kindsPerPair.get(k) ?? new Set()).add(e.kind))
  }
  const ctx: DoorContext = {
    L,
    m: new Map(L.nodes.map((n) => [n.id, n])),
    sec,
    inter,
    kindsPerPair,
    doors: new Map(),
  }
  for (const e of inter) {
    const [a, b] = sectionPair(L, e)
    doorOf(ctx, a, b)
    doorOf(ctx, b, a)
  }
  spreadDoors(ctx.doors, pitch)
  for (const d of ctx.doors.values())
    d.pt = doorPoint(sectionRect(sec, d.s), d.side, d.at)
  return ctx.doors
}

// 2. router: cards + section walls with door gaps
function busRouter(Avoid: AvoidApi, pitch: number): Avoider {
  const router = new Avoid.Router(Avoid.RouterFlag.OrthogonalRouting.value)
  router.setRoutingParameter(Avoid.RoutingParameter.shapeBufferDistance, 20)
  router.setRoutingParameter(Avoid.RoutingParameter.idealNudgingDistance, pitch)
  router.setRoutingParameter(Avoid.RoutingParameter.segmentPenalty, 60)
  router.setRoutingParameter(Avoid.RoutingParameter.crossingPenalty, 2000)
  router.setRoutingOption(
    Avoid.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes,
    true,
  )
  router.setRoutingOption(
    Avoid.RoutingOption.performUnifyingNudgingPreprocessingStep,
    true,
  )
  return { Avoid, router }
}

function busWalls(
  av: Avoider,
  doors: Map<string, BusDoor>,
  wall: { sections: Array<Section>; pitch: number; inset: number },
): void {
  for (const s of wall.sections)
    for (const side of SIDES)
      addWall(av, {
        R: s.rect,
        side,
        cuts: [...doors.values()]
          .filter((d) => d.s === s.id && d.side === side)
          .map((d): [number, number] => {
            const g = 40 + d.lanes * wall.pitch
            return [d.at - g, d.at + g]
          }),
        inset: wall.inset,
        outset: 4,
      })
}

// libavoid connectors by key, each created once and shared by every edge that uses it.
class Connectors {
  private readonly av: Avoider
  private readonly shapes: Map<string, AvoidShapeRef>
  private readonly pinsFor: (id: string, shape: AvoidShapeRef) => number
  private readonly conns = new Map<string, AvoidConnRef>()

  constructor(av: Avoider, shapes: Map<string, AvoidShapeRef>) {
    this.av = av
    this.shapes = shapes
    this.pinsFor = pinClasses(av.Avoid)
  }

  // A card end: its pin set (made on first use), any side.
  pins(id: string): AvoidConnEnd {
    const shape = must(this.shapes.get(id), `shape ${id}`)
    return new this.av.Avoid.ConnEnd(shape, this.pinsFor(id, shape))
  }

  point(p: Pt): AvoidConnEnd {
    return new this.av.Avoid.ConnEnd(new this.av.Avoid.Point(p[0], p[1]))
  }

  conn(key: string, a: AvoidConnEnd, b: AvoidConnEnd): string {
    if (!this.conns.has(key)) {
      const r = new this.av.Avoid.ConnRef(this.av.router, a, b)
      r.setRoutingType(this.av.Avoid.ConnType.ConnType_Orthogonal)
      this.conns.set(key, r)
    }
    return key
  }

  read(key: string): Array<Pt> {
    return readRoute(must(this.conns.get(key), `connector ${key}`))
  }
}

// 3. trunks per (pair, kind); feeders per (card, door, kind, direction)
function busTrunks(
  book: Connectors,
  plan: BusPlan,
): { parts: Map<string, Parts>; counts: Map<string, number> } {
  const door = (key: string) => must(plan.doors.get(key), `door ${key}`)
  const parts = new Map<string, Parts>()
  const counts = new Map<string, number>()
  for (const e of plan.inter) {
    const [a, b] = sectionPair(plan.L, e)
    const dA = door(`${a}>${b}`),
      dB = door(`${b}>${a}`)
    const [p, q] = [a, b].sort()
    const tk = book.conn(
      `trunk|${p}|${q}|${e.kind}`,
      book.point(door(`${p}>${q}`).pt),
      book.point(door(`${q}>${p}`).pt),
    )
    const fo = book.conn(
      `out|${e.from}|${dA.key}|${e.kind}`,
      book.pins(e.from),
      book.point(dA.pt),
    )
    const fi = book.conn(
      `in|${e.to}|${dB.key}|${e.kind}`,
      book.pins(e.to),
      book.point(dB.pt),
    )
    for (const k of [tk, fo, fi]) counts.set(k, (counts.get(k) ?? 0) + 1)
    parts.set(e.id, { trunk: tk, tRev: p !== a, fOut: fo, fIn: fi })
  }
  return { parts, counts }
}

function interRoutes(
  book: Connectors,
  inter: Array<Edge>,
  parts: Map<string, Parts>,
): Array<Route> {
  const routes: Array<Route> = []
  for (const e of inter) {
    const P = must(parts.get(e.id), `parts of ${e.id}`)
    const t = book.read(P.trunk)
    const pts = simplify([
      ...book.read(P.fOut),
      ...(P.tRev ? [...t].reverse() : t),
      ...[...book.read(P.fIn)].reverse(),
    ])
    routes.push({ edge: e.id, pts, native: false, bundle: P.trunk })
  }
  return routes
}

// Whether an intra edge takes libavoid's route over its best native connector.
function takesRouted(
  mode: BusOptions["intra"],
  routed: Array<Pt>,
  cost: { native: number; routed: () => number },
): boolean {
  return (
    mode === "routed"
    || (mode !== "native"
      && !hasDiagonal(routed)
      && (mode === "cards" ? cost.native >= 10 : cost.native > 0)
      && cost.routed() < cost.native)
  )
}

// 4. intra: native (best magnets) unless it hits a card or crosses; then libavoid's route.
// Appends to L.routes and returns the ids drawn as routed vectors.
function placeIntra(
  book: Connectors,
  plan: BusPlan,
  mode: BusOptions["intra"],
): Array<string> {
  const { L } = plan
  const m = new Map(L.nodes.map((n) => [n.id, n]))
  const obstacles = L.nodes.filter((n) => n.obstacle)
  const intraDrawn: Array<string> = []
  for (const e of plan.intra) {
    const a = must(m.get(e.from), `card ${e.from}`).rect,
      b = must(m.get(e.to), `card ${e.to}`).rect
    const obs = obstacles
      .filter((n) => n.id !== e.from && n.id !== e.to)
      .map((n) => n.rect)
    const nat = bestMagnets(
      a,
      b,
      obs,
      L.routes.map((r) => r.pts),
    )
    const routed = book.read(`intra|${e.id}`)
    const natCost = costOf(nat.pts, obs, L.routes)
    const useRouted = takesRouted(mode, routed, {
      native: natCost,
      routed: () => costOf(routed, obs, L.routes),
    })
    if (useRouted) {
      L.routes.push({ edge: e.id, pts: routed, native: false })
      intraDrawn.push(e.id)
    } else
      L.routes.push({
        edge: e.id,
        pts: nat.pts,
        native: true,
        fromMagnet: nat.sa,
        toMagnet: nat.sb,
      })
  }
  return intraDrawn
}

function intraPiece(
  id: string,
  kind: string | undefined,
  pts: Array<Pt>,
): Piece {
  return { id: `intra|${id}`, kind, pts, arrow: true, count: 1, role: "intra" }
}

// 5. pieces to draw: each trunk/feeder once (shared), intra drawn edges; arrows on in-feeders
function busPieces(
  book: Connectors,
  counts: Map<string, number>,
  drawn: { L: Layout; intraDrawn: Array<string>; drawAll: boolean | undefined },
): Array<Piece> {
  const { L } = drawn
  const kindOf = new Map(L.edges.map((e) => [e.id, e.kind]))
  const pieces: Array<Piece> = []
  for (const [k, n] of counts) {
    const role = k.startsWith("trunk") ? "trunk" : "feeder"
    const pts = k.startsWith("in|") ? [...book.read(k)].reverse() : book.read(k)
    pieces.push({
      id: k,
      kind: last(k.split("|")),
      pts,
      arrow: k.startsWith("in|"),
      count: n,
      role,
    })
  }
  for (const id of drawn.intraDrawn)
    pieces.push(
      intraPiece(
        id,
        kindOf.get(id),
        must(
          L.routes.find((r) => r.edge === id),
          `route ${id}`,
        ).pts,
      ),
    )
  // drawAll: native picks are drawn as vectors too (their elbow geometry), so every edge can live in one group
  if (drawn.drawAll)
    for (const r of L.routes)
      if (r.native) {
        r.native = false
        pieces.push(intraPiece(r.edge, kindOf.get(r.edge), r.pts))
      }
  return pieces
}

export async function bus(L0: Layout, opts: BusOptions = {}): Promise<Layout> {
  const Avoid = await avoid()
  const pitch = opts.pitch ?? 20
  const L = jsonClone(L0)
  L.name =
    opts.name
    ?? `bus${opts.intra && opts.intra !== "auto" ? "-" + opts.intra : ""}`
  const inter: Array<Edge> = []
  const intra: Array<Edge> = []
  for (const e of L.edges) {
    const [a, b] = sectionOf(L, e)
    ;(a && b && a !== b ? inter : intra).push(e)
  }
  const doors = busDoors(L, inter, pitch)
  const plan: BusPlan = { L, inter, intra, doors }

  const av = busRouter(Avoid, pitch)
  const shapes = cardShapes(av, L.nodes)
  busWalls(av, doors, {
    sections: opts.walls === false ? [] : L.sections,
    pitch,
    inset: opts.wallIn ?? 60,
  })
  const book = new Connectors(av, shapes)
  const { parts, counts } = busTrunks(book, plan)
  // intra per edge
  for (const e of intra)
    book.conn(`intra|${e.id}`, book.pins(e.from), book.pins(e.to))
  av.router.processTransaction()
  L.routes = interRoutes(book, inter, parts)
  const intraDrawn = placeIntra(book, plan, opts.intra)
  L.pieces = busPieces(book, counts, { L, intraDrawn, drawAll: opts.drawAll })
  L.doors = [...doors.values()].map((d) => ({ pt: d.pt }))
  L.notes = [
    `${inter.length} inter edges in ${[...counts.keys()].filter((k) => k.startsWith("trunk")).length} trunks via ${doors.size} doors; intra: ${intra.length - intraDrawn.length} native, ${intraDrawn.length} routed`,
  ]
  return L
}

// Whether two segments cross properly (touching or collinear doesn't count).
function segX(s: readonly [Pt, Pt], t: readonly [Pt, Pt]) {
  const [a, b] = s
  const [c, d] = t
  const o = (p: Pt, q: Pt, r: Pt) =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0
}
function hits(p: Pt, q: Pt, r: Rect) {
  const [x0, x1] = [Math.min(p[0], q[0]), Math.max(p[0], q[0])],
    [y0, y1] = [Math.min(p[1], q[1]), Math.max(p[1], q[1])]
  return (
    x1 > r.x + 2 && x0 < r.x + r.w - 2 && y1 > r.y + 2 && y0 < r.y + r.h - 2
  )
}
function costOf(pts: Array<Pt>, obs: Array<Rect>, others: Array<Route>) {
  let c = 0
  for (const o of obs)
    for (let i = 0; i + 1 < pts.length; i++)
      if (hits(pts[i], pts[i + 1], o)) {
        c += 10
        break
      }
  for (const r of others)
    for (let i = 0; i + 1 < pts.length; i++)
      for (let j = 0; j + 1 < r.pts.length; j++)
        if (segX([pts[i], pts[i + 1]], [r.pts[j], r.pts[j + 1]])) c += 1
  return c
}
