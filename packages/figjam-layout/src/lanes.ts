// Strategy "lanes": every edge gets its own lane on a 20px routing lattice, so parallel lines are
// always ≥ 20px apart. Section borders are walls with door windows (one per family pair, aligned
// on facing sides); each edge leaves its card through its own port (spread along the side, ≥ 20px
// from corners) with a straight 40px stub; bends are ≥ 40px apart; lines keep ≥ 20px from cards
// they don't touch and never run on a section border. Routes are found with A* over
// (node, direction, run) states with exclusive edges/nodes (perpendicular crossings allowed,
// penalized, never at doors or stubs), routed bundle by bundle so lanes nest, then improved by
// rip-up-and-reroute. Labels go in free space beside their own line, or are dropped.
//
// The stages live in lanes-*.ts: the lattice and shared types (grid), door windows (doors), ports
// and link modes (ports), the A* search (search), layered routing inside families (layered), the
// drawn output (draw), and the self-checks (checks, shape, labels).
import { checks } from "./lanes-checks"
import {
  groupEdges,
  groupKeyOf,
  markBorders,
  markDoors,
  placeWindows,
  splitPairs,
} from "./lanes-doors"
import {
  bundlePieces,
  doorMarks,
  doorNodes,
  explainRoutes,
  finalRoutes,
  placedPts,
} from "./lanes-draw"
import {
  blockRect,
  makeGrid,
  makeUsage,
  portKey,
  titleRect,
  type Board,
  type Ctx,
  type Grid,
  type LaneOpts,
  type Placed,
  type Port,
} from "./lanes-grid"
import { monotonePts, pathLen, placeLabels } from "./lanes-labels"
import { layeredStage } from "./lanes-layered"
import {
  assignModes,
  buildCorridors,
  buildPorts,
  idealPorts,
  markChannels,
  markNoShare,
} from "./lanes-ports"
import { occupy, place, reset } from "./lanes-search"
import {
  center,
  jsonClone,
  last,
  must,
  simplify,
  type Edge,
  type Layout,
  type Rect,
  type Route,
} from "./model"

export { checks } from "./lanes-checks"
export { piecesFromRoutes } from "./lanes-draw"
export { type LaneOpts, titleRect } from "./lanes-grid"
export { labelSize, monotonePts, placeLabels } from "./lanes-labels"

// ---- preparing the board ----
// everything outside the global plan's bounding box is blocked, so nothing can wrap around the page
function blockOutside(g: Grid, B: Rect): void {
  for (let k = 0; k < g.N; k++) {
    const x = g.X(k),
      y = g.Y(k)
    if (x < B.x || x > B.x + B.w || y < B.y || y > B.y + B.h) g.blocked[k] = 1
  }
}

