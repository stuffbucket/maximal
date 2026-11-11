// Self-checks of a routed layout: hard rules (pitch, clearance, ports, stubs, crossings near doors,
// lane swaps, labels) and quality scores (detour, wire length, wrapping). The route-shape checks
// live in lanes-shape.ts.
import {
  crossAt,
  edgeById,
  endSideCode,
  findNode,
  hitRect,
  labelSize,
  pathLen,
  rectsHit,
  segsOf,
  type Seg,
} from "./lanes-labels"
import {
  shapeChecks,
  monotoneChecks,
  trunkChecks,
  type CheckCtx,
} from "./lanes-shape"
import { last, must, type Layout, type Pt, type Rect } from "./model"

// parallel pitch: the closest two overlapping parallel segments of different bundles
function parallelPitch(segs: Array<Seg>) {
  let minPitch = Infinity,
    pitchViolations = 0
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const A = segs[i],
        B = segs[j]
      if (A.edge === B.edge || A.bundle === B.bundle) continue
      const hA = A.a[1] === A.b[1],
        hB = B.a[1] === B.b[1]
      if (hA !== hB) continue
      if (overlap(A, B, hA) <= 0) continue
      const d = hA ? Math.abs(A.a[1] - B.a[1]) : Math.abs(A.a[0] - B.a[0])
      minPitch = Math.min(minPitch, d)
      if (d < 16) pitchViolations++
    }
  return { minPitch, pitchViolations }
}

// overlap of two parallel segments along their axis
function overlap(A: Seg, B: Seg, horiz: boolean): number {
  const [p, q] =
    horiz ?
      [
        [A.a[0], A.b[0]],
        [B.a[0], B.b[0]],
      ]
    : [
        [A.a[1], A.b[1]],
        [B.a[1], B.b[1]],
      ]
  return (
    Math.min(Math.max(...p), Math.max(...q))
    - Math.max(Math.min(...p), Math.min(...q))
  )
}

// a segment running on (within 12px of) a section border
function runsOnBorder(R: Rect, a: Pt, b: Pt): boolean {
  const h = a[1] === b[1]
  const lines = h ? [R.y, R.y + R.h] : [R.x, R.x + R.w]
  const [lo, hi] = h ? [R.x, R.x + R.w] : [R.y, R.y + R.h]
  const c = h ? a[1] : a[0]
  const [u, v] =
    h ?
      [Math.min(a[0], b[0]), Math.max(a[0], b[0])]
    : [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
  return (
    lines.some((l) => Math.abs(l - c) < 12) && v > lo && u < hi && v - u > 0
  )
}

// short jogs (interior segments), clearance from cards, title hits and border runs
function routeRuns(ck: CheckCtx) {
  const { L, edge, cards, titles } = ck
  let shortJogs = 0,
    clearance = 0,
    titleHits = 0,
    borderRuns = 0
  for (const r of L.routes) {
    for (let i = 1; i + 2 < r.pts.length; i++) {
      const a = r.pts[i],
        b = r.pts[i + 1]
      if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 24) shortJogs++
    }
    const e = edgeById(edge, r.edge)
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const a = r.pts[i],
        b = r.pts[i + 1]
      const stub = i === 0 || i + 2 === r.pts.length
      if (
        cards.some(
          (c) =>
            ((c.id !== e.from && c.id !== e.to) || !stub)
            && hitRect([a, b], c.rect, 16),
        )
      )
        clearance++
      for (const t of titles) if (hitRect([a, b], t, 0)) titleHits++
      for (const s of L.sections) if (runsOnBorder(s.rect, a, b)) borderRuns++
    }
  }
  return { shortJogs, clearance, titleHits, borderRuns }
}

function portSideCode(c: Rect, p: Pt): string {
  if (p[1] === c.y) return "T"
  if (p[1] === c.y + c.h) return "B"
  if (p[0] === c.x) return "L"
  if (p[0] === c.x + c.w) return "R"
  return "N" // N: a chevron notch
}

// ports: spacing per card side and corner distance
function portSpacing(ck: CheckCtx) {
  const { L, edge } = ck
  let portViolations = 0
  const ends = new Map<string, Array<number>>()
  for (const r of L.routes) {
    const e = edgeById(edge, r.edge)
    for (const [p, card] of [
      [r.pts[0], e.from],
      [last(r.pts), e.to],
    ] as Array<[Pt, string]>) {
      const c = findNode(L, card).rect
      const side = portSideCode(c, p)
      const t = side === "T" || side === "B" ? p[0] - c.x : p[1] - c.y
      const len = side === "T" || side === "B" ? c.w : c.h
      if (t < 16 || len - t < 16) portViolations++
      const k = `${card}|${side}`
      ends.set(k, [...(ends.get(k) ?? []), t])
    }
  }
  let tightPorts = 0
  for (const ts of ends.values()) {
    ts.sort((a, b) => a - b)
    for (let i = 1; i < ts.length; i++) {
      if (ts[i] - ts[i - 1] < 20) portViolations++
      if (ts[i] - ts[i - 1] < 40) tightPorts++
    }
  }
  return { portViolations, tightPorts }
}

