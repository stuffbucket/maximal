// The "lanes" router's lattice: a 20px grid over the board, its blocked/border/door masks, the
// priority queue the search runs on, and the shared types every stage of the router passes around.
import type { GlobalPlan } from "./global"

import {
  must,
  type Edge,
  type Layout,
  type Node,
  type Pt,
  type Rect,
  type Section,
  type ShapeStyle,
  type Side,
} from "./model"

export const P = 20 // lattice pitch = lane pitch
export const DX = [1, -1, 0, 0]
export const DY = [0, 0, 1, -1]
export const SIDE_DIR: Record<Side, number> = {
  RIGHT: 0,
  LEFT: 1,
  BOTTOM: 2,
  TOP: 3,
}
export const OPP: Record<Side, Side> = {
  TOP: "BOTTOM",
  BOTTOM: "TOP",
  LEFT: "RIGHT",
  RIGHT: "LEFT",
}

export type LaneOpts = {
  name?: string
  bend?: number
  cross?: number
  passes?: number
  titleW?: (name: string) => number
  nearCard?: number
  doorExtra?: number
  attempts?: number
  share?: number
  unswap?: number
  plan?: GlobalPlan
  tags?: Set<string>
  corridor?: number
  strictSlots?: boolean
  slotPenalty?: number
  policy?: "A" | "B"
}

export type Port = {
  card: string
  side: Side
  border: Pt
  n1: number
  n2: number
  dir: number
}

export type Window = {
  s: string
  side: Side
  lo: number
  hi: number
  pair: number
  aligned?: boolean
  bundles?: Array<string>
}

export type Mode = "row" | "channel" | "mono" | "astar" | "tag" | "loopback"

export type Placed = {
  edge: Edge
  g: number
  nodes: Array<number>
  from: Port
  to: Port
  cost: number
}

// The board being routed and the lookups every stage needs.
export type Board = {
  L: Layout
  opts: LaneOpts
  m: Map<string, Node>
  sec: Map<string, Section>
}

// Edges split by whether they cross between families, and the family pairs they connect.
export type Pairs = {
  inter: Array<Edge>
  intra: Array<Edge>
  pairs: Map<string, Array<Edge>>
  pairIdx: Map<string, number>
  pairKeys: Array<string>
}

// The lattice and its static masks (set while the board is prepared, read by the search).
export type Grid = {
  x0: number
  y0: number
  nx: number
  ny: number
  N: number
  id: (i: number, j: number) => number
  X: (k: number) => number
  Y: (k: number) => number
  at: (x: number, y: number) => number
  blocked: Uint8Array
  border: Uint8Array // 1 = on a section border (wall unless a door)
  doorOwner: Int32Array
  doorSlot: Int32Array
  perpOnly: Uint8Array // 1 = vertical moves only, 2 = horizontal moves only
  noShare: Uint8Array // nodes where bundles may NOT share a lane: inside sections, on walls, in door/ring bands
  near: Uint8Array // 1 = no crossings here: within 40px of a door node
}

// Which bundle uses each node and unit edge (reference-counted; a node holds its group plus at most
// one crossing group), and which ports and stubs are taken.
export type Usage = {
  nodeG: Int32Array
  nodeC: Int32Array
  nodeM: Uint8Array // mode 1 H, 2 V, 3 turn/merge
  nodeXG: Int32Array
  nodeXC: Int32Array
  nodeXM: Uint8Array
  edgeG: Int32Array // [k*2] = k→k+1, [k*2+1] = k→k+nx
  edgeC: Int32Array
  stub: Uint8Array // port stub nodes in use: exclusive
  usedPort: Set<string>
  placed: Map<string, Placed>
  groupCards: Map<number, Map<string, number>>
}

// Everything the search, the layered stage and the drawing read: board, lattice, bundles, ports,
// modes and the live usage.
export type Ctx = Board
  & Pairs
  & Grid
  & Usage & {
    BEND: number
    CROSS: number
    SHARE: number
    CORR: number
    titles: Array<Rect>
    windows: Array<Window>
    groupIds: Map<string, number>
    gOf: Map<string, number>
    edgeIdx: Map<string, number>
    ports: Map<string, Array<Port>>
    allPorts: Map<string, Array<Port>>
    portByKey: Map<string, Port>
    mode: Map<string, Mode>
    sideMap: Map<string, [Side, Side]>
    rowsOf: Map<string, Array<number>>
    newTags: Set<string>
    prefPort: Map<string, string>
    portCause: Map<string, string> // "edge|end" → why the port is not at the side centre
    bendCause: Map<string, Array<string>>
    corridor: Map<string, Uint8Array>
    direct: Set<string>
    avoidG: Set<number> // bundles the current route may not cross (used to undo lane swaps)
  }

export class Heap {
  k: Array<number> = []
  v: Array<number> = []
  push(key: number, val: number) {
    const k = this.k,
      v = this.v
    let i = k.length
    k.push(key)
    v.push(val)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (k[p] <= key) break
      k[i] = k[p]
      v[i] = v[p]
      i = p
    }
    k[i] = key
    v[i] = val
  }
  pop(): number {
    const k = this.k,
      v = this.v
    const top = v[0]
    const lk = must(k.pop(), "heap key"),
      lv = must(v.pop(), "heap value")
    if (k.length > 0) {
      let i = 0
      const n = k.length
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && k[c + 1] < k[c]) c++
        if (k[c] >= lk) break
        k[i] = k[c]
        v[i] = v[c]
        i = c
      }
      k[i] = lk
      v[i] = lv
    }
    return top
  }
  get size() {
    return this.k.length
  }
}