// The lattice with cards, blocks, section titles, walls, doors, ports and channel bands marked.
function prepare(L: Layout, opts: LaneOpts): Ctx {
  const b: Board = {
    L,
    opts,
    m: new Map(L.nodes.map((n) => [n.id, n])),
    sec: new Map(L.sections.map((s) => [s.id, s])),
  }
  const g = makeGrid([
    ...L.sections.map((s) => s.rect),
    ...L.nodes.map((n) => n.rect),
    ...(L.blocks ?? []),
  ])
  // ---- obstacles ----
  for (const n of L.nodes) blockRect(g, n.rect, 16) // cards, labels, headings: ≥ 16px clearance
  for (const r of L.blocks ?? []) blockRect(g, r, 16)
  const titles = L.sections.map((s) => titleRect(s, opts.titleW))
  for (const t of titles) blockRect(g, t, 8)
  if (opts.plan) blockOutside(g, opts.plan.bbox)
  // ---- doors: one window per (section, other section), aligned when the sections face ----
  const pr = splitPairs(L)
  markBorders(L, g)
  const windows = placeWindows(b, pr)
  const gr = groupEdges(L)
  markDoors(b, g, { pr, gr, windows })
  // ---- ports and channel structure ----
  const { ports, allPorts } = buildPorts(L, g)
  markNoShare(L, g)
  markChannels(L, g)
  const md = assignModes(b)
  const newTags = new Set<string>(
    L.edges.filter((e) => md.mode.get(e.id) === "tag").map((e) => e.id),
  )
  const { prefPort, portCause } = idealPorts(
    { b, allPorts, md },
    (e) => !newTags.has(e.id),
  )
  const portByKey = new Map<string, Port>()
  for (const list of allPorts.values())
    for (const p of list) portByKey.set(portKey(p), p)
  return {
    ...b,
    ...pr,
    ...g,
    ...makeUsage(g.N),
    BEND: opts.bend ?? 6,
    CROSS: opts.cross ?? 50,
    SHARE: opts.share ?? 0.3, // cost per 20px on a lane our own bundle already uses (pulls bundles together)
    CORR: opts.corridor ?? 1.5,
    titles,
    windows,
    groupIds: gr.groupIds,
    gOf: gr.gOf,
    edgeIdx: gr.edgeIdx,
    ports,
    allPorts,
    portByKey,
    ...md,
    newTags,
    prefPort,
    portCause,
    bendCause: new Map<string, Array<string>>(),
    corridor: buildCorridors(opts.plan),
    direct: new Set<string>(),
    avoidG: new Set<number>(),
  }
}

const routable = (c: Ctx, e: Edge) => !c.newTags.has(e.id)

// ---- routing order and rip-up-and-retry ----
// order: bundles (long first), members sorted along their window so lanes nest; then intra edges
function routingOrder(c: Ctx): Array<Edge> {
  const len = (e: Edge) => {
    const a = center(must(c.m.get(e.from), "node").rect),
      b = center(must(c.m.get(e.to), "node").rect)
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])
  }
  const order: Array<Edge> = []
  if (c.opts.plan) {
    order.push(...[...c.L.edges].sort((p, q) => len(p) - len(q))) // nearest first: short links take the inner lanes
    return order
  }
  const bundles = [...c.pairs.values()].sort(
    (p, q) =>
      q.reduce((s, e) => s + len(e), 0) / q.length
      - p.reduce((s, e) => s + len(e), 0) / p.length,
  )
  const gOf = (e: Edge) => must(c.gOf.get(e.id), "group")
  for (const es of bundles)
    order.push(...[...es].sort((p, q) => gOf(p) - gOf(q) || len(q) - len(p)))
  order.push(...[...c.intra].sort((p, q) => len(q) - len(p)))
  return order
}

// re-route each link in turn, keeping the new route only when it is no more expensive
function reroutePass(c: Ctx, ord: Array<Edge>, failed: Array<Edge>): void {
  for (const e of ord) {
    if (c.direct.has(e.id) || !routable(c, e)) continue
    const p = c.placed.get(e.id)
    if (!p) {
      if (place(c, e)) {
        const k = failed.indexOf(e)
        if (k !== -1) failed.splice(k, 1)
      }
      continue
    }
    occupy(c, p, false)
    c.placed.delete(e.id)
    if (!place(c, e)) {
      c.placed.set(e.id, p)
      occupy(c, p, true)
      continue
    }
    const np = must(c.placed.get(e.id), "rerouted link")
    if (np.cost > p.cost) {
      occupy(c, np, false)
      c.placed.set(e.id, p)
      occupy(c, p, true)
    }
  }
}

// one whole attempt in the given order; returns the links that could not be routed
function attempt(c: Ctx, ord: Array<Edge>): Array<Edge> {
  reset(c)
  c.direct.clear()
  const failed: Array<Edge> = []
  layeredStage(c)
  for (const e of ord)
    if (routable(c, e) && !c.direct.has(e.id) && !place(c, e)) failed.push(e)
  for (const e of failed.splice(0)) if (!place(c, e)) failed.push(e)
  for (let pass = 0; pass < (c.opts.passes ?? 1); pass++)
    reroutePass(c, ord, failed)
  return failed
}

