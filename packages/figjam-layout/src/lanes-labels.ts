// Labels and the geometric helpers the self-checks share: segments of the drawn routes, segment/rect
// hits, label sizes and placement.
import {
  must,
  type Edge,
  type Label,
  type Layout,
  type Node,
  type Pt,
  type Rect,
} from "./model"

export type Seg = { edge: string; bundle: string; a: Pt; b: Pt }

export const segsOf = (L: Layout): Array<Seg> =>
  L.routes.flatMap((r) =>
    r.pts.slice(1).map((q, i) => ({
      edge: r.edge,
      bundle: r.bundle ?? r.edge,
      a: r.pts[i],
      b: q,
    })),
  )

// whether segment a→b passes through rect r grown by pad
export function hitRect(ab: [Pt, Pt], r: Rect, pad = 0): boolean {
  const [a, b] = ab
  return (
    Math.max(a[0], b[0]) > r.x - pad
    && Math.min(a[0], b[0]) < r.x + r.w + pad
    && Math.max(a[1], b[1]) > r.y - pad
    && Math.min(a[1], b[1]) < r.y + r.h + pad
  )
}

export const rectsHit = (a: Rect, b: Rect, pad = 0) =>
  a.x < b.x + b.w + pad
  && b.x < a.x + a.w + pad
  && a.y < b.y + b.h + pad
  && b.y < a.y + a.h + pad

// caption text (13px Inter) runs ~6.6px per character; plan 7.5 + 24 so a label never truncates
export const labelSize = (t: string) => ({
  w: Math.round(t.length * 7.5 + 24),
  h: 24,
})

// Manhattan length of a polyline.
export function pathLen(pts: Array<Pt>): number {
  return pts
    .slice(1)
    .reduce(
      (a, q, i) => a + Math.abs(q[0] - pts[i][0]) + Math.abs(q[1] - pts[i][1]),
      0,
    )
}

// Whether a polyline never reverses direction on either axis.
export function monotonePts(pts: Array<Pt>): boolean {
  let sx = 0,
    sy = 0
  for (let i = 1; i < pts.length; i++) {
    const dx = Math.sign(pts[i][0] - pts[i - 1][0]),
      dy = Math.sign(pts[i][1] - pts[i - 1][1])
    if (dx) {
      if (sx && dx !== sx) return false
      sx = dx
    }
    if (dy) {
      if (sy && dy !== sy) return false
      sy = dy
    }
  }
  return true
}

// The side of card rect c that a route end p sits on (T/B/L/R).
export function endSideCode(c: Rect, p: Pt): string {
  if (p[1] <= c.y) return "T"
  if (p[1] >= c.y + c.h) return "B"
  if (p[0] <= c.x + c.w / 2) return "L"
  return "R"
}

// the crossing point of a horizontal and a vertical segment (strictly inside both)
export function crossAt(
  A: { a: Pt; b: Pt },
  B: { a: Pt; b: Pt },
): Pt | undefined {
  const hA = A.a[1] === A.b[1],
    hB = B.a[1] === B.b[1]
  if (hA === hB) return undefined
  const H = hA ? A : B,
    V = hA ? B : A
  const x = V.a[0],
    y = H.a[1]
  if (
    x > Math.min(H.a[0], H.b[0])
    && x < Math.max(H.a[0], H.b[0])
    && y > Math.min(V.a[1], V.b[1])
    && y < Math.max(V.a[1], V.b[1])
  )
    return [x, y]
  return undefined
}

export function edgeById(edge: Map<string, Edge>, id: string): Edge {
  return must(edge.get(id), `edge ${id}`)
}

export function findNode(L: Layout, id: string): Node {
  return must(
    L.nodes.find((n) => n.id === id),
    `node ${id}`,
  )
}

// The four borders of every section, as segments.
function sectionBorders(L: Layout): Array<[Pt, Pt]> {
  return L.sections.flatMap((s) => {
    const R = s.rect
    return [
      [
        [R.x, R.y],
        [R.x + R.w, R.y],
      ],
      [
        [R.x, R.y + R.h],
        [R.x + R.w, R.y + R.h],
      ],
      [
        [R.x, R.y],
        [R.x, R.y + R.h],
      ],
      [
        [R.x + R.w, R.y],
        [R.x + R.w, R.y + R.h],
      ],
    ] as Array<[Pt, Pt]>
  })
}

// A label rect beside one straight segment a→b, or undefined when none is free.
function labelBeside(
  ab: [Pt, Pt],
  size: { w: number; h: number },
  free: (r: Rect) => boolean,
): Rect | undefined {
  const [a, b] = ab
  const { w, h } = size
  const vertical = a[0] === b[0]
  for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) {
    const cx = a[0] + (b[0] - a[0]) * t,
      cy = a[1] + (b[1] - a[1]) * t
    for (const sgn of [1, -1]) {
      const rect =
        vertical ?
          { x: sgn > 0 ? cx + 6 : cx - 6 - w, y: cy - h / 2, w, h }
        : { x: cx - w / 2, y: sgn > 0 ? cy - 6 - h : cy + 6, w, h }
      const rr = { x: Math.round(rect.x), y: Math.round(rect.y), w, h }
      if (free(rr)) return rr
    }
  }
  return undefined
}

export function placeLabels(L: Layout, titles: Array<Rect>): Array<Label> {
  const segs = segsOf(L)
  const cards = L.nodes.map((n) => n.rect)
  const out: Array<Label> = []
  const borders = sectionBorders(L)
  const free = (r: Rect) =>
    !segs.some((s) => hitRect([s.a, s.b], r, 3))
    && !cards.some((c) => rectsHit(r, c, 8))
    && !titles.some((t) => rectsHit(r, t, 8))
    && !out.some((o) => rectsHit(r, o.rect, 6))
    && !borders.some(([a, b]) => hitRect([a, b], r, 4))
  for (const r of L.routes) {
    const e = must(
      L.edges.find((x) => x.id === r.edge),
      `edge ${r.edge}`,
    )
    if (!e.label) continue
    const size = labelSize(e.label)
    let best: Rect | undefined
    // straight segments of its own line, last first (near the target reads best), skipping the stubs
    for (let i = r.pts.length - 1; i > 0 && !best; i--) {
      const a = r.pts[i - 1],
        b = r.pts[i]
      const vertical = a[0] === b[0]
      const L0 = Math.abs(vertical ? b[1] - a[1] : b[0] - a[0])
      const need = (vertical ? size.h : size.w) + 48
      if (L0 < need) continue
      best = labelBeside([a, b], size, free)
    }
    if (best) out.push({ edge: e.id, text: e.label, rect: best })
  }
  return out
}
