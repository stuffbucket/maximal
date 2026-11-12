// Layered routing inside families, before any search: same-row neighbours get one straight line,
// loop returns one U below their row, and links between adjacent rows one track each in the gap
// between the rows, ordered so links in the gap don't cross. Ports and lane are chosen together.
import { P, nodeOf, type Ctx, type Port } from "./lanes-grid"
import { rowIdx } from "./lanes-ports"
import { occupy, portFree, ue } from "./lanes-search"
import { must, type Edge, type Pt } from "./model"

type DirectLink = {
  e: Edge
  pa: Port
  pb: Port
  pts: Array<Pt>
  why: Array<string>
}

// One gap link: its ports, their x on the lattice, and whether it runs down.
type CE = {
  e: Edge
  pa: Port
  pb: Port
  xa: number
  xb: number
  down: boolean
}

function stepsBetween(c: Ctx, a: Pt, b: Pt): Array<number> {
  const out: Array<number> = []
  const dx = Math.sign(b[0] - a[0]) * P,
    dy = Math.sign(b[1] - a[1]) * P
  let x = a[0],
    y = a[1]
  out.push(c.at(x, y))
  while (x !== b[0] || y !== b[1]) {
    x += dx
    y += dy
    out.push(c.at(x, y))
  }
  return out
}

function dirOf(nx: number, k: number, q: number): number {
  if (q - k === 1) return 0
  if (q - k === -1) return 1
  if (q - k === nx) return 2
  return 3
}

// Whether the step from k to q is free of walls, doors, bands and other lanes.
function stepFree(c: Ctx, kq: [number, number], last: boolean): boolean {
  const [k, q] = kq
  const { blocked, stub, perpOnly, doorOwner, border, edgeG } = c
  const nd = dirOf(c.nx, k, q)
  if (blocked[q] || (stub[q] && !last)) return false
  if ((perpOnly[q] === 1 || perpOnly[k] === 1) && nd < 2) return false
  if ((perpOnly[q] === 2 || perpOnly[k] === 2) && nd >= 2) return false
  if (doorOwner[q] >= 0 || border[q]) return false
  return edgeG[ue(c.nx, k, q)] < 0
}

// Whether a step onto q, an occupied node, is a clean perpendicular crossing of a bundle that
// shares no card with us.
function crossFree(
  c: Ctx,
  st: { k: number; q: number; turnAtQ: boolean },
  cardsOf: Array<string>,
): boolean {
  const { k, q, turnAtQ } = st
  const { near, nodeXG, nodeM, nodeG } = c
  const horiz = dirOf(c.nx, k, q) < 2
  if (
    turnAtQ
    || near[q]
    || nodeXG[q] >= 0
    || nodeM[q] === 3
    || (horiz && nodeM[q] !== 2)
    || (!horiz && nodeM[q] !== 1)
  )
    return false
  const gc = c.groupCards.get(nodeG[q])
  return !gc || !cardsOf.some((x) => gc.has(x))
}

function pathOk(c: Ctx, ns: Array<number>, cardsOf: Array<string>): boolean {
  for (let i = 1; i < ns.length; i++) {
    const k = ns[i - 1],
      q = ns[i]
    if (!stepFree(c, [k, q], i >= ns.length - 1)) return false
    const turnAtQ = i + 1 < ns.length && ns[i + 1] - q !== q - k
    if (c.nodeG[q] >= 0 && !crossFree(c, { k, q, turnAtQ }, cardsOf))
      return false
  }
  return true
}

function commitPath(c: Ctx, d: DirectLink): boolean {
  const { e, pa, pb, pts, why } = d
  if (!portFree(c, pa) || !portFree(c, pb)) return false
  const ns: Array<number> = []
  for (let i = 1; i < pts.length; i++) {
    const seg = stepsBetween(c, pts[i - 1], pts[i])
    ns.push(...(i === 1 ? seg : seg.slice(1)))
  }
  if (!pathOk(c, ns, [e.from, e.to])) return false
  const p = {
    edge: e,
    g: must(c.gOf.get(e.id), "group"),
    nodes: ns,
    from: pa,
    to: pb,
    cost: 0,
  }
  c.placed.set(e.id, p)
  occupy(c, p, true)
  c.direct.add(e.id)
  if (why.length > 0) c.bendCause.set(e.id, why)
  return true
}

function prefPorts(c: Ctx, e: Edge): [Port | undefined, Port | undefined] {
  return [
    c.portByKey.get(c.prefPort.get(`${e.id}|0`) ?? ""),
    c.portByKey.get(c.prefPort.get(`${e.id}|1`) ?? ""),
  ]
}

// 1. same-row neighbours: one straight horizontal between the side centres
function rowLinks(c: Ctx): void {
  const { X, Y } = c
  for (const e of c.intra) {
    if (c.mode.get(e.id) !== "row") continue
    const [pa, pb] = prefPorts(c, e)
    if (pa && pb && Y(pa.n1) === Y(pb.n1))
      commitPath(c, {
        e,
        pa,
        pb,
        pts: [
          [X(pa.n1), Y(pa.n1)],
          [X(pb.n1), Y(pb.n1)],
        ],
        why: [],
      })
  }
}

// 1b. loop returns (the step sequence closes on itself): one U through the gap below the row
function loopbacks(c: Ctx): void {
  const { X, Y } = c
  for (const e of c.intra) {
    if (c.mode.get(e.id) !== "loopback") continue
    const [pa, pb] = prefPorts(c, e)
    if (!pa || !pb) continue
    for (const y of [Y(pa.n1) + 40, Y(pa.n1) + 60, Y(pa.n1) + 80])
      if (
        commitPath(c, {
          e,
          pa,
          pb,
          pts: [
            [X(pa.n1), Y(pa.n1)],
            [X(pa.n1), y],
            [X(pb.n1), y],
            [X(pb.n1), Y(pb.n1)],
          ],
          why: ["loop return: closes the step sequence below its row"],
        })
      )
        break
  }
}

