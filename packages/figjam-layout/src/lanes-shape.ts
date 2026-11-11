// Route-shape self-checks: there-and-back jogs, missed straight links, Z's with extra bends, ports
// off the flat part of a side, shared trunks and nesting on one card side, and monotonicity.
import { shapeOf } from "./lanes-grid"
import {
  crossAt,
  edgeById,
  endSideCode,
  hitRect,
  monotonePts,
  pathLen,
  type Seg,
} from "./lanes-labels"
import {
  last,
  must,
  type Edge,
  type Explanation,
  type Layout,
  type Node,
  type Pt,
  type Rect,
  type Route,
} from "./model"

// What every check reads: the layout, its drawn segments and lookups.
export type CheckCtx = {
  L: Layout
  titles: Array<Rect>
  segs: Array<Seg>
  edge: Map<string, Edge>
  cards: Array<Node>
  nodeById: Map<string, Node>
  byRoute: Map<string, Array<Seg>> // per bundle, segments deduplicated
  rs: Array<[string, Array<Seg>]>
  doorNodes: Array<Pt>
}

function nodeIn(ck: CheckCtx, id: string): Node {
  return must(ck.nodeById.get(id), `node ${id}`)
}

// The flat part of a card's horizontal (H) or vertical (V) sides, outside the corner radius or
// slant + 16px.
function flat(n: Node, side: "H" | "V"): [number, number] {
  const r = n.rect,
    sh = shapeOf(n)
  const rad =
    sh === "ROUNDED_RECTANGLE" || sh === "" ? Math.min(r.w, r.h) / 2 : 0
  if (side === "H") {
    if (sh === "HEXAGON")
      return [r.x + r.w * 0.14 + 16, r.x + r.w - r.w * 0.14 - 16]
    if (sh === "CHEVRON") return [r.x + 20, r.x + r.w - r.w * 0.12 - 16]
    return [r.x + Math.max(20, rad + 16), r.x + r.w - Math.max(20, rad + 16)]
  }
  if (
    sh === "HEXAGON"
    || sh === "CHEVRON"
    || sh === "ELLIPSE"
    || rad >= r.h / 2 - 1
  )
    return [r.y + r.h / 2, r.y + r.h / 2]
  return [r.y + 20, r.y + r.h - 20]
}

// no card (other than the two in `skip`) within 16px of the strip
function clearStrip(
  cards: Array<Node>,
  strip: [Pt, Pt],
  skip: Array<string>,
): boolean {
  return !cards.some((c) => !skip.includes(c.id) && hitRect(strip, c.rect, 16))
}

// S-jog: a short sideways step (≤ 60px) between two runs going the same way
function sJogsOf(pts: Array<Pt>): number {
  let n = 0
  for (let i = 1; i + 2 < pts.length; i++) {
    const a = pts[i - 1],
      b = pts[i],
      c = pts[i + 1],
      d = pts[i + 2]
    const mid = Math.abs(c[0] - b[0]) + Math.abs(c[1] - b[1])
    const sameWay =
      Math.sign(b[0] - a[0]) === Math.sign(d[0] - c[0])
      && Math.sign(b[1] - a[1]) === Math.sign(d[1] - c[1])
    if (mid <= 60 && sameWay) n++
  }
  return n
}

// step out and back: run, short sideways step, run, short step back, run on the first line
function stepsOutAndBack(pts: Array<Pt>): number {
  let n = 0
  for (let i = 0; i + 5 < pts.length; i++) {
    const [a, b, c, d, f, g] = pts.slice(i, i + 6)
    const vert = a[0] === b[0]
    const sameLine =
      vert ? a[0] === f[0] && f[0] === g[0] : a[1] === f[1] && f[1] === g[1]
    const out = Math.abs(c[0] - b[0]) + Math.abs(c[1] - b[1]),
      back = Math.abs(f[0] - d[0]) + Math.abs(f[1] - d[1])
    if (sameLine && out <= 120 && back <= 120) n++
  }
  return n
}

