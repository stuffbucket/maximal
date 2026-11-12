import type { GlobalPlan } from "./global"

// Ports and link modes for the "lanes" router: where each card can be left or entered, the narrow
// channels and card rings that restrict moves, each link's mode and sides, and the ideal port of
// every link end (with the cause of any deviation from the side centre).
import { sectionOf } from "./engine"
import {
  DX,
  DY,
  P,
  SIDE_DIR,
  facing,
  firstLine,
  isHoriz,
  nodeOf,
  portKey,
  shapeOf,
  type Board,
  type Grid,
  type Mode,
  type Port,
} from "./lanes-grid"
import {
  center,
  must,
  type Edge,
  type Layout,
  type Node,
  type Rect,
  type Side,
} from "./model"

// ---- ports ----
function slantOf(shape: string, r: Rect, radius: number): number {
  if (shape === "HEXAGON") return Math.round(r.w * 0.14) + 16
  if (shape === "CHEVRON") return Math.round(r.w * 0.12) + 16
  if (shape === "ELLIPSE") return r.w / 2
  if (radius) return radius + 16
  return 20
}

// One card's ports, and whether its ends are pointed or round (only straight links use those).
function cardPorts(g: Grid, n: Node): { list: Array<Port>; pointed: boolean } {
  const { x0, y0, at, blocked, border } = g
  const r = n.rect
  const list: Array<Port> = []
  const add = (side: Side, bx: number, by: number) => {
    const d = SIDE_DIR[side]
    const n1 = at(bx + DX[d] * P, by + DY[d] * P),
      n2 = at(bx + DX[d] * 2 * P, by + DY[d] * 2 * P)
    if (!blocked[n1] && !blocked[n2] && !border[n1] && !border[n2])
      list.push({ card: n.id, side, border: [bx, by], n1, n2, dir: d })
  }
  // ports on lattice coordinates, only where the outline is flat and meets its box: FigJam's
  // rounded rectangles are stadiums (corner radius = half the height), so top/bottom ports keep
  // radius + 16px from each end and the round ends only take a port at mid-height; hexagons and
  // chevrons have slanted ends (one point per side; a chevron's left side is a notch, so its
  // port sits inside the box, at the notch)
  const shape = shapeOf(n)
  const radius =
    shape === "ROUNDED_RECTANGLE" || shape === "" ? Math.min(r.h, r.w) / 2 : 0
  const slant = slantOf(shape, r, radius)
  const xa = shape === "CHEVRON" ? r.x + 20 : r.x + slant,
    xb = r.x + r.w - slant
  for (let x = Math.ceil((xa - x0) / P) * P + x0; x <= xb; x += P) {
    add("TOP", x, r.y)
    add("BOTTOM", x, r.y + r.h)
  }
  const rounded = radius >= r.h / 2 - 1
  // pointed/round ends are only for straight (0-bend) links; anything that bends enters a flat side
  const pointed =
    shape === "HEXAGON" || shape === "CHEVRON" || shape === "ELLIPSE" || rounded
  if (pointed) {
    const my = Math.round((r.y + r.h / 2 - y0) / P) * P + y0
    add("RIGHT", r.x + r.w, my)
    add("LEFT", r.x, my)
    const p = list.at(-1)
    if (shape === "CHEVRON" && p?.side === "LEFT")
      p.border = [r.x + Math.round(r.w * 0.12), my]
  } else
    for (
      let y = Math.ceil((r.y + 20 - y0) / P) * P + y0;
      y <= r.y + r.h - 20;
      y += P
    ) {
      add("LEFT", r.x, y)
      add("RIGHT", r.x + r.w, y)
    }
  return { list, pointed }
}

export function buildPorts(
  L: Layout,
  g: Grid,
): { ports: Map<string, Array<Port>>; allPorts: Map<string, Array<Port>> } {
  const ports = new Map<string, Array<Port>>()
  const allPorts = new Map<string, Array<Port>>()
  for (const n of L.nodes) {
    if (!n.obstacle) continue
    const { list, pointed } = cardPorts(g, n)
    allPorts.set(n.id, list)
    ports.set(n.id, pointed ? list.filter((p) => isHoriz(p.side)) : list)
  }
  return { ports, allPorts }
}

