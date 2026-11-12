// The search of the "lanes" router: lane usage bookkeeping, the A* over (node, direction, run)
// states with exclusive edges/nodes (perpendicular crossings allowed, penalized, never at doors or
// stubs), and `place`, which tries progressively looser settings until a link has a route.
import { sectionOf } from "./engine"
import {
  DX,
  DY,
  Heap,
  P,
  SIDE_DIR,
  facing,
  firstLine,
  nodeOf,
  pairKey,
  portKey,
  type Ctx,
  type Placed,
  type Port,
  type Usage,
} from "./lanes-grid"
import { must, type Edge, type Rect } from "./model"

// ---- usage ----
// The unit-edge index between neighbouring nodes a and b.
export function ue(nx: number, a: number, b: number): number {
  const d = b - a
  if (d === 1) return a * 2
  if (d === -1) return b * 2
  if (d === nx) return a * 2 + 1
  return b * 2 + 1
}

// How a path passes node i: 1 straight horizontal, 2 straight vertical, 3 turning or ending.
function modeAt(nx: number, ns: Array<number>, i: number): number {
  if (i === 0 || i === ns.length - 1) return 3
  const d = Math.abs(ns[i + 1] - ns[i - 1])
  if (d === 2) return 1
  if (d === 2 * nx) return 2
  return 3
}

function holdNode(u: Usage, k: number, gm: [number, number]): void {
  const [G, md] = gm
  const { nodeG, nodeC, nodeM, nodeXG, nodeXC, nodeXM } = u
  if (nodeG[k] < 0) {
    nodeG[k] = G
    nodeC[k] = 1
    nodeM[k] = md
  } else if (nodeG[k] === G) {
    nodeC[k]++
    if (nodeM[k] !== md) nodeM[k] = 3
  } else {
    nodeXG[k] = G
    nodeXC[k]++
    nodeXM[k] = md
  }
}

function releaseNode(u: Usage, k: number, G: number): void {
  const { nodeG, nodeC, nodeM, nodeXG, nodeXC, nodeXM } = u
  if (nodeG[k] === G) {
    if (--nodeC[k] !== 0) return
    if (nodeXG[k] >= 0) {
      nodeG[k] = nodeXG[k]
      nodeC[k] = nodeXC[k]
      nodeM[k] = nodeXM[k]
      nodeXG[k] = -1
      nodeXC[k] = 0
    } else {
      nodeG[k] = -1
      nodeM[k] = 0
    }
  } else if (nodeXG[k] === G && --nodeXC[k] === 0) nodeXG[k] = -1
}

// which cards each bundle touches (links sharing a card must nest, never cross)
function countCards(u: Usage, p: Placed, set: boolean): void {
  let mp = u.groupCards.get(p.g)
  if (!mp) {
    mp = new Map()
    u.groupCards.set(p.g, mp)
  }
  for (const c of [p.edge.from, p.edge.to]) {
    const v = (mp.get(c) ?? 0) + (set ? 1 : -1)
    if (v <= 0) mp.delete(c)
    else mp.set(c, v)
  }
}

// Take (set) or release a placed route's nodes, unit edges, ports and stubs.
export function occupy(c: Ctx, p: Placed, set: boolean): void {
  const G = p.g,
    ns = p.nodes
  for (let i = 0; i < ns.length; i++) {
    const k = ns[i]
    if (set) holdNode(c, k, [G, modeAt(c.nx, ns, i)])
    else releaseNode(c, k, G)
    if (i === 0) continue
    const u = ue(c.nx, ns[i - 1], k)
    if (set) {
      c.edgeG[u] = G
      c.edgeC[u]++
    } else if (--c.edgeC[u] === 0) c.edgeG[u] = -1
  }
  for (const q of [p.from, p.to]) {
    if (set) c.usedPort.add(portKey(q))
    else c.usedPort.delete(portKey(q))
    c.stub[q.n1] = set ? 1 : 0
    c.stub[q.n2] = set ? 1 : 0
  }
  countCards(c, p, set)
}

export function portFree(c: Ctx, p: Port): boolean {
  return (
    !c.usedPort.has(portKey(p))
    && c.nodeG[p.n1] < 0
    && c.nodeG[p.n2] < 0
    && !c.stub[p.n1]
    && !c.stub[p.n2]
  )
}