// whether the last step (dx, dy) points into the card through `side`
function inward(side: string, dx: number, dy: number): boolean {
  if (side === "T") return dy > 0 && !dx
  if (side === "B") return dy < 0 && !dx
  if (side === "L") return dx > 0 && !dy
  return dx < 0 && !dy
}

// stubs: first/last segment perpendicular to its side, ≥ 24px; arrowhead points into the card
function stubChecks(ck: CheckCtx) {
  const { L, edge } = ck
  let stubViolations = 0,
    arrowDirection = 0
  for (const r of L.routes) {
    const e = edgeById(edge, r.edge)
    for (const [id, p, q, isEnd] of [
      [e.from, r.pts[0], r.pts[1], false],
      [e.to, last(r.pts), must(r.pts.at(-2), "route stub"), true],
    ] as Array<[string, Pt, Pt, boolean]>) {
      const c = findNode(L, id).rect
      const side = endSideCode(c, p)
      const perp = side === "T" || side === "B" ? p[0] === q[0] : p[1] === q[1]
      const len = Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1])
      if (!perp || len < 24) stubViolations++
      if (
        isEnd
        && !inward(side, Math.sign(p[0] - q[0]), Math.sign(p[1] - q[1]))
      )
        arrowDirection++
    }
  }
  return { stubViolations, arrowDirection }
}

// two parallel segments ≤ 20px apart that run side by side for ≥ 120px: their bounding box
function stretchOf(A: Seg, B: Seg): Rect | undefined {
  const hA = A.a[1] === A.b[1],
    hB = B.a[1] === B.b[1]
  if (hA !== hB) return undefined
  const d = hA ? Math.abs(A.a[1] - B.a[1]) : Math.abs(A.a[0] - B.a[0])
  if (d <= 20 && overlap(A, B, hA) >= 120)
    return {
      x: Math.min(A.a[0], A.b[0], B.a[0], B.b[0]),
      y: Math.min(A.a[1], A.b[1], B.a[1], B.b[1]),
      w: Math.abs(
        Math.max(A.a[0], A.b[0], B.a[0], B.b[0])
          - Math.min(A.a[0], A.b[0], B.a[0], B.b[0]),
      ),
      h: Math.abs(
        Math.max(A.a[1], A.b[1], B.a[1], B.b[1])
          - Math.min(A.a[1], A.b[1], B.a[1], B.b[1]),
      ),
    }
  return undefined
}

// Crossings between two bundles, how many sit near a door or on a stub, and where they run side
// by side.
function bundlePair(ck: CheckCtx, as: Array<Seg>, bs: Array<Seg>) {
  const xs: Array<Pt> = [],
    stretches: Array<Rect> = []
  const xSeen = new Set<string>()
  let nearCross = 0
  for (const A of as)
    for (const B of bs) {
      const x = crossAt(A, B)
      if (x && !xSeen.has(x.join(","))) {
        xSeen.add(x.join(","))
        xs.push(x)
        if (
          ck.doorNodes.some(
            (d) => Math.abs(d[0] - x[0]) <= 40 && Math.abs(d[1] - x[1]) <= 40,
          )
        )
          nearCross++
        if (ck.cards.some((c) => hitRect([x, x], c.rect, 16))) nearCross++ // on a stub
      }
      const st = stretchOf(A, B)
      if (st) stretches.push(st)
    }
  return { xs, stretches, nearCross }
}

function inSection(L: Layout, x: Pt): boolean {
  return L.sections.some(
    (s) =>
      x[0] > s.rect.x
      && x[0] < s.rect.x + s.rect.w
      && x[1] > s.rect.y
      && x[1] < s.rect.y + s.rect.h,
  )
}