// crossings between two links in the gap if a sits above b (upper = nearer the top row)
const topX = (c: CE) => (c.down ? c.xa : c.xb)
const botX = (c: CE) => (c.down ? c.xb : c.xa)
const span = (c: CE) => [Math.min(c.xa, c.xb), Math.max(c.xa, c.xb)]
function crossIfAbove(a: CE, b: CE): number {
  const [b0, b1] = span(b),
    [a0, a1] = span(a)
  return (
    (botX(a) > b0 && botX(a) < b1 ? 1 : 0)
    + (topX(b) > a0 && topX(b) < a1 ? 1 : 0)
  )
}

// order: insertion by fewest crossings against those already placed above
function orderGap(bent: Array<CE>): Array<CE> {
  const ordered: Array<CE> = []
  for (const c of [...bent].sort(
    (a, b) => span(a)[1] - span(a)[0] - (span(b)[1] - span(b)[0]),
  )) {
    let bestI = 0,
      bestX = Infinity
    for (let i = 0; i <= ordered.length; i++) {
      let x = 0
      for (let j = 0; j < ordered.length; j++)
        x += j < i ? crossIfAbove(ordered[j], c) : crossIfAbove(c, ordered[j])
      if (x < bestX) {
        bestX = x
        bestI = i
      }
    }
    ordered.splice(bestI, 0, c)
  }
  return ordered
}

// left-edge packing that keeps that order for overlapping spans
function packTracks(ordered: Array<CE>): Map<CE, number> {
  const track = new Map<CE, number>()
  for (const c of ordered) {
    let t = 0
    for (const o of ordered) {
      if (o === c) break
      const [a0, a1] = span(o),
        [c0, c1] = span(c)
      if (a0 <= c1 + 20 && c0 <= a1 + 20)
        t = Math.max(t, must(track.get(o), "track") + 1)
    }
    track.set(c, t)
  }
  return track
}

// A Z through the gap at height y.
function gapPath(c: Ctx, ce: CE, y: number): Array<Pt> {
  return [
    [ce.xa, c.Y(ce.pa.n1)],
    [ce.xa, y],
    [ce.xb, y],
    [ce.xb, c.Y(ce.pb.n1)],
  ]
}

// The gap's links that have both preferred ports.
function gapLinks(c: Ctx, es: Array<Edge>): Array<CE> {
  const ces: Array<CE> = []
  for (const e of es) {
    const [pa, pb] = prefPorts(c, e)
    if (!pa || !pb) continue
    ces.push({
      e,
      pa,
      pb,
      xa: c.X(pa.n1),
      xb: c.X(pb.n1),
      down: c.Y(pb.n1) > c.Y(pa.n1),
    })
  }
  return ces
}

// 2. adjacent rows: per gap, one horizontal track each, ordered so links in the gap don't cross
function routeGap(c: Ctx, k: string, es: Array<Edge>): void {
  const [sid, ri] = k.split("|")
  const rows = must(c.rowsOf.get(sid), "rows")
  const upper = c.L.nodes.filter(
    (n) => n.section === sid && n.rect.y === rows[Number(ri)],
  )
  const top = Math.max(...upper.map((n) => n.rect.y + n.rect.h)),
    bot = rows[Number(ri) + 1]
  const ces = gapLinks(c, es)
  // straight drops first
  for (const ce of ces.filter((x) => x.xa === x.xb))
    commitPath(c, {
      e: ce.e,
      pa: ce.pa,
      pb: ce.pb,
      pts: [
        [ce.xa, c.Y(ce.pa.n1)],
        [ce.xb, c.Y(ce.pb.n1)],
      ],
      why: [],
    })
  const bent = ces.filter((x) => x.xa !== x.xb && !c.direct.has(x.e.id))
  const ordered = orderGap(bent)
  const track = packTracks(ordered)
  const T = Math.max(0, ...track.values()) + 1
  const mid = Math.round((top + bot) / 2 / P) * P
  for (const ce of ordered) {
    const tk = must(track.get(ce), "track")
    const y = mid + Math.round(tk - (T - 1) / 2) * P
    const why = [
      `track ${tk + 1} of ${T} in the gap between rows ${Number(ri) + 1} and ${Number(ri) + 2}`,
    ]
    const link = { e: ce.e, pa: ce.pa, pb: ce.pb }
    if (commitPath(c, { ...link, pts: gapPath(c, ce, y), why })) continue
    // the planned track is taken: try the others in the gap, nearest the middle first
    for (const off of [20, -20, 40, -40, 60, -60, 80, -80])
      if (
        commitPath(c, {
          ...link,
          pts: gapPath(c, ce, y + off),
          why: [`${why[0]} (shifted ${off}px: planned track taken)`],
        })
      )
        break
  }
}

export function layeredStage(c: Ctx): void {
  rowLinks(c)
  loopbacks(c)
  const gaps = new Map<string, Array<Edge>>()
  for (const e of c.intra) {
    if (c.mode.get(e.id) !== "channel") continue
    const A = nodeOf(c, e.from),
      B = nodeOf(c, e.to)
    const k = `${A.section}|${Math.min(rowIdx(c.rowsOf, A), rowIdx(c.rowsOf, B))}`
    gaps.set(k, [...(gaps.get(k) ?? []), e])
  }
  for (const [k, es] of gaps) routeGap(c, k, es)
}