// a port within 40px of another port already used on the same side of the same card
function tightPort(c: Ctx, card: string, p: Port): boolean {
  return [...c.usedPort].some((k) => {
    if (!k.startsWith(`${card}|`)) return false
    const [ux, uy] = k.split("|").slice(1).map(Number)
    return p.side === "TOP" || p.side === "BOTTOM" ?
        uy === p.border[1]
          && Math.abs(ux - p.border[0]) < 40
          && ux !== p.border[0]
      : ux === p.border[0]
          && Math.abs(uy - p.border[1]) < 40
          && uy !== p.border[1]
  })
}

// ---- the search ----
type RouteQuery = {
  G: number
  allowed: number
  flex: boolean
  level: number
  mono: boolean
}

type Search = RouteQuery & {
  c: Ctx
  e: Edge
  EI: number
  SR: Rect
  TR: Rect
  SS: Rect | undefined
  TS: Rect | undefined
  corr: Uint8Array | undefined
  tb: [number, number, number, number] // target box grown by 40px: x0, x1, y0, y1
}

type Move = { k: number; q: number; nd: number; turn: boolean }

// the free ports a link end may use at this level of the search
function pick(sr: Search, end: 0 | 1): Array<Port> {
  const { c, e, level } = sr
  const card = end === 0 ? e.from : e.to
  const free = (c.allPorts.get(card) ?? []).filter((p) => portFree(c, p))
  const sd = c.sideMap.get(e.id)
  if (!sd || level >= 2) return free
  const onSide = free.filter((p) => p.side === sd[end])
  if (level === 1) {
    // target end: keep ≥ 40px from ports already used on this side when the side allows it
    // (source end: a small start penalty instead, so a straighter line can still win)
    if (end === 0) return onSide
    const spaced = onSide.filter((p) => !tightPort(c, card, p))
    return spaced.length > 0 ? spaced : onSide
  }
  const pref = c.prefPort.get(`${e.id}|${end}`)
  return onSide.filter((p) => portKey(p) === pref)
}

function inR(c: Ctx, z: number, R: Rect | undefined): boolean {
  return (
    R !== undefined
    && c.X(z) >= R.x
    && c.X(z) <= R.x + R.w
    && c.Y(z) >= R.y
    && c.Y(z) <= R.y + R.h
  )
}

function dX(c: Ctx, z: number, R: Rect): number {
  return Math.max(0, R.x - c.X(z), c.X(z) - R.x - R.w)
}

function dY(c: Ctx, z: number, R: Rect): number {
  return Math.max(0, R.y - c.Y(z), c.Y(z) - R.y - R.h)
}

// heuristic: distance to the target box, at the cheapest (shared-lane) step cost
function heur(sr: Search, k: number): number {
  const [tx0, tx1, ty0, ty1] = sr.tb
  const x = sr.c.X(k),
    y = sr.c.Y(k)
  return (
    ((Math.max(0, tx0 - x, x - tx1) + Math.max(0, ty0 - y, y - ty1)) / P)
    * sr.c.SHARE
  )
}

function cellOf(c: Ctx, k: number): number {
  const gp = c.opts.plan
  if (!gp) return -1
  const i = Math.floor((c.X(k) - gp.gx0) / gp.g),
    j = Math.floor((c.Y(k) - gp.gy0) / gp.g)
  return i < 0 || j < 0 || i >= gp.gnx || j >= gp.gny ? -1 : j * gp.gnx + i
}

// turn only on a free node or where our own bundle runs (a merge/split), never at a crossing
function canTurn(sr: Search, k: number, run: number): boolean {
  const { doorOwner, border, stub, nodeG, nodeXG, noShare, perpOnly } = sr.c
  if (!run || doorOwner[k] >= 0 || border[k] || stub[k]) return false
  if (
    nodeG[k] >= 0
    && (nodeG[k] !== sr.G || nodeXG[k] >= 0 || noShare[k] || perpOnly[k])
  )
    return false
  return nodeXG[k] < 0
}

// a step from k to q that moves away from R on either axis
function movesAway(c: Ctx, kq: [number, number], R: Rect): boolean {
  const [k, q] = kq
  return dX(c, q, R) > dX(c, k, R) || dY(c, q, R) > dY(c, k, R)
}

