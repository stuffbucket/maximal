// Output of the "lanes" router: each edge's polyline, each bundle drawn once as chains (dashes run
// continuously, nothing is drawn twice) plus one arrowhead per link, the door marks, and an
// explanation of every port deviation and every bend.
import { groupKeyOf } from "./lanes-doors"
import {
  firstLine,
  nodeOf,
  sectionRect,
  wallPoint,
  type Ctx,
  type Placed,
} from "./lanes-grid"
import {
  must,
  simplify,
  type Edge,
  type Explanation,
  type Node,
  type Piece,
  type Pt,
  type Rect,
  type Route,
} from "./model"

// A placed route's polyline: card border, lattice nodes, card border (not simplified).
export function placedPts(c: Ctx, p: Placed): Array<Pt> {
  return [
    p.from.border,
    ...p.nodes.map((k): Pt => [c.X(k), c.Y(k)]),
    p.to.border,
  ]
}

export function finalRoutes(c: Ctx): Array<Route> {
  const routes: Array<Route> = []
  for (const e of c.L.edges) {
    const p = c.placed.get(e.id)
    if (!p) continue
    routes.push({
      edge: e.id,
      pts: simplify(placedPts(c, p)),
      native: false,
      fromMagnet: p.from.side,
      toMagnet: p.to.side,
      bundle: groupKeyOf(c.L, e),
    })
  }
  return routes
}

// ---- chains ----
type Adjacency = Map<string, Set<string>>
const keyOf = (p: Pt) => `${p[0]},${p[1]}`
const parseKey = (k: string) => k.split(",").map(Number) as Pt

function link(adj: Adjacency, a: Pt, b: Pt): void {
  for (const [u, v] of [
    [a, b],
    [b, a],
  ]) {
    const s = adj.get(keyOf(u)) ?? new Set()
    s.add(keyOf(v))
    adj.set(keyOf(u), s)
  }
}

// chains between junctions/ends, so dashes run continuously and nothing is drawn twice
function chainsOf(adj: Adjacency, ends: Set<string>): Array<Array<Pt>> {
  const chains: Array<Array<Pt>> = []
  const seen = new Set<string>()
  const isStop = (k: string) => ends.has(k) || (adj.get(k)?.size ?? 0) !== 2
  for (const [start, nbs] of adj) {
    if (!isStop(start)) continue
    for (const nb of nbs) {
      const ek = [start, nb].sort().join("|")
      if (seen.has(ek)) continue
      seen.add(ek)
      const chain = [start]
      let prev = start,
        cur = nb
      while (true) {
        chain.push(cur)
        if (isStop(cur)) break
        const from = prev
        const nxt = must(
          [...must(adj.get(cur), "chain node")].find((x) => x !== from),
          "chain successor",
        )
        const k2 = [cur, nxt].sort().join("|")
        if (seen.has(k2)) break
        seen.add(k2)
        prev = cur
        cur = nxt
      }
      chains.push(chain.map((k) => parseKey(k)))
    }
  }
  return chains
}

// Each bundle's union graph drawn once as chains, plus one arrowhead per edge at its target border.
export function bundlePieces(c: Ctx): {
  pieces: Array<Piece>
  bundles: number
} {
  const pieces: Array<Piece> = []
  const kindOfG = new Map<number, string>()
  for (const e of c.L.edges) kindOfG.set(must(c.gOf.get(e.id), "group"), e.kind)
  const byG = new Map<number, Array<Placed>>()
  for (const p of c.placed.values()) byG.set(p.g, [...(byG.get(p.g) ?? []), p])
  for (const [G, ps] of byG) {
    // union graph of the bundle's unit edges (plus the two stub segments to the card borders)
    const adj: Adjacency = new Map()
    const ends = new Set<string>()
    for (const p of ps) {
      const pts = placedPts(c, p)
      for (let i = 1; i < pts.length; i++) link(adj, pts[i - 1], pts[i])
      ends.add(keyOf(p.from.border))
      ends.add(keyOf(p.to.border))
    }
    for (const chain of chainsOf(adj, ends))
      pieces.push({
        id: `g${G}.${pieces.length}`,
        kind: kindOfG.get(G),
        pts: simplify(chain),
        arrow: false,
        count: ps.length,
        role: "chain",
      })
    // arrowheads: one per edge at its target border
    for (const p of ps) {
      const pts = simplify(placedPts(c, p))
      pieces.push({
        id: `a.${p.edge.id}`,
        kind: kindOfG.get(G),
        pts: pts.slice(-2),
        arrow: true,
        arrowOnly: true,
        count: 1,
        role: "arrow",
      })
    }
  }
  return { pieces, bundles: byG.size }
}

// Union graph of a bundle's routes, split into 20px steps (port borders may be off-lattice: keep
// their exact point).
function routeAdjacency(rs: Array<Route>): {
  adj: Adjacency
  ends: Set<string>
} {
  const adj: Adjacency = new Map()
  const ends = new Set<string>()
  for (const r of rs) {
    ends.add(keyOf(r.pts[0]))
    ends.add(keyOf(must(r.pts.at(-1), "route end")))
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1],
        c = r.pts[i]
      const steps: Array<Pt> = [a]
      const dx = Math.sign(c[0] - a[0]),
        dy = Math.sign(c[1] - a[1])
      let x = a[0],
        y = a[1]
      while (Math.abs(c[0] - x) > 20 || Math.abs(c[1] - y) > 20) {
        x += dx * 20
        y += dy * 20
        steps.push([x, y])
      }
      steps.push(c)
      for (let j = 1; j < steps.length; j++)
        if (keyOf(steps[j - 1]) !== keyOf(steps[j]))
          link(adj, steps[j - 1], steps[j])
    }
  }
  return { adj, ends }
}