// a short U: two parallel runs on the same line joined by a step of <= 120px
function shortUs(pts: Array<Pt>): number {
  let n = 0
  for (let i = 0; i + 3 < pts.length; i++) {
    const [a, b, c, d] = pts.slice(i, i + 4)
    const v1 = a[0] === b[0],
      v3 = c[0] === d[0]
    const midLen = Math.abs(c[0] - b[0]) + Math.abs(c[1] - b[1])
    if (v1 && v3 && a[0] === c[0] && midLen <= 120) n++
    else if (!v1 && !v3 && a[1] === c[1] && midLen <= 120) n++
  }
  return n
}

// The gap between two cards across the axis they are apart on: [top, bottom] when stacked
// (vert), else [left, right].
function gapOf(ar: Rect, br: Rect, vert: boolean): [number, number] {
  return vert ?
      [Math.min(ar.y + ar.h, br.y + br.h), Math.max(ar.y, br.y)]
    : [Math.min(ar.x + ar.w, br.x + br.w), Math.max(ar.x, br.x)]
}

// a straight line at coordinate c across the gap
function stripAt(c: number, gap: [number, number], vert: boolean): [Pt, Pt] {
  return vert ?
      [
        [c, gap[0]],
        [c, gap[1]],
      ]
    : [
        [gap[0], c],
        [gap[1], c],
      ]
}

// whether some straight line within both cards' flat sides crosses the gap clear of other cards
function straightClear(ck: CheckCtx, AB: [Node, Node], vert: boolean): boolean {
  const [A, B] = AB
  const [p0, p1] = flat(A, vert ? "H" : "V"),
    [q0, q1] = flat(B, vert ? "H" : "V")
  const lo = Math.max(p0, q0),
    hi = Math.min(p1, q1)
  const gap = gapOf(A.rect, B.rect, vert)
  let straightOk = false
  for (let c = Math.ceil(lo / 20) * 20; c <= hi && !straightOk; c += 20)
    straightOk = clearStrip(ck.cards, stripAt(c, gap, vert), [A.id, B.id])
  return straightOk
}

// whether the whole gap between the two cards (their joint span) is clear of other cards
function zClearOf(ck: CheckCtx, AB: [Node, Node], vert: boolean): boolean {
  const [A, B] = AB
  const ar = A.rect,
    br = B.rect
  const [g0, g1] = gapOf(ar, br, vert)
  const strip: [Pt, Pt] =
    vert ?
      [
        [Math.min(ar.x, br.x), g0],
        [Math.max(ar.x + ar.w, br.x + br.w), g1],
      ]
    : [
        [g0, Math.min(ar.y, br.y)],
        [g1, Math.max(ar.y + ar.h, br.y + br.h)],
      ]
  return clearStrip(ck.cards, strip, [A.id, B.id])
}

// Two cards of one family apart along one axis: whether a straight link was possible but the route
// bends (straightMissed), and whether a Z was possible but the route bends more (zExtraBends).
function axisDefects(
  ck: CheckCtx,
  AB: [Node, Node],
  axis: { vert: boolean; bends: number },
): [number, number] {
  const [A, B] = AB
  const { vert, bends } = axis
  const ar = A.rect,
    br = B.rect
  const straightOk = straightClear(ck, AB, vert)
  const cA = vert ? ar.x + ar.w / 2 : ar.y + ar.h / 2,
    cB = vert ? br.x + br.w / 2 : br.y + br.h / 2
  const missed = straightOk && Math.abs(cA - cB) <= 40 && bends > 0 ? 1 : 0
  const zClear = zClearOf(ck, AB, vert)
  return [missed, !straightOk && zClear && bends > 2 ? 1 : 0]
}

// an arrow into a slanted or round end, off its middle
function slantedEntry(B: Node, end: Pt): boolean {
  const sh = shapeOf(B)
  return (
    (sh === "HEXAGON" || sh === "CHEVRON" || sh === "ROUNDED_RECTANGLE")
    && end[1] > B.rect.y
    && end[1] < B.rect.y + B.rect.h
    && Math.abs(end[1] - (B.rect.y + B.rect.h / 2)) > 10
  )
}