// a step from k to q that moves closer to R on either axis
function movesCloser(c: Ctx, kq: [number, number], R: Rect): boolean {
  const [k, q] = kq
  return dX(c, q, R) < dX(c, k, R) || dY(c, q, R) < dY(c, k, R)
}

// monotone inside sections: never move away from the target inside its family, never move back
// toward the source inside the source's family
function monotoneOk(sr: Search, k: number, q: number): boolean {
  const { c, mono, SR, TR, SS, TS } = sr
  if (!mono) return true
  if (c.opts.policy !== "B") return !movesAway(c, [k, q], TR) // A: monotone everywhere
  // B: monotone inside the families; outside, the route is judged afterwards (detour, bends)
  if (inR(c, k, TS) && inR(c, q, TS) && movesAway(c, [k, q], TR)) return false
  if (inR(c, k, SS) && inR(c, q, SS) && SS !== TS && movesCloser(c, [k, q], SR))
    return false
  return true
}

// door slots: any free slot of this pair's window; the assigned one is free of charge, others
// cost a little (so the lane keeps its coordinate instead of jogging to reach its slot)
function slotPenalty(sr: Search, q: number): number | undefined {
  const { c } = sr
  if (c.doorOwner[q] < 0) return 0
  if (c.doorOwner[q] !== sr.allowed || c.nodeG[q] >= 0) return undefined
  if (c.doorSlot[q] === sr.EI) return 0
  if (!sr.flex && c.opts.strictSlots) return undefined
  return c.opts.slotPenalty ?? 5
}

// a straight perpendicular crossing of another bundle's straight segment, away from doors: whether
// it is allowed
function crossable(sr: Search, q: number, horiz: boolean): boolean {
  const { c, G, e } = sr
  const { nodeG, nodeXG, nodeM, near } = c
  if (nodeXG[q] >= 0 && nodeXG[q] !== G) return false
  if (
    near[q]
    || nodeM[q] === 3
    || (horiz && nodeM[q] !== 2)
    || (!horiz && nodeM[q] !== 1)
  )
    return false
  if (c.avoidG.has(nodeG[q])) return false
  const gc = c.groupCards.get(nodeG[q])
  return !gc || (!gc.has(e.from) && !gc.has(e.to)) // shares a card with us: nest, don't cross
}

// Whether entering q crosses another bundle (true), runs free or in our own bundle (false), or is
// not allowed at all (undefined).
function crossingAt(
  sr: Search,
  q: number,
  horiz: boolean,
): boolean | undefined {
  const { c, G } = sr
  const { nodeG, nodeXG, nodeM } = c
  if (nodeG[q] >= 0 && nodeG[q] !== G) {
    if (!crossable(sr, q, horiz)) return undefined
    return nodeXG[q] < 0
  }
  if (
    nodeG[q] === G
    && nodeXG[q] >= 0 // our bundle is crossed here: keep straight in our bundle's direction
    && ((horiz && nodeM[q] !== 1) || (!horiz && nodeM[q] !== 2))
  )
    return undefined
  return false
}

// Whether a step from k to q along unit edge u may use that edge (shared lanes only for our own
// bundle, outside sections and bands).
function edgeOk(sr: Search, mv: Move, u: number): boolean {
  const { edgeG, noShare, perpOnly, nodeG, nodeXG } = sr.c
  const { k, q } = mv
  if (
    edgeG[u] >= 0
    && (edgeG[u] !== sr.G
      || noShare[k]
      || noShare[q]
      || perpOnly[k]
      || perpOnly[q])
  )
    return false
  if ((nodeG[q] === sr.G || nodeXG[q] === sr.G) && (noShare[q] || perpOnly[q]))
    return false // own bundle inside a section: no shared trunk near cards
  return nodeG[q] !== sr.G || nodeXG[q] < 0 || !sr.c.avoidG.has(nodeXG[q])
}