// ---- channel structure ----
// nodes where bundles may NOT share a lane: inside sections
export function markNoShare(L: Layout, g: Grid): void {
  const { x0, y0, at, noShare } = g
  for (const sc of L.sections) {
    const R = sc.rect
    for (let y = Math.ceil((R.y - y0) / P) * P + y0; y <= R.y + R.h; y += P)
      for (let x = Math.ceil((R.x - x0) / P) * P + x0; x <= R.x + R.w; x += P)
        noShare[at(x, y)] = 1
  }
}

// no crossings within 40px of a door node
function markNearDoors(g: Grid): void {
  const { nx, ny, id, doorOwner, near } = g
  for (let k = 0; k < g.N; k++) {
    if (doorOwner[k] < 0) continue
    const i = k % nx,
      j = Math.floor(k / nx)
    for (let dj = -2; dj <= 2; dj++)
      for (let di = -2; di <= 2; di++) {
        const ii = i + di,
          jj = j + dj
        if (ii >= 0 && ii < nx && jj >= 0 && jj < ny) near[id(ii, jj)] = 1
      }
  }
}

// narrow channels: nodes within 60px of two cards (the 80px gaps between columns)
function countCardsNear(L: Layout, g: Grid): Uint8Array {
  const { x0, y0, at } = g
  const cardsNear = new Uint8Array(g.N)
  for (const n of L.nodes) {
    if (!n.obstacle) continue
    const r = n.rect
    for (
      let y = Math.ceil((r.y - 60 - y0) / P) * P + y0;
      y <= r.y + r.h + 60;
      y += P
    )
      for (
        let x = Math.ceil((r.x - 60 - x0) / P) * P + x0;
        x <= r.x + r.w + 60;
        x += P
      )
        cardsNear[at(x, y)]++
  }
  return cardsNear
}

// The lattice box around a card grown by `pad`: [ax, bx, ay, by].
function ringBox(
  g: Grid,
  r: Rect,
  pad: number,
): [number, number, number, number] {
  const { x0, y0 } = g
  return [
    Math.ceil((r.x - pad - x0) / P) * P + x0,
    Math.floor((r.x + r.w + pad - x0) / P) * P + x0,
    Math.ceil((r.y - pad - y0) / P) * P + y0,
    Math.floor((r.y + r.h + pad - y0) / P) * P + y0,
  ]
}

// the 20px ring around a card is for port stubs (no running along a card's border, no boxing a
// card in), except in narrow channels, where those lines are the lanes
function markRing(g: Grid, r: Rect, cardsNear: Uint8Array): void {
  const { at, blocked, perpOnly } = g
  const [ax, bx, ay, by] = ringBox(g, r, 20)
  for (let x = ax + P; x < bx; x += P)
    for (const y of [ay, by]) {
      const k = at(x, y)
      if (!blocked[k] && cardsNear[k] < 2)
        perpOnly[k] = perpOnly[k] === 2 ? 3 : 1
    }
  for (let y = ay + P; y < by; y += P)
    for (const x of [ax, bx]) {
      const k = at(x, y)
      if (!blocked[k] && cardsNear[k] < 2)
        perpOnly[k] = perpOnly[k] === 1 ? 3 : 2
    }
  for (const x of [ax, bx]) for (const y of [ay, by]) blocked[at(x, y)] = 1
}

// the 40px band around a card: perpendicular moves only, outside narrow channels
function markBand(g: Grid, r: Rect, cardsNear: Uint8Array): void {
  const { at, blocked, perpOnly } = g
  const [ax, bx, ay, by] = ringBox(g, r, 40)
  for (let x = ax + 2 * P; x <= bx - 2 * P; x += P)
    for (const y of [ay, by]) {
      const k = at(x, y)
      if (!blocked[k] && !perpOnly[k] && cardsNear[k] < 2) perpOnly[k] = 1
    }
  for (let y = ay + 2 * P; y <= by - 2 * P; y += P)
    for (const x of [ax, bx]) {
      const k = at(x, y)
      if (!blocked[k] && !perpOnly[k] && cardsNear[k] < 2) perpOnly[k] = 2
    }
}

