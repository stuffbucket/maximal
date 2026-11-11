// Layout model + geometry + metrics. Pure functions, no bridge access.
export type Pt = [number, number]
export type Rect = { x: number; y: number; w: number; h: number }
export type Side = "TOP" | "BOTTOM" | "LEFT" | "RIGHT"
export type EdgeKind = "dep" | "flow" | "verify" | "loop" | "other"

export type Section = { id: string; name: string; rect: Rect; style?: any }
export type Node = { id: string; section?: string; rect: Rect; type: string; role?: string; text?: string; style?: any; obstacle: boolean }
export type Edge = { id: string; from: string; to: string; kind: EdgeKind; label?: string; fromMagnet?: string; toMagnet?: string; lineType?: string; style?: any }
// A route: native = FigJam auto-elbow between two magnets; drawn = our own polyline.
export type Route = { edge: string; pts: Pt[]; native: boolean; fromMagnet?: Side; toMagnet?: Side; bundle?: string }
export type Label = { edge: string; text: string; rect: Rect }
export type Layout = { name: string; sections: Section[]; nodes: Node[]; edges: Edge[]; routes: Route[]; notes?: string[]; blocks?: Rect[]; labels?: Label[]; checks?: Record<string, number> }

export const SIDES: Side[] = ["TOP", "BOTTOM", "LEFT", "RIGHT"]

export function center(r: Rect): Pt {
  return [r.x + r.w / 2, r.y + r.h / 2]
}

export function sidePoint(r: Rect, s: Side, t = 0.5): Pt {
  if (s === "TOP") return [r.x + r.w * t, r.y]
  if (s === "BOTTOM") return [r.x + r.w * t, r.y + r.h]
  if (s === "LEFT") return [r.x, r.y + r.h * t]
  return [r.x + r.w, r.y + r.h * t]
}

const DIR: Record<Side, Pt> = { TOP: [0, -1], BOTTOM: [0, 1], LEFT: [-1, 0], RIGHT: [1, 0] }

// Facing sides along the dominant axis (what `connect` does with magnets omitted).
export function autoSides(a: Rect, b: Rect): [Side, Side] {
  const [ax, ay] = center(a)
  const [bx, by] = center(b)
  const dx = bx - ax
  const dy = by - ay
  const overlapX = a.x < b.x + b.w && b.x < a.x + a.w
  const overlapY = a.y < b.y + b.h && b.y < a.y + a.h
  const horizontal = overlapY ? true : overlapX ? false : Math.abs(dx) >= Math.abs(dy)
  if (horizontal) return dx >= 0 ? ["RIGHT", "LEFT"] : ["LEFT", "RIGHT"]
  return dy >= 0 ? ["BOTTOM", "TOP"] : ["TOP", "BOTTOM"]
}

// Approximation of FigJam's elbow router between two magnets: leave each side
// perpendicular by a stub, then join with one or two orthogonal bends.
export function nativeElbow(a: Rect, sa: Side, b: Rect, sb: Side, stub = 24): Pt[] {
  const p = sidePoint(a, sa)
  const q = sidePoint(b, sb)
  const da = DIR[sa]
  const db = DIR[sb]
  const p1: Pt = [p[0] + da[0] * stub, p[1] + da[1] * stub]
  const q1: Pt = [q[0] + db[0] * stub, q[1] + db[1] * stub]
  const hA = da[0] !== 0
  const hB = db[0] !== 0
  let mid: Pt[]
  if (hA && hB) {
    const mx = (p1[0] + q1[0]) / 2
    mid = [[mx, p1[1]], [mx, q1[1]]]
  } else if (!hA && !hB) {
    const my = (p1[1] + q1[1]) / 2
    mid = [[p1[0], my], [q1[0], my]]
  } else if (hA) mid = [[q1[0], p1[1]]]
  else mid = [[p1[0], q1[1]]]
  return simplify([p, p1, ...mid, q1, q])
}