// crossings: near doors/ports, and lane swaps (two lanes that run side by side and also cross)
function swapChecks(ck: CheckCtx) {
  const { L, rs } = ck
  let crossings = 0,
    nearCross = 0,
    swaps = 0,
    swapsInside = 0
  const swapPts: Array<Pt> = []
  L.swapPts = swapPts
  const swapPairs: Array<[string, string]> = []
  L.swapPairs = swapPairs
  const swapGutterPairs: Array<[string, string]> = []
  L.swapGutterPairs = swapGutterPairs
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++) {
      const bp = bundlePair(ck, rs[i][1], rs[j][1])
      crossings += bp.xs.length
      nearCross += bp.nearCross
      const sw = bp.xs.filter((x) =>
        bp.stretches.some((s) => hitRect([x, x], s, 120)),
      )
      const outside = sw.filter((x) => !inSection(L, x))
      if (outside.length > 0) {
        swaps++
        swapPts.push(...outside)
      } else if (sw.length > 0) swapsInside++
      if (sw.length > 0) swapPairs.push([rs[i][0], rs[j][0]])
      if (outside.length > 0) swapGutterPairs.push([rs[i][0], rs[j][0]])
    }
  return { crossings, nearCross, swaps, swapsInside }
}

// arrowheads (14 × 12px at each target border) must not touch other bundles' lines
function arrowChecks(ck: CheckCtx): number {
  let arrowHits = 0
  for (const r of ck.L.routes) {
    const a = must(r.pts.at(-2), "route stub"),
      b = last(r.pts)
    const vx = Math.sign(b[0] - a[0]),
      vy = Math.sign(b[1] - a[1])
    const box: Rect =
      vx ?
        { x: Math.min(b[0], b[0] - vx * 14), y: b[1] - 6, w: 14, h: 12 }
      : { x: b[0] - 6, y: Math.min(b[1], b[1] - vy * 14), w: 12, h: 14 }
    if (
      ck.segs.some(
        (s) => s.bundle !== (r.bundle ?? r.edge) && hitRect([s.a, s.b], box, 2),
      )
    )
      arrowHits++
  }
  return arrowHits
}

function labelChecks(ck: CheckCtx): number {
  const { L, segs, cards, titles } = ck
  let labelHits = 0
  for (const l of L.labels ?? []) {
    if (segs.some((s) => hitRect([s.a, s.b], l.rect, 2))) labelHits++
    if (cards.some((c) => rectsHit(l.rect, c.rect))) labelHits++
    if (titles.some((t) => rectsHit(l.rect, t))) labelHits++
  }
  const labels = L.labels ?? []
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++)
      if (rectsHit(labels[i].rect, labels[j].rect)) labelHits++
  return labelHits
}

// how many sides of section R a route runs along (within 140px, for ≥ 25% of the side)
function sidesRun(R: Rect, pts: Array<Pt>): number {
  let sides = 0
  for (const [horiz, line, lo, hi] of [
    [true, R.y, R.x, R.x + R.w],
    [true, R.y + R.h, R.x, R.x + R.w],
    [false, R.x, R.y, R.y + R.h],
    [false, R.x + R.w, R.y, R.y + R.h],
  ] as Array<[boolean, number, number, number]>) {
    let run = 0
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i],
        b = pts[i + 1]
      if (horiz !== (a[1] === b[1])) continue
      const c = horiz ? a[1] : a[0]
      if (Math.abs(c - line) > 140) continue
      const u = Math.max(
          lo,
          Math.min(horiz ? a[0] : a[1], horiz ? b[0] : b[1]),
        ),
        v = Math.min(hi, Math.max(horiz ? a[0] : a[1], horiz ? b[0] : b[1]))
      run += Math.max(0, v - u)
    }
    if (run >= 0.25 * (hi - lo)) sides++
  }
  return sides
}

// quality scores: detour ratio, wire length, perimeter wrapping, box runs
function qualityChecks(ck: CheckCtx) {
  const { L, edge, byRoute } = ck
  const ratios = L.routes
    .map((r) => {
      const a = r.pts[0],
        b = last(r.pts)
      return (
        pathLen(r.pts)
        / Math.max(40, Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]))
      )
    })
    .sort((a, b) => a - b)
  const wire = [...byRoute.values()].reduce(
    (a, ss) =>
      a
      + ss.reduce(
        (b, sg) =>
          b + Math.abs(sg.b[0] - sg.a[0]) + Math.abs(sg.b[1] - sg.a[1]),
        0,
      ),
    0,
  )
  const secs = L.sections.map((s) => s.rect)
  const bx0 = Math.min(...secs.map((r) => r.x)),
    by0 = Math.min(...secs.map((r) => r.y)),
    bx1 = Math.max(...secs.map((r) => r.x + r.w)),
    by1 = Math.max(...secs.map((r) => r.y + r.h))
  let perimeterWraps = 0,
    boxRuns = 0
  const nodeSec = new Map(L.nodes.map((n) => [n.id, n.section]))
  for (const r of L.routes) {
    if (r.pts.some((p) => p[0] < bx0 || p[0] > bx1 || p[1] < by0 || p[1] > by1))
      perimeterWraps++
    const e = edgeById(edge, r.edge)
    for (const sc of L.sections) {
      if (nodeSec.get(e.from) === sc.id || nodeSec.get(e.to) === sc.id) continue
      if (sidesRun(sc.rect, r.pts) >= 2) boxRuns++
    }
  }
  return { ratios, wire, perimeterWraps, boxRuns }
}