export function titleRect(
  s: { name: string; rect: Rect },
  w?: (n: string) => number,
): Rect {
  // FigJam draws the section name as a pill at the top-left, inside the section
  return {
    x: s.rect.x,
    y: s.rect.y,
    w: Math.min(s.rect.w, w ? w(s.name) : 48 + s.name.length * 15),
    h: 64,
  }
}

// The lattice covering every rect plus a 240px margin, with all masks empty.
export function makeGrid(all: Array<Rect>): Grid {
  const x0 = Math.floor((Math.min(...all.map((r) => r.x)) - 240) / P) * P
  const y0 = Math.floor((Math.min(...all.map((r) => r.y)) - 240) / P) * P
  const nx =
    Math.ceil((Math.max(...all.map((r) => r.x + r.w)) + 240 - x0) / P) + 1
  const ny =
    Math.ceil((Math.max(...all.map((r) => r.y + r.h)) + 240 - y0) / P) + 1
  const N = nx * ny
  const id = (i: number, j: number) => j * nx + i
  return {
    x0,
    y0,
    nx,
    ny,
    N,
    id,
    X: (k: number) => x0 + (k % nx) * P,
    Y: (k: number) => y0 + Math.floor(k / nx) * P,
    at: (x: number, y: number) =>
      id(Math.round((x - x0) / P), Math.round((y - y0) / P)),
    blocked: new Uint8Array(N),
    border: new Uint8Array(N),
    doorOwner: new Int32Array(N).fill(-1),
    doorSlot: new Int32Array(N).fill(-1),
    perpOnly: new Uint8Array(N),
    noShare: new Uint8Array(N),
    near: new Uint8Array(N),
  }
}

export function makeUsage(N: number): Usage {
  return {
    nodeG: new Int32Array(N).fill(-1),
    nodeC: new Int32Array(N),
    nodeM: new Uint8Array(N),
    nodeXG: new Int32Array(N).fill(-1),
    nodeXC: new Int32Array(N),
    nodeXM: new Uint8Array(N),
    edgeG: new Int32Array(2 * N).fill(-1),
    edgeC: new Int32Array(2 * N),
    stub: new Uint8Array(N),
    usedPort: new Set<string>(),
    placed: new Map<string, Placed>(),
    groupCards: new Map<number, Map<string, number>>(),
  }
}

// Block every lattice node strictly inside `r` grown by `pad`.
export function blockRect(g: Grid, r: Rect, pad: number): void {
  const { x0, y0, nx, ny, id, blocked } = g
  const i0 = Math.max(0, Math.ceil((r.x - pad - x0) / P)),
    i1 = Math.min(nx - 1, Math.floor((r.x + r.w + pad - x0) / P))
  const j0 = Math.max(0, Math.ceil((r.y - pad - y0) / P)),
    j1 = Math.min(ny - 1, Math.floor((r.y + r.h + pad - y0) / P))
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const x = x0 + i * P,
        y = y0 + j * P
      if (
        x > r.x - pad
        && x < r.x + r.w + pad
        && y > r.y - pad
        && y < r.y + r.h + pad
      )
        blocked[id(i, j)] = 1
    }
}

// Which side of A faces B (along the axis with the larger gap).
export function facing(A: Rect, B: Rect): Side {
  const gx = Math.max(B.x - (A.x + A.w), A.x - (B.x + B.w)),
    gy = Math.max(B.y - (A.y + A.h), A.y - (B.y + B.h))
  if (gx >= gy) return B.x > A.x ? "RIGHT" : "LEFT"
  return B.y > A.y ? "BOTTOM" : "TOP"
}

export function isHoriz(side: Side): boolean {
  return side === "TOP" || side === "BOTTOM"
}

export function sideSpan(R: Rect, side: Side): [number, number] {
  return isHoriz(side) ? [R.x, R.x + R.w] : [R.y, R.y + R.h]
}

// The fixed coordinate of one side of R: its y for TOP/BOTTOM, its x for LEFT/RIGHT.
export function wallCoord(R: Rect, side: Side): number {
  if (side === "TOP") return R.y
  if (side === "BOTTOM") return R.y + R.h
  if (side === "LEFT") return R.x
  return R.x + R.w
}

// The point at coordinate c along one side of R.
export function wallPoint(R: Rect, side: Side, c: number): Pt {
  return isHoriz(side) ? [c, wallCoord(R, side)] : [wallCoord(R, side), c]
}

export const pairKey = (a: string, b: string) => [a, b].sort().join("|")

export const portKey = (p: Port) => `${p.card}|${p.border[0]}|${p.border[1]}`

export function firstLine(text: string | undefined): string {
  return (text ?? "").split("\n")[0]
}

// A node's FigJam shape name ("" when it has none).
export function shapeOf(n: { style?: ShapeStyle }): string {
  return n.style?.shape ?? ""
}

export function nodeOf(b: Board, id: string): Node {
  return must(b.m.get(id), `node ${id}`)
}

export function sectionRect(b: Board, id: string): Rect {
  return must(b.sec.get(id), `section ${id}`).rect
}