export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (last && Math.abs(last[0] - p[0]) < 0.5 && Math.abs(last[1] - p[1]) < 0.5) continue
    out.push([Math.round(p[0]), Math.round(p[1])])
  }
  // drop collinear middle points
  for (let i = out.length - 2; i > 0; i--) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]]
    if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) out.splice(i, 1)
  }
  return out
}

// ---- metrics ----
function segHitsRect(p: Pt, q: Pt, r: Rect, pad = 2): boolean {
  const x0 = r.x + pad, y0 = r.y + pad, x1 = r.x + r.w - pad, y1 = r.y + r.h - pad
  // Liang–Barsky clip
  let t0 = 0, t1 = 1
  const dx = q[0] - p[0], dy = q[1] - p[1]
  const tests: [number, number][] = [[-dx, p[0] - x0], [dx, x1 - p[0]], [-dy, p[1] - y0], [dy, y1 - p[1]]]
  for (const [pp, qq] of tests) {
    if (pp === 0) { if (qq < 0) return false; continue }
    const t = qq / pp
    if (pp < 0) { if (t > t1) return false; if (t > t0) t0 = t }
    else { if (t < t0) return false; if (t < t1) t1 = t }
  }
  return t1 - t0 > 1e-6
}

function segsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0
}

function overlapLen(a: Pt, b: Pt, c: Pt, d: Pt): number {
  if (a[1] === b[1] && c[1] === d[1] && Math.abs(a[1] - c[1]) < 1) {
    const lo = Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0]))
    const hi = Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0]))
    return Math.max(0, hi - lo)
  }
  if (a[0] === b[0] && c[0] === d[0] && Math.abs(a[0] - c[0]) < 1) {
    const lo = Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1]))
    const hi = Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]))
    return Math.max(0, hi - lo)
  }
  return 0
}

export type Metrics = { edges: number; inkCrossings: number; strokes: number; inkBends: number; inkLength: number; throughNode: number; throughHits: number; crossings: number; bends: number; length: number; laneOverlaps: number; nodeOverlaps: number; area: number }