export function markChannels(L: Layout, g: Grid): void {
  markNearDoors(g)
  const cardsNear = countCardsNear(L, g)
  for (const n of L.nodes) if (n.obstacle) markRing(g, n.rect, cardsNear)
  for (let k = 0; k < g.N; k++) if (g.perpOnly[k] === 3) g.blocked[k] = 1
  for (const n of L.nodes) if (n.obstacle) markBand(g, n.rect, cardsNear)
}

// ---- sides, modes and ideal ports ----
// Inside a family, cards sit in rows. Each intra link gets a mode:
//   row     — same row, neighbours: one straight horizontal between the facing ends
//   channel — adjacent rows: bottom → one track in the gap between the rows → top
//   mono    — anything else that can be routed monotonically (never moving away from its target)
//   tag     — same row with a card in between (any route would go away and back): a name tag
// Cross-family links use the side their global path leaves/enters by.
// Ports: one link on a side sits at its centre; k links sit symmetric around the centre at an even
// pitch, ordered by the other end's position. Every deviation from that records its cause.
export type Modes = {
  mode: Map<string, Mode>
  sideMap: Map<string, [Side, Side]>
  rowsOf: Map<string, Array<number>> // section → sorted row ys
}

function rowsOfSections(L: Layout): Map<string, Array<number>> {
  const rowsOf = new Map<string, Array<number>>()
  for (const sc of L.sections)
    rowsOf.set(
      sc.id,
      [
        ...new Set(
          L.nodes
            .filter(
              (n) =>
                n.section === sc.id && n.obstacle && shapeOf(n) !== "ELLIPSE",
            )
            .map((n) => n.rect.y),
        ),
      ].sort((u, v) => u - v),
    )
  return rowsOf
}

export function rowIdx(rowsOf: Map<string, Array<number>>, n: Node): number {
  if (n.section === undefined) return -1
  return rowsOf.get(n.section)?.indexOf(n.rect.y) ?? -1
}

// The mode and sides of a link between two cards of one family.
function intraMode(
  b: Board,
  rowsOf: Map<string, Array<number>>,
  e: Edge,
): [Mode, [Side, Side]] {
  const A = nodeOf(b, e.from),
    B = nodeOf(b, e.to)
  const ra = rowIdx(rowsOf, A),
    rb = rowIdx(rowsOf, B)
  if (ra !== rb)
    return [
      Math.abs(ra - rb) === 1 ? "channel" : "mono",
      rb > ra ? ["BOTTOM", "TOP"] : ["TOP", "BOTTOM"],
    ]
  const [lo, hi] =
    A.rect.x < B.rect.x ?
      [A.rect.x + A.rect.w, B.rect.x]
    : [B.rect.x + B.rect.w, A.rect.x]
  const between = b.L.nodes.some(
    (n) =>
      n.obstacle
      && n.section === A.section
      && n.rect.y === A.rect.y
      && n.rect.x >= lo
      && n.rect.x + n.rect.w <= hi,
  )
  if (between && e.kind === "loop") return ["loopback", ["BOTTOM", "BOTTOM"]]
  return [
    between ? "tag" : "row",
    A.rect.x < B.rect.x ? ["RIGHT", "LEFT"] : ["LEFT", "RIGHT"],
  ]
}

export function assignModes(b: Board): Modes {
  const { L, opts } = b
  const mode = new Map<string, Mode>()
  const sideMap = new Map<string, [Side, Side]>()
  const rowsOf = rowsOfSections(L)
  for (const e of L.edges) {
    const A = nodeOf(b, e.from),
      B = nodeOf(b, e.to)
    const [sa, sb] = sectionOf(L, e)
    if (sa && sa === sb) {
      const [md, sides] = intraMode(b, rowsOf, e)
      mode.set(e.id, md)
      sideMap.set(e.id, sides)
    } else {
      mode.set(e.id, "astar")
      const sd = opts.plan?.sides.get(e.id)
      sideMap.set(e.id, sd ?? [facing(A.rect, B.rect), facing(B.rect, A.rect)])
    }
  }
  return { mode, sideMap, rowsOf }
}