// Whether the move stays on the lattice, off blocked nodes and stubs, monotone, and along the
// direction a band allows.
function moveOpen(sr: Search, mv: Move): boolean {
  const { blocked, stub, perpOnly, N } = sr.c
  const { k, q, nd } = mv
  if (q < 0 || q >= N || blocked[q] || stub[q]) return false
  if (!monotoneOk(sr, k, q)) return false
  if ((perpOnly[q] === 1 || perpOnly[k] === 1) && nd < 2) return false
  return (perpOnly[q] !== 2 && perpOnly[k] !== 2) || nd < 2
}

// The cost of one move, or undefined when the move is not allowed.
function stepCost(sr: Search, mv: Move): number | undefined {
  const { c } = sr
  const { k, q, turn } = mv
  if (!moveOpen(sr, mv)) return undefined
  const slotPen = slotPenalty(sr, q)
  if (slotPen === undefined) return undefined
  const u = ue(c.nx, k, q)
  if (!edgeOk(sr, mv, u)) return undefined
  let cost = (c.edgeG[u] === sr.G ? c.SHARE : 1) + (turn ? c.BEND : 0) + slotPen
  if (sr.corr) {
    const gc = cellOf(c, q)
    if (gc < 0 || !sr.corr[gc]) cost += c.CORR
  }
  const cross = crossingAt(sr, q, mv.nd < 2)
  if (cross === undefined) return undefined
  if (cross) cost += c.CROSS
  return cost
}

type Frontier = {
  g: Float32Array
  from: Int32Array
  heap: Heap
  startPort: Map<number, Port>
  goal: Map<number, Port>
}

// start states: leaving each source port along its stub, with a small pull toward the preferred port
function seed(sr: Search, fr: Frontier, src: Array<Port>): void {
  const { c, e, TR } = sr
  const tgtSide = SIDE_DIR[facing(nodeOf(c, e.from).rect, TR)]
  for (const p of src) {
    const s = (p.n2 * 4 + p.dir) * 2 + 1
    const pref = c.prefPort.get(`${e.id}|0`)
    const prefP =
      pref ?
        (c.ports.get(e.from) ?? []).find((q) => portKey(q) === pref)
      : undefined
    const pull =
      prefP ?
        ((Math.abs(prefP.border[0] - p.border[0])
          + Math.abs(prefP.border[1] - p.border[1]))
          / P)
        * 0.15
      : 0
    const cost =
      2 + (p.dir === tgtSide ? 0 : 3) + pull + (tightPort(c, e.from, p) ? 3 : 0)
    if (cost < fr.g[s]) {
      fr.g[s] = cost
      fr.startPort.set(s, p)
      fr.heap.push(cost + heur(sr, p.n2), s)
    }
  }
}

// A* until a goal state is popped; returns that state, or -1.
function expand(sr: Search, fr: Frontier): number {
  const { nx } = sr.c
  const { g, from, heap, goal } = fr
  while (heap.size > 0) {
    const s = heap.pop()
    const run = s & 1,
      kd = s >> 1,
      k = kd >> 2,
      d = kd & 3
    const gs = g[s]
    if (goal.has(kd)) return s
    const i = k % nx
    for (const nd of [d, d < 2 ? 2 : 0, d < 2 ? 3 : 1]) {
      const turn = nd !== d
      if (turn && !canTurn(sr, k, run)) continue
      const ni = i + DX[nd]
      if (ni < 0 || ni >= nx) continue
      const q = k + DX[nd] + DY[nd] * nx
      const c = stepCost(sr, { k, q, nd, turn })
      if (c === undefined) continue
      const ns = (q * 4 + nd) * 2 + (turn ? 0 : 1)
      const ng = gs + c
      if (ng < g[ns]) {
        g[ns] = ng
        from[ns] = s
        heap.push(ng + heur(sr, q), ns)
      }
    }
  }
  return -1
}