function checkCtx(L: Layout, titles: Array<Rect>): CheckCtx {
  const segs = segsOf(L)
  // per bundle (members share lanes by design), segments deduplicated
  const byRoute = new Map<string, Array<Seg>>()
  const segSeen = new Set<string>()
  for (const s of segs) {
    const k = `${s.bundle}|${s.a.join(",")}|${s.b.join(",")}`
    if (segSeen.has(k)) continue
    segSeen.add(k)
    byRoute.set(s.bundle, [...(byRoute.get(s.bundle) ?? []), s])
  }
  return {
    L,
    titles,
    segs,
    edge: new Map(L.edges.map((e) => [e.id, e])),
    cards: L.nodes.filter((n) => n.obstacle),
    nodeById: new Map(L.nodes.map((n) => [n.id, n])),
    byRoute,
    rs: [...byRoute.entries()],
    doorNodes: L.doorNodes ?? [],
  }
}

export function checks(L: Layout, titles: Array<Rect>): Record<string, number> {
  const ck = checkCtx(L, titles)
  const { minPitch, pitchViolations } = parallelPitch(ck.segs)
  const { shortJogs, clearance, titleHits, borderRuns } = routeRuns(ck)
  const { portViolations, tightPorts } = portSpacing(ck)
  const { stubViolations, arrowDirection } = stubChecks(ck)
  const { crossings, nearCross, swaps, swapsInside } = swapChecks(ck)
  const arrowHits = arrowChecks(ck)
  const labelHits = labelChecks(ck)
  const labels = L.labels ?? []
  const wanted = L.edges.filter((e) => e.label).length
  const { ratios, wire, perimeterWraps, boxRuns } = qualityChecks(ck)
  const shape = shapeChecks(ck)
  const trunks = trunkChecks(ck)
  const mono = monotoneChecks(ck)
  const crossingPairs = new Set<string>()
  for (let i = 0; i < ck.rs.length; i++)
    for (let j = i + 1; j < ck.rs.length; j++) {
      if (ck.rs[i][1].some((A) => ck.rs[j][1].some((B) => crossAt(A, B))))
        crossingPairs.add(`${i}#${j}`)
    }
  return {
    minPitch: minPitch === Infinity ? 0 : minPitch,
    pitchViolations,
    shortJogs,
    portViolations,
    clearance,
    borderRuns,
    titleHits,
    labelHits,
    crossings,
    crossingPairs: crossingPairs.size,
    nearCross,
    arrowHits,
    laneSwaps: swaps,
    perimeterWraps,
    boxRuns,
    detourMax: Math.round((ratios.at(-1) ?? 0) * 100) / 100,
    detourP95:
      Math.round((ratios.at(Math.floor(ratios.length * 0.95)) ?? 0) * 100)
      / 100,
    stubViolations,
    arrowDirection,
    tightPorts,
    thereAndBack: shape.thereAndBack,
    sJogs: shape.sJogs,
    cornerPorts: shape.cornerPorts,
    nestingViolations: trunks.nestingViolations,
    nonMonotone: mono.nonMonotone,
    nonMonotoneGlobal: mono.nonMonotoneGlobal,
    wallOutsideDoor: mono.wallOutsideDoor,
    sectionDetour: mono.sectionDetour,
    unexplainedPorts: mono.unexplainedPorts,
    offCenterAlone: mono.offCenterAlone,
    meanPortDeviation: Math.round(mono.devSum / Math.max(1, mono.devN)),
    centredShare:
      Math.round((mono.centred / Math.max(1, mono.devN)) * 100) / 100,
    straightMissed: shape.straightMissed,
    zExtraBends: shape.zExtraBends,
    sharedSplits: trunks.sharedSplits,
    slantedEntries: shape.slantedEntries,
    bendsMax: shape.bendsMax,
    wireLength: Math.round(wire),
    bendsPerEdge:
      Math.round(
        (L.routes.reduce((a, r) => a + Math.max(0, r.pts.length - 2), 0)
          / Math.max(1, L.routes.length))
          * 100,
      ) / 100,
    laneSwapsInSections: swapsInside,
    labelsPlaced: labels.length,
    labelsDropped: wanted - labels.length,
    labelsTruncated: labels.filter((l) => l.rect.w < labelSize(l.text).w)
      .length,
  }
}