type End = { e: Edge; end: 0 | 1; card: string; other: string }
type Ideal = {
  b: Board
  allPorts: Map<string, Array<Port>>
  idealAt: Map<string, number> // "edge|end" → coordinate along the side
  portCause: Map<string, string>
}

// Link ends grouped by card side ("card|side").
function endGroups(
  b: Board,
  sideMap: Map<string, [Side, Side]>,
  routable: (e: Edge) => boolean,
): Map<string, Array<End>> {
  const groups = new Map<string, Array<End>>()
  for (const e of b.L.edges) {
    if (!routable(e)) continue
    const sd = must(sideMap.get(e.id), "sides")
    for (const [end, card, other, side] of [
      [0, e.from, e.to, sd[0]],
      [1, e.to, e.from, sd[1]],
    ] as Array<[0 | 1, string, string, Side]>) {
      const k = `${card}|${side}`
      groups.set(k, [...(groups.get(k) ?? []), { e, end, card, other }])
    }
  }
  return groups
}

// Even pitch for k links on a side of length sideLen, shrunk until they fit the flat span.
function pitchFor(kk: number, sideLen: number, span: number): number {
  let pitch =
    kk > 1 ?
      Math.min(
        160,
        Math.max(40, Math.floor((0.6 * sideLen) / (kk - 1) / P) * P),
      )
    : 0
  while (kk > 1 && (kk - 1) * pitch > span && pitch > 20) pitch -= 20
  return pitch
}

function slotCause(
  b: Board,
  it: End,
  slot: { i: number; ai: number; kk: number; side: Side },
): string {
  const { i, ai, kk, side } = slot
  if (ai === i)
    return `aligned with ${firstLine(nodeOf(b, it.other).text)} for a straight drop`
  if (ai >= 0) return `slot ${i + 1} of ${kk} around a straight drop on ${side}`
  if (kk > 1)
    return `slot ${i + 1} of ${kk} on ${side} (ordered by the other end's position)`
  return ""
}

// Ideal coordinates of the link ends on one card side: centred, or symmetric around the centre (or
// around a straight drop) at an even pitch, ordered by the other end's position.
function idealSlots(ix: Ideal, k: string, items: Array<End>): void {
  const { b, allPorts, idealAt, portCause } = ix
  const [card, side] = k.split("|") as [string, Side]
  const horiz = isHoriz(side)
  const ps = (allPorts.get(card) ?? []).filter((p) => p.side === side)
  if (ps.length === 0) return
  const r = nodeOf(b, card).rect
  const c0 = horiz ? r.x + r.w / 2 : r.y + r.h / 2
  const lat = (it: End) => {
    const o = center(nodeOf(b, it.other).rect)
    return horiz ? o[0] : o[1]
  }
  items.sort((u, v) => lat(u) - lat(v) || u.e.id.localeCompare(v.e.id))
  const coords = ps.map((p) => (horiz ? p.border[0] : p.border[1]))
  const lo = Math.min(...coords),
    hi = Math.max(...coords)
  const kk = items.length
  const pitch = pitchFor(kk, horiz ? r.w : r.h, hi - lo)
  // a link to a card whose centre lines up (within 40px) with ours is a straight drop: it takes
  // the shared x between the two centres; the other links sit symmetric around it
  const ai =
    horiz ?
      items.findIndex((it) => {
        const o = nodeOf(b, it.other)
        return (
          o.section === nodeOf(b, card).section
          && Math.abs(center(o.rect)[0] - c0) <= 40
          && (o.rect.y >= r.y + r.h + 80 || r.y >= o.rect.y + o.rect.h + 80)
        )
      })
    : -1
  const xAl =
    ai >= 0 ?
      Math.round((c0 + center(nodeOf(b, items[ai].other).rect)[0]) / 2 / P) * P
    : 0
  for (const [i, it] of items.entries()) {
    let want =
      ai >= 0 ?
        xAl + (i - ai) * pitch
      : Math.round((c0 + (i - (kk - 1) / 2) * pitch) / P) * P
    let cause = slotCause(b, it, { i, ai, kk, side })
    if (want < lo || want > hi) {
      want = Math.min(Math.max(want, lo), hi)
      cause = `clamped to the flat part of the ${side.toLowerCase()} side`
    }
    idealAt.set(`${it.e.id}|${it.end}`, want)
    if (cause) portCause.set(`${it.e.id}|${it.end}`, cause)
  }
}