// rip-up-and-retry: whole attempts, moving edges that failed to the front each time
function routeAll(c: Ctx): Array<Edge> {
  let ord = routingOrder(c)
  let best: { order: Array<Edge>; failed: number } | undefined
  let failed: Array<Edge> = []
  for (let t = 0; t < (c.opts.attempts ?? 6); t++) {
    const now = attempt(c, ord)
    failed = now
    if (!best || now.length < best.failed)
      best = { order: ord, failed: now.length }
    if (now.length === 0) break
    ord = [...now, ...ord.filter((e) => !now.includes(e))]
  }
  const kept = must(best, "routing attempt")
  if (failed.length > kept.failed) failed = attempt(c, kept.order)
  return failed
}

// ---- undoing lane swaps ----
function curRoutes(c: Ctx): Array<Route> {
  return [...c.placed.values()].map((p) => ({
    edge: p.edge.id,
    pts: simplify(placedPts(c, p)),
    native: false,
    bundle: groupKeyOf(c.L, p.edge),
  }))
}

function swapInfo(c: Ctx): { n: number; pairs: Array<[string, string]> } {
  const T: Layout = { ...c.L, routes: curRoutes(c), labels: [], doorNodes: [] }
  const ck = checks(T, c.titles)
  return {
    n: ck.laneSwaps * 100 + ck.laneSwapsInSections,
    pairs: must(T.swapGutterPairs, "gutter swaps").concat(
      must(T.swapPairs, "swaps"),
    ),
  }
}

// put the given placements back after a failed re-route
function restore(c: Ctx, members: Array<Placed>): void {
  for (const p of members) {
    const q = c.placed.get(p.edge.id)
    if (q) {
      occupy(c, q, false)
      c.placed.delete(p.edge.id)
    }
  }
  for (const p of members) {
    c.placed.set(p.edge.id, p)
    occupy(c, p, true)
  }
}

// re-route the bundles in `rip` (in that order), the one that isn't `avoidKey` not crossing the
// other; returns whether every member found a route
function ripAndReplace(
  c: Ctx,
  plan: { pair: [string, string]; rip: Array<string>; avoidKey: string },
  members: Array<Placed>,
): boolean {
  const [A, B] = plan.pair
  const { rip, avoidKey } = plan
  let ok = true
  for (const bk of rip) {
    c.avoidG =
      bk === avoidKey ?
        new Set()
      : new Set([must(c.groupIds.get(bk === A ? B : A), "bundle")])
    if (rip.length === 2 && bk === rip[0]) c.avoidG = new Set()
    for (const p of members.filter((q) => groupKeyOf(c.L, q.edge) === bk))
      if (!place(c, p.edge)) ok = false
  }
  c.avoidG = new Set()
  return ok
}

// strategies: re-route B avoiding A; re-route A avoiding B; re-route both (each order). Returns the
// new swap info when one of them lowers the swap count.
function unswapPair(
  c: Ctx,
  pair: [string, string],
  n: number,
): ReturnType<typeof swapInfo> | undefined {
  const [A, B] = pair
  const plans: Array<[Array<string>, string]> = [
    [[B], A],
    [[A], B],
    [[A, B], B],
    [[B, A], A],
  ]
  for (const [rip, avoidKey] of plans) {
    const members = [...c.placed.values()].filter(
      (p) => rip.includes(groupKeyOf(c.L, p.edge)) && !c.direct.has(p.edge.id),
    )
    for (const p of members) {
      occupy(c, p, false)
      c.placed.delete(p.edge.id)
    }
    const ok = ripAndReplace(c, { pair, rip, avoidKey }, members)
    const ni = ok ? swapInfo(c) : undefined
    if (ni && ni.n < n) return ni
    restore(c, members)
  }
  return undefined
}