function route(c: Ctx, e: Edge, rq: RouteQuery): Placed | undefined {
  const From = nodeOf(c, e.from),
    To = nodeOf(c, e.to)
  const T = To.rect
  const sr: Search = {
    ...rq,
    c,
    e,
    EI: must(c.edgeIdx.get(e.id), "edge index"),
    SR: From.rect,
    TR: T,
    SS: c.sec.get(From.section ?? "")?.rect,
    TS: c.sec.get(To.section ?? "")?.rect,
    corr: c.corridor.get(e.id),
    tb: [T.x - 40, T.x + T.w + 40, T.y - 40, T.y + T.h + 40],
  }
  const src = pick(sr, 0)
  const dst = pick(sr, 1)
  if (src.length === 0 || dst.length === 0) return undefined
  const S = c.N * 8
  const fr: Frontier = {
    g: new Float32Array(S).fill(Infinity),
    from: new Int32Array(S).fill(-1),
    heap: new Heap(),
    startPort: new Map<number, Port>(),
    goal: new Map<number, Port>(),
  }
  for (const p of dst) fr.goal.set(p.n2 * 4 + (p.dir ^ 1), p) // arrive at n2 moving toward the card
  seed(sr, fr, src)
  const end = expand(sr, fr)
  if (end < 0) return undefined
  const toPort = must(fr.goal.get(end >> 1), "goal port")
  const nodes: Array<number> = []
  let s = end,
    st = end
  while (s >= 0) {
    nodes.push(s >> 3)
    st = s
    s = fr.from[s]
  }
  nodes.reverse()
  const fromPort = must(fr.startPort.get(st), "start port")
  return {
    edge: e,
    g: rq.G,
    nodes: [fromPort.n1, ...nodes, toPort.n1],
    from: fromPort,
    to: toPort,
    cost: fr.g[end],
  }
}

// ---- placing one link ----
function bendsOf(q: Placed): number {
  let b = 0
  for (let i = 2; i < q.nodes.length; i++)
    if (q.nodes[i] - q.nodes[i - 1] !== q.nodes[i - 1] - q.nodes[i - 2]) b++
  return b
}

// what occupies a port that was wanted (for the explanation)
function blocker(c: Ctx, pk?: string): string {
  if (!pk) return ""
  const owner = [...c.placed.values()].find(
    (q) => portKey(q.from) === pk || portKey(q.to) === pk,
  )
  if (owner)
    return ` (slot taken by ${firstLine(nodeOf(c, owner.edge.from).text)} → ${firstLine(nodeOf(c, owner.edge.to).text)})`
  return ""
}

// any port on the planned side, with a small pull toward the pin-assigned one: ports and lane
// are chosen together by the search instead of the port being fixed first
const TRIES: Array<[boolean, number, boolean, string]> = [
  [false, 0, true, ""],
  [false, 1, true, "its centred slot had no monotone route"],
  [false, 2, true, "no monotone route from the planned side"],
  [true, 2, true, "door slot taken"],
  [true, 2, false, "no monotone route exists (needs a name tag)"],
]

export function place(c: Ctx, e: Edge): boolean {
  const [a, b] = sectionOf(c.L, e)
  const allowed =
    a && b && a !== b ? must(c.pairIdx.get(pairKey(a, b)), "pair") : -2
  const G = must(c.gOf.get(e.id), "group")
  for (const [flex, level, mono, why0] of TRIES) {
    let why = why0
    let p = route(c, e, { G, allowed, flex, level, mono })
    // ports and lane together: if a free port on the same side gives a route with fewer bends
    // (no jog to clear a neighbour), take it over the centred slot
    if (p && level === 0) {
      const q = route(c, e, { G, allowed, flex, level: 1, mono })
      if (q && bendsOf(q) < bendsOf(p)) {
        p = q
        why =
          "moved off its centred slot: from there the line needed an extra jog"
      }
    }
    if (!p) continue
    c.placed.set(e.id, p)
    occupy(c, p, true)
    if (!mono) c.newTags.add(e.id)
    for (const [end, port] of [
      [0, p.from],
      [1, p.to],
    ] as Array<[0 | 1, Port]>) {
      const key = `${e.id}|${end}`
      if (portKey(port) !== c.prefPort.get(key) && why)
        c.portCause.set(key, why + blocker(c, c.prefPort.get(key)))
    }
    return true
  }
  return false
}

export function reset(c: Ctx): void {
  c.nodeG.fill(-1)
  c.nodeC.fill(0)
  c.nodeM.fill(0)
  c.nodeXG.fill(-1)
  c.nodeXC.fill(0)
  c.nodeXM.fill(0)
  c.edgeG.fill(-1)
  c.edgeC.fill(0)
  c.stub.fill(0)
  c.usedPort.clear()
  c.placed.clear()
  c.groupCards.clear()
}