// ports must sit on the flat part of a side (outside the corner radius / slant, + 16px)
function cornerPort(n: Node, p: Pt): boolean {
  const R = n.rect
  if (p[1] === R.y || p[1] === R.y + R.h) {
    const [f0, f1] = flat(n, "H")
    return p[0] < f0 - 0.5 || p[0] > f1 + 0.5
  }
  if (p[0] === R.x || p[0] === R.x + R.w) {
    const [f0, f1] = flat(n, "V")
    return p[1] < f0 - 10 || p[1] > f1 + 10
  }
  return false
}

// geometry defects: there-and-back jogs, missed straight links, Z's with extra bends, arrows into a
// slanted end, ports off the flat part of a side
export function shapeChecks(ck: CheckCtx) {
  let sJogs = 0,
    cornerPorts = 0,
    thereAndBack = 0,
    straightMissed = 0,
    zExtraBends = 0,
    slantedEntries = 0,
    bendsMax = 0
  for (const r of ck.L.routes) {
    const bends = Math.max(0, r.pts.length - 2)
    bendsMax = Math.max(bendsMax, bends)
    sJogs += sJogsOf(r.pts)
    thereAndBack += stepsOutAndBack(r.pts) + shortUs(r.pts)
    const e = edgeById(ck.edge, r.edge)
    const A = nodeIn(ck, e.from),
      B = nodeIn(ck, e.to)
    if (A.section && A.section === B.section) {
      const ar = A.rect,
        br = B.rect
      for (const [vert, apart] of [
        [true, br.y >= ar.y + ar.h + 80 || ar.y >= br.y + br.h + 80],
        [false, br.x >= ar.x + ar.w + 80 || ar.x >= br.x + br.w + 80],
      ] as Array<[boolean, boolean]>) {
        if (!apart) continue
        const [missed, z] = axisDefects(ck, [A, B], { vert, bends })
        straightMissed += missed
        zExtraBends += z
      }
    }
    const end = last(r.pts)
    if (slantedEntry(B, end)) slantedEntries++
    if (cornerPort(A, r.pts[0])) cornerPorts++
    if (cornerPort(B, end)) cornerPorts++
  }
  return {
    sJogs,
    cornerPorts,
    thereAndBack,
    straightMissed,
    zExtraBends,
    slantedEntries,
    bendsMax,
  }
}

// ---- shared trunks and nesting on one card side ----
function inSecRect(L: Layout, p: Pt, sid: string): boolean {
  const R = L.sections.find((x) => x.id === sid)?.rect
  return (
    R !== undefined
    && p[0] >= R.x
    && p[0] <= R.x + R.w
    && p[1] >= R.y
    && p[1] <= R.y + R.h
  )
}

// whether two routes share a collinear stretch whose middle lies inside section `sec`
function sharesInside(L: Layout, AB: [Route, Route], sec: string): boolean {
  const [A, B] = AB
  for (let s = 0; s + 1 < A.pts.length; s++)
    for (let t = 0; t + 1 < B.pts.length; t++) {
      const a = A.pts[s],
        b = A.pts[s + 1],
        c = B.pts[t],
        d = B.pts[t + 1]
      const h = a[1] === b[1] && c[1] === d[1] && a[1] === c[1],
        v = a[0] === b[0] && c[0] === d[0] && a[0] === c[0]
      if (!h && !v) continue
      const [p0, p1] =
        h ?
          [Math.min(a[0], b[0]), Math.max(a[0], b[0])]
        : [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
      const [q0, q1] =
        h ?
          [Math.min(c[0], d[0]), Math.max(c[0], d[0])]
        : [Math.min(c[1], d[1]), Math.max(c[1], d[1])]
      const o0 = Math.max(p0, q0),
        o1 = Math.min(p1, q1)
      if (o1 - o0 <= 0) continue
      const mid: Pt = h ? [(o0 + o1) / 2, a[1]] : [a[0], (o0 + o1) / 2]
      if (inSecRect(L, mid, sec)) return true
    }
  return false
}

// whether two routes cross anywhere
function routesCross(A: Route, B: Route): boolean {
  for (let s = 0; s + 1 < A.pts.length; s++)
    for (let t = 0; t + 1 < B.pts.length; t++)
      if (
        crossAt(
          { a: A.pts[s], b: A.pts[s + 1] },
          { a: B.pts[t], b: B.pts[t + 1] },
        )
      )
        return true
  return false
}

// Route ends grouped by card side ("card|T"), with the card's section.
function routeEndsBySide(ck: CheckCtx) {
  const sideEnds = new Map<string, Array<{ r: Route; sec: string }>>()
  for (const r of ck.L.routes) {
    const e = edgeById(ck.edge, r.edge)
    for (const [id, p] of [
      [e.from, r.pts[0]],
      [e.to, last(r.pts)],
    ] as Array<[string, Pt]>) {
      const n = nodeIn(ck, id)
      const k = `${id}|${endSideCode(n.rect, p)}`
      sideEnds.set(k, [...(sideEnds.get(k) ?? []), { r, sec: n.section ?? "" }])
    }
  }
  return sideEnds
}

// shared trunks: two edges on the same card side that share a segment inside that card's family;
// nesting: two links leaving (or entering) the same side must not cross each other at all
export function trunkChecks(ck: CheckCtx) {
  let sharedSplits = 0,
    nestingViolations = 0
  for (const list of routeEndsBySide(ck).values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i].r,
          B = list[j].r
        if (sharesInside(ck.L, [A, B], list[i].sec)) sharedSplits++
        if (routesCross(A, B)) nestingViolations++
      }
  return { sharedSplits, nestingViolations }
}