// undo lane swaps: re-route one bundle of a swapping pair so it may not cross the other at all;
// keep the change only if the total number of swaps drops
function unswap(c: Ctx): void {
  let info = swapInfo(c)
  const tried = new Set<string>()
  for (let it = 0; it < (c.opts.unswap ?? 80) && info.n > 0; it++) {
    // gutter swaps first (they are hard failures), then swaps inside sections
    const pair = info.pairs.find((p) => !tried.has(p.join("#")))
    if (!pair) break
    tried.add(pair.join("#"))
    const better = unswapPair(c, pair, info.n)
    if (better) {
      info = better
      tried.clear()
    }
  }
}

// policy B: a cross-family link that is not monotone becomes a name tag when it detours or bends
// too much
function tagDetours(c: Ctx): void {
  for (const p of c.placed.values()) {
    if (c.mode.get(p.edge.id) !== "astar") continue
    const pts = simplify(placedPts(c, p))
    if (monotonePts(pts)) continue
    const len = pathLen(pts)
    const man =
      Math.abs(pts[0][0] - last(pts)[0]) + Math.abs(pts[0][1] - last(pts)[1])
    if (len / Math.max(40, man) > 1.25 || pts.length - 2 > 4)
      c.newTags.add(p.edge.id)
  }
}

function lanesNow(L0: Layout, opts: LaneOpts): Layout {
  const L = jsonClone(L0)
  L.name = opts.name ?? "lanes"
  const tags = opts.tags ?? opts.plan?.tagged ?? new Set<string>()
  L.edges = L.edges.filter((e) => !tags.has(e.id)) // name-tagged edges get link pills, not wires
  const c = prepare(L, opts)
  const failed = routeAll(c)
  if (failed.length === 0) unswap(c)
  if (opts.policy === "B") tagDetours(c)
  L.policy = opts.policy ?? "A"
  // links that could only be routed non-monotonically become name tags: take their wires back out
  for (const id of c.newTags) {
    const p = c.placed.get(id)
    if (p) {
      occupy(c, p, false)
      c.placed.delete(id)
    }
  }
  L.newTags = [...c.newTags]
  // ---- geometry: each edge's polyline (for metrics/labels) + each bundle drawn once as chains ----
  L.routes = finalRoutes(c)
  const { pieces, bundles } = bundlePieces(c)
  L.pieces = pieces
  L.doors = doorMarks(c)
  L.doorNodes = doorNodes(c)
  L.labels = placeLabels(L, c.titles)
  L.explain = explainRoutes(c)
  L.checks = checks(L, c.titles)
  L.checks.unrouted = failed.length
  L.notes = [
    `${L.routes.length}/${L.edges.length} routed in ${bundles} bundles/lanes; ${c.windows.length} door windows; ${failed.length} unrouted: ${failed.map((e) => e.id).join(",")}`,
  ]
  return L
}

// Route every edge of the layout on lanes; resolves to a new layout (the input is not changed).
export function lanes(L0: Layout, opts: LaneOpts = {}): Promise<Layout> {
  // a throw becomes a rejection, as it would from an async function
  return new Promise((resolve) => {
    resolve(lanesNow(L0, opts))
  })
}

export const HARD_CHECKS = [
  "pitchViolations",
  "shortJogs",
  "portViolations",
  "clearance",
  "borderRuns",
  "titleHits",
  "labelHits",
  "labelsTruncated",
  "nearCross",
  "arrowHits",
  "laneSwaps",
  "perimeterWraps",
  "unrouted",
  "tagHits",
  "tagsUnplaced",
  "thereAndBack",
  "straightMissed",
  "zExtraBends",
  "sharedSplits",
  "slantedEntries",
  "cornerPorts",
  "nestingViolations",
  "nonMonotone",
  "nonMonotoneGlobal",
  "wallOutsideDoor",
  "sectionDetour",
  "unexplainedPorts",
  "offCenterAlone",
  "pillsInCorridor",
  "simplificationsLeft",
  "stubViolations",
  "arrowDirection",
  "tagsMissing",
  "sJogs",
]