// Drawing pieces from final routes: each bundle's union drawn once as chains (dashes stay continuous,
// nothing drawn twice), plus one arrowhead piece per link at its target.
export function piecesFromRoutes(L: {
  edges: Array<Edge>
  routes: Array<Route>
}): Array<Piece> {
  const kindOf = new Map(L.edges.map((e) => [e.id, e.kind]))
  const byB = new Map<string, Array<Route>>()
  for (const r of L.routes)
    byB.set(r.bundle ?? r.edge, [...(byB.get(r.bundle ?? r.edge) ?? []), r])
  const pieces: Array<Piece> = []
  for (const [b, rs] of byB) {
    const { adj, ends } = routeAdjacency(rs)
    const kind = kindOf.get(rs[0].edge)
    for (const chain of chainsOf(adj, ends))
      pieces.push({
        id: `${b}.${pieces.length}`,
        kind,
        pts: simplify(chain),
        arrow: false,
        count: rs.length,
        role: "chain",
      })
    for (const r of rs)
      pieces.push({
        id: `a.${r.edge}`,
        kind,
        pts: r.pts.slice(-2),
        arrow: true,
        arrowOnly: true,
        count: 1,
        role: "arrow",
      })
  }
  return pieces
}

// ---- doors ----
export function doorMarks(c: Ctx): Array<{ pt: Pt }> {
  return c.windows.map((w) => ({
    pt: wallPoint(sectionRect(c, w.s), w.side, (w.lo + w.hi) / 2),
  }))
}

export function doorNodes(c: Ctx): Array<Pt> {
  return [...c.doorOwner.keys()]
    .filter((k) => c.doorOwner[k] >= 0)
    .map((k): Pt => [c.X(k), c.Y(k)])
}

// ---- explanations ----
type PortEnd = { side: string; deviation: number; cause: string }

function endSide(R: Rect, pt: Pt): string {
  if (pt[1] <= R.y) return "TOP"
  if (pt[1] >= R.y + R.h) return "BOTTOM"
  if (pt[0] <= R.x + R.w / 2) return "LEFT"
  return "RIGHT"
}

function portEnd(c: Ctx, card: string, end: [0 | 1, string, Pt]): PortEnd {
  const [n, eid, pt] = end
  const R = nodeOf(c, card).rect
  const onTB = pt[1] <= R.y || pt[1] >= R.y + R.h
  const dev = onTB ? pt[0] - (R.x + R.w / 2) : pt[1] - (R.y + R.h / 2)
  return {
    side: endSide(R, pt),
    deviation: Math.round(dev),
    cause: c.portCause.get(`${eid}|${n}`) ?? "",
  }
}

// whether a 200px run from x in direction dx reaches or leaves section R across its left/right wall
function wallAheadX(R: Rect, x: number, dx: number): boolean {
  if (!dx) return false
  const to = x + dx * 200
  return (
    (x < R.x && to >= R.x)
    || (x > R.x + R.w && to <= R.x + R.w)
    || (x > R.x && x < R.x + R.w && (to <= R.x || to >= R.x + R.w))
  )
}

// the same across a top/bottom wall
function wallAheadY(R: Rect, y: number, dy: number): boolean {
  if (!dy) return false
  const to = y + dy * 200
  return (
    (y < R.y && to >= R.y)
    || (y > R.y && y < R.y + R.h && (to <= R.y || to >= R.y + R.h))
  )
}

type BendScene = { e: Edge; pts: Array<Pt>; cards: Array<Node> }

// Why the route turns at point i: a card ahead, a wall or door ahead, or its port/target.
function bendReason(c: Ctx, bs: BendScene, i: number): string {
  const { e, pts, cards } = bs
  const a = pts[i - 1],
    b = pts[i]
  const dx = Math.sign(b[0] - a[0]),
    dy = Math.sign(b[1] - a[1])
  const ahead = {
    x: Math.min(b[0], b[0] + dx * 200),
    y: Math.min(b[1], b[1] + dy * 200),
    w: Math.abs(dx) * 200 || 1,
    h: Math.abs(dy) * 200 || 1,
  }
  const hit = cards.find(
    (n) =>
      n.id !== e.to
      && n.id !== e.from
      && ahead.x < n.rect.x + n.rect.w + 20
      && n.rect.x - 20 < ahead.x + ahead.w
      && ahead.y < n.rect.y + n.rect.h + 20
      && n.rect.y - 20 < ahead.y + ahead.h,
  )
  if (hit) return `turns before ${firstLine(hit.text ?? hit.id)}`
  const wall = c.L.sections.find(
    (sc) => wallAheadX(sc.rect, b[0], dx) || wallAheadY(sc.rect, b[1], dy),
  )
  if (wall) return `turns at the ${wall.name} wall / door`
  if (i === 1 || i + 2 === pts.length) return "turns toward its port"
  return "turns toward the target"
}

// explanations: every port deviation and every bend gets a cause
export function explainRoutes(c: Ctx): Record<string, Explanation> {
  const explain: Record<string, Explanation> = {}
  const cards = c.L.nodes.filter((n) => n.obstacle)
  for (const r of c.L.routes) {
    const e = must(
      c.L.edges.find((x) => x.id === r.edge),
      `edge ${r.edge}`,
    )
    const from = portEnd(c, e.from, [0, e.id, r.pts[0]])
    const to = portEnd(c, e.to, [1, e.id, must(r.pts.at(-1), "route end")])
    const bends: Array<string> = []
    const given = c.bendCause.get(e.id)
    for (let i = 1; i + 1 < r.pts.length; i++)
      bends.push(given ? given[0] : bendReason(c, { e, pts: r.pts, cards }, i))
    explain[e.id] = { mode: c.mode.get(e.id), from, to, bends }
  }
  return explain
}