// ---- monotonicity, detours and centred ports ----
function causeOf(end: unknown): unknown {
  if (typeof end !== "object" || end === null || !("cause" in end))
    return undefined
  return end.cause
}

function inRect(p: Pt, R: Rect | undefined): boolean {
  return (
    R !== undefined
    && p[0] >= R.x
    && p[0] <= R.x + R.w
    && p[1] >= R.y
    && p[1] <= R.y + R.h
  )
}

const dXr = (p: Pt, R: Rect) => Math.max(0, R.x - p[0], p[0] - R.x - R.w),
  dYr = (p: Pt, R: Rect) => Math.max(0, R.y - p[1], p[1] - R.y - R.h)

// a step that moves away from the target inside its family, or back toward the source inside the
// source's family
function nonMonotoneIn(L: Layout, pts: Array<Pt>, AB: [Node, Node]): boolean {
  const [A, B] = AB
  const SS = L.sections.find((x) => x.id === A.section)?.rect,
    TS = L.sections.find((x) => x.id === B.section)?.rect
  let bad = false
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1],
      b = pts[i]
    if (
      inRect(a, TS)
      && inRect(b, TS)
      && (dXr(b, B.rect) > dXr(a, B.rect) || dYr(b, B.rect) > dYr(a, B.rect))
    )
      bad = true
    if (
      SS !== TS
      && inRect(a, SS)
      && inRect(b, SS)
      && (dXr(b, A.rect) < dXr(a, A.rect) || dYr(b, A.rect) < dYr(a, A.rect))
    )
      bad = true
  }
  return bad
}

function sideCounts(ck: CheckCtx): Map<string, number> {
  const sideCount = new Map<string, number>()
  for (const r of ck.L.routes) {
    const e = edgeById(ck.edge, r.edge)
    for (const [id, p] of [
      [e.from, r.pts[0]],
      [e.to, last(r.pts)],
    ] as Array<[string, Pt]>) {
      const n = nodeIn(ck, id)
      const k = `${id}|${endSideCode(n.rect, p)}`
      sideCount.set(k, (sideCount.get(k) ?? 0) + 1)
    }
  }
  return sideCount
}

// a link inside one family more than 1.25x its Manhattan distance
function detoursInSection(pts: Array<Pt>, AB: [Node, Node]): boolean {
  const [A, B] = AB
  if (!A.section || A.section !== B.section) return false
  const s0 = pts[0],
    s1 = last(pts)
  return (
    pathLen(pts)
      / Math.max(40, Math.abs(s0[0] - s1[0]) + Math.abs(s0[1] - s1[1]))
    > 1.25
  )
}

// how far a port sits from the centre of its side, and the side's length
function portDeviation(R: Rect, p: Pt): [number, number] {
  const onTB = p[1] <= R.y || p[1] >= R.y + R.h
  const dev = Math.abs(onTB ? p[0] - (R.x + R.w / 2) : p[1] - (R.y + R.h / 2))
  return [dev, onTB ? R.w : R.h]
}