export function score(L: Layout): Metrics {
  const byId = new Map(L.nodes.map((n) => [n.id, n]))
  const edgeById = new Map(L.edges.map((e) => [e.id, e]))
  const obstacles = L.nodes.filter((n) => n.obstacle)
  let throughNode = 0, throughHits = 0, bends = 0, length = 0
  for (const r of L.routes) {
    const e = edgeById.get(r.edge)!
    let hit = 0
    for (const n of obstacles) {
      if (n.id === e.from || n.id === e.to) continue
      for (let i = 0; i + 1 < r.pts.length; i++) if (segHitsRect(r.pts[i], r.pts[i + 1], n.rect)) { hit++; break }
    }
    if (hit) throughNode++
    throughHits += hit
    bends += Math.max(0, r.pts.length - 2)
    for (let i = 0; i + 1 < r.pts.length; i++) length += Math.hypot(r.pts[i + 1][0] - r.pts[i][0], r.pts[i + 1][1] - r.pts[i][1])
  }
  let crossings = 0, laneOverlaps = 0
  for (let i = 0; i < L.routes.length; i++) {
    for (let j = i + 1; j < L.routes.length; j++) {
      const A = L.routes[i], B = L.routes[j]
      const ea = edgeById.get(A.edge)!, eb = edgeById.get(B.edge)!
      const shared = [ea.from, ea.to].some((x) => x === eb.from || x === eb.to)
      let crossed = false, overl = 0
      for (let s = 0; s + 1 < A.pts.length; s++) {
        for (let t = 0; t + 1 < B.pts.length; t++) {
          if (!shared && segsCross(A.pts[s], A.pts[s + 1], B.pts[t], B.pts[t + 1])) crossed = true
          overl += overlapLen(A.pts[s], A.pts[s + 1], B.pts[t], B.pts[t + 1])
        }
      }
      if (crossed) crossings++
      if (overl > 8 && !shared && !(A.bundle && A.bundle === B.bundle)) laneOverlaps++
    }
  }
  let nodeOverlaps = 0
  for (let i = 0; i < obstacles.length; i++)
    for (let j = i + 1; j < obstacles.length; j++) {
      const a = obstacles[i].rect, b = obstacles[j].rect
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) nodeOverlaps++
    }
  const all = [...L.sections.map((s) => s.rect), ...L.nodes.map((n) => n.rect)]
  const bx = Math.min(...all.map((r) => r.x)), by = Math.min(...all.map((r) => r.y))
  const ex = Math.max(...all.map((r) => r.x + r.w)), ey = Math.max(...all.map((r) => r.y + r.h))
  void byId
  // ink crossings: proper intersections between the strokes actually drawn (a bundled trunk is one stroke)
  const pieces = (L as any).pieces as { pts: Pt[] }[] | undefined
  const strokes: Pt[][] = [...(pieces ?? []).map((p) => p.pts), ...L.routes.filter((r) => !pieces || r.native).map((r) => r.pts)]
  let inkCrossings = 0
  for (let i = 0; i < strokes.length; i++)
    for (let j = i + 1; j < strokes.length; j++)
      for (let s = 0; s + 1 < strokes[i].length; s++)
        for (let t = 0; t + 1 < strokes[j].length; t++) if (segsCross(strokes[i][s], strokes[i][s + 1], strokes[j][t], strokes[j][t + 1])) inkCrossings++
  const inkBends = strokes.reduce((a, p) => a + Math.max(0, p.length - 2), 0)
  const inkLength = Math.round(strokes.reduce((a, p) => a + p.slice(1).reduce((b, q, i) => b + Math.abs(q[0] - p[i][0]) + Math.abs(q[1] - p[i][1]), 0), 0))
  return { edges: L.routes.length, inkCrossings, strokes: strokes.length, inkBends, inkLength, throughNode, throughHits, crossings, bends, length: Math.round(length), laneOverlaps, nodeOverlaps, area: Math.round(((ex - bx) * (ey - by)) / 1e6 * 10) / 10 }
}

// Best magnet pair for a native connector given the current layout, by local cost.
export function bestMagnets(a: Rect, b: Rect, obstacles: Rect[], others: Pt[][], crossCost = Number(process.env.LAYOUT_CROSS_COST ?? 800)): { sa: Side; sb: Side; pts: Pt[] } {
  let best: { sa: Side; sb: Side; pts: Pt[]; c: number } | undefined
  const [da, db] = autoSides(a, b)
  for (const sa of SIDES)
    for (const sb of SIDES) {
      const pts = nativeElbow(a, sa, b, sb)
      let c = 0
      for (const o of obstacles) for (let i = 0; i + 1 < pts.length; i++) if (segHitsRect(pts[i], pts[i + 1], o)) { c += 10000; break }
      for (const op of others) for (let i = 0; i + 1 < pts.length; i++) for (let j = 0; j + 1 < op.length; j++) if (segsCross(pts[i], pts[i + 1], op[j], op[j + 1])) c += crossCost
      // into a node's own box = backwards
      if (segHitsRect(pts[0], pts[Math.min(2, pts.length - 1)], a, 1) || segHitsRect(pts[pts.length - 1], pts[Math.max(0, pts.length - 3)], b, 1)) c += 5000
      for (let i = 0; i + 1 < pts.length; i++) c += Math.abs(pts[i + 1][0] - pts[i][0]) + Math.abs(pts[i + 1][1] - pts[i][1])
      c += (pts.length - 2) * 60
      if (sa === da && sb === db) c -= 40 // prefer FigJam's own choice on ties
      if (!best || c < best.c) best = { sa, sb, pts, c }
    }
  return best!
}