// straight drops: a channel link whose two ideal ports are within 2 grid steps gets one shared x
function straightDrops(
  ix: Ideal,
  mode: Map<string, Mode>,
  routable: (e: Edge) => boolean,
): void {
  const { b, allPorts, idealAt, portCause } = ix
  for (const e of b.L.edges) {
    if (mode.get(e.id) !== "channel" || !routable(e)) continue
    const a = idealAt.get(`${e.id}|0`),
      c = idealAt.get(`${e.id}|1`)
    if (a === undefined || c === undefined || Math.abs(a - c) > 40 || a === c)
      continue
    const x = Math.round((a + c) / 2 / P) * P
    const okA = (allPorts.get(e.from) ?? []).some((p) => p.border[0] === x),
      okB = (allPorts.get(e.to) ?? []).some((p) => p.border[0] === x)
    if (!okA || !okB) continue
    idealAt.set(`${e.id}|0`, x)
    idealAt.set(`${e.id}|1`, x)
    portCause.set(
      `${e.id}|0`,
      `aligned with ${firstLine(nodeOf(b, e.to).text)} for a straight drop`,
    )
    portCause.set(
      `${e.id}|1`,
      `aligned with ${firstLine(nodeOf(b, e.from).text)} for a straight drop`,
    )
  }
}

// The preferred port of every link end ("edge|end" → port key) and the cause of every deviation.
export function idealPorts(
  ix: { b: Board; allPorts: Map<string, Array<Port>>; md: Modes },
  routable: (e: Edge) => boolean,
): { prefPort: Map<string, string>; portCause: Map<string, string> } {
  const { b, allPorts, md } = ix
  const prefPort = new Map<string, string>()
  const portCause = new Map<string, string>()
  const ideal: Ideal = { b, allPorts, idealAt: new Map(), portCause }
  for (const [k, items] of endGroups(b, md.sideMap, routable))
    idealSlots(ideal, k, items)
  straightDrops(ideal, md.mode, routable)
  for (const [key, at2] of ideal.idealAt) {
    const [eid, end] = key.split("|")
    const e = must(
      b.L.edges.find((x) => x.id === eid),
      `edge ${eid}`,
    )
    const card = end === "0" ? e.from : e.to
    const side = must(md.sideMap.get(eid), "sides")[Number(end)]
    const horiz = isHoriz(side)
    const p = (allPorts.get(card) ?? [])
      .filter((q) => q.side === side)
      .sort(
        (u, v) =>
          Math.abs((horiz ? u.border[0] : u.border[1]) - at2)
          - Math.abs((horiz ? v.border[0] : v.border[1]) - at2),
      )
      .at(0)
    if (p) prefPort.set(key, portKey(p))
  }
  return { prefPort, portCause }
}

// corridors: the global path's gcells plus one ring; leaving them costs extra
export function buildCorridors(
  gp: GlobalPlan | undefined,
): Map<string, Uint8Array> {
  const corridor = new Map<string, Uint8Array>()
  if (!gp) return corridor
  for (const [eid, path] of gp.paths) {
    const a = new Uint8Array(gp.gnx * gp.gny)
    for (const c of path) markCell(gp, a, c)
    corridor.set(eid, a)
  }
  return corridor
}

function markCell(gp: GlobalPlan, a: Uint8Array, c: number): void {
  const i = c % gp.gnx,
    j = Math.floor(c / gp.gnx)
  for (let dj = -1; dj <= 1; dj++)
    for (let di = -1; di <= 1; di++) {
      const ii = i + di,
        jj = j + dj
      if (ii >= 0 && jj >= 0 && ii < gp.gnx && jj < gp.gny)
        a[jj * gp.gnx + ii] = 1
    }
}