// monotone inside sections, detour inside sections, centred ports and their causes
function sectionChecks(ck: CheckCtx) {
  const { L } = ck
  let nonMonotone = 0,
    sectionDetour = 0,
    unexplainedPorts = 0,
    offCenterAlone = 0,
    devSum = 0,
    devN = 0,
    centred = 0
  const ex = L.explain ?? {}
  const sideCount = sideCounts(ck)
  for (const r of L.routes) {
    const e = edgeById(ck.edge, r.edge)
    const A = nodeIn(ck, e.from),
      B = nodeIn(ck, e.to)
    if (nonMonotoneIn(L, r.pts, [A, B]) && e.kind !== "loop") nonMonotone++
    if (detoursInSection(r.pts, [A, B])) sectionDetour++
    const why: Explanation | undefined = ex[r.edge]
    for (const [n, p, end] of [
      [A, r.pts[0], "from"],
      [B, last(r.pts), "to"],
    ] as Array<[Node, Pt, "from" | "to"]>) {
      const [dev, len] = portDeviation(n.rect, p)
      devSum += dev
      devN++
      if (dev < 1) centred++
      if (dev >= 1 && !causeOf(why?.[end])) unexplainedPorts++
      if (
        (sideCount.get(`${n.id}|${endSideCode(n.rect, p)}`) ?? 0) === 1
        && dev > 0.25 * len
      )
        offCenterAlone++
    }
  }
  return {
    nonMonotone,
    sectionDetour,
    unexplainedPorts,
    offCenterAlone,
    devSum,
    devN,
    centred,
  }
}

// segment a→b crossing a wall of section R away from any door node
function wallHits(R: Rect, ab: [Pt, Pt], doorSet: Set<string>): number {
  const [a, b] = ab
  let n = 0
  if (a[0] === b[0]) {
    for (const yy of [R.y, R.y + R.h])
      if (
        a[0] > R.x
        && a[0] < R.x + R.w
        && Math.min(a[1], b[1]) < yy
        && Math.max(a[1], b[1]) > yy
        && !doorSet.has(`${a[0]},${yy}`)
      )
        n++
  } else
    for (const xx of [R.x, R.x + R.w])
      if (
        a[1] > R.y
        && a[1] < R.y + R.h
        && Math.min(a[0], b[0]) < xx
        && Math.max(a[0], b[0]) > xx
        && !doorSet.has(`${xx},${a[1]}`)
      )
        n++
  return n
}

// a non-monotone route counts unless policy B lets it through (short, few bends, between families)
function nonMonotoneCounts(L: Layout, r: Route, e: Edge): boolean {
  if (L.policy !== "B") return true
  const len = pathLen(r.pts)
  const man =
    Math.abs(r.pts[0][0] - last(r.pts)[0])
    + Math.abs(r.pts[0][1] - last(r.pts)[1])
  const sameFam =
    L.nodes.find((n) => n.id === e.from)?.section
    === L.nodes.find((n) => n.id === e.to)?.section
  return sameFam || len / Math.max(40, man) > 1.25 || r.pts.length - 2 > 4
}

// global monotonicity (the loop's closing arrow is exempt) and wall crossings only at doors
function globalChecks(ck: CheckCtx) {
  const { L } = ck
  let nonMonotoneGlobal = 0,
    wallOutsideDoor = 0
  const doorSet = new Set((L.doorNodes ?? []).map((d) => `${d[0]},${d[1]}`))
  for (const r of L.routes) {
    const e = edgeById(ck.edge, r.edge)
    if (e.kind !== "loop" && !monotonePts(r.pts) && nonMonotoneCounts(L, r, e))
      nonMonotoneGlobal++
    if (doorSet.size === 0) continue
    for (let i = 1; i < r.pts.length; i++)
      for (const sc of L.sections)
        wallOutsideDoor += wallHits(sc.rect, [r.pts[i - 1], r.pts[i]], doorSet)
  }
  return { nonMonotoneGlobal, wallOutsideDoor }
}

export function monotoneChecks(ck: CheckCtx) {
  return { ...sectionChecks(ck), ...globalChecks(ck) }
}
