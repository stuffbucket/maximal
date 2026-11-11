// Local-optimality fixpoint after routing. Legal simplifications are applied until none applies:
//   alignJog     shift a middle segment onto a neighbour's line (removes a Z jog)
//   collapseU    the same move where the neighbours run in opposite directions (removes a U)
//   slideToPort  shift the first/last track onto the port's coordinate (a straight approach)
//   portToCentre move a port to its side's centre or symmetric slot
//   laneSwap     swap two parallel lanes when that removes a crossing
//   merge        collinear segments merge (implicit in every move)
// A move is legal only if every hard check still passes; it is applied when it improves the
// lexicographic objective (crossings → non-monotone → bends → port deviation → length). Remaining
// bends get a cause that was verified by trying the straighter alternative and naming what broke.
import { HARD_CHECKS, checks } from "./lanes"
import {
  checkValue,
  last,
  must,
  simplify,
  type FixpointStats,
  type Layout,
  type Node,
  type Pt,
  type Rect,
  type Route,
} from "./model"

const IGNORE = new Set([
  "labelHits",
  "labelsTruncated",
  "tagHits",
  "tagsUnplaced",
  "tagsMissing",
  "pillsInCorridor",
  "simplificationsLeft",
]) // re-placed after the fixpoint
const HARD = HARD_CHECKS.filter((k) => !IGNORE.has(k))

type Checks = Record<string, number>
type Seg = [Pt, Pt]
type Candidate = { kind: string; pts: Array<Pt>; onAccept?: () => void }

const hard = (c: Checks) => HARD.reduce((s, k) => s + (c[k] ?? 0), 0)
const noWorse = (c: Checks, base: Checks) =>
  HARD.every((k) => (c[k] ?? 0) <= (base[k] ?? 0))
const less = (a: Array<number>, b: Array<number>) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}
const bendsTotal = (R: Layout) =>
  R.routes.reduce((a, r) => a + Math.max(0, r.pts.length - 2), 0)

// The objective and the legality test, against the layout's current (best-known) checks.
class Judge {
  readonly R: Layout
  readonly applied: Record<string, number> = {
    alignJog: 0,
    collapseU: 0,
    slideToPort: 0,
    portToLane: 0,
    portToCentre: 0,
    laneSwap: 0,
  }
  evaluations = 0
  curC: Checks
  cur: Array<number>
  private readonly titles: Array<Rect>

  constructor(R: Layout, titles: Array<Rect>) {
    this.R = R
    this.titles = titles
    this.curC = this.evalAll()
    this.cur = this.key(this.curC)
  }

  evalAll(): Checks {
    this.evaluations++
    return checks({ ...this.R, labels: [] }, this.titles)
  }

  key(c: Checks): Array<number> {
    return [
      hard(c),
      checkValue(c, "crossings"),
      checkValue(c, "nonMonotoneGlobal"),
      bendsTotal(this.R),
      portDeviation(this.R),
      checkValue(c, "wireLength"),
    ]
  }

  // no hard check gets worse and the objective improves
  improves(c: Checks): boolean {
    return noWorse(c, this.curC) && less(this.key(c), this.cur)
  }

  // Apply the changes; keep them if they improve, else put the old points back.
  tryMove(changes: Array<[Route, Array<Pt>]>, kind: string): boolean {
    const old = changes.map(([r]) => r.pts)
    for (const [r, pts] of changes) r.pts = pts
    const c = this.evalAll()
    const k = this.key(c)
    if (noWorse(c, this.curC) && less(k, this.cur)) {
      this.cur = k
      this.curC = c
      this.applied[kind]++
      return true
    }
    for (const [i, [r]] of changes.entries()) {
      r.pts = old[i]
    }
    return false
  }
}

export function fixpoint(
  R: Layout,
  titles: Array<Rect>,
  maxSweeps = 6,
): FixpointStats {
  const judge = new Judge(R, titles)
  let sweeps = 0
  for (; sweeps < maxSweeps; sweeps++) if (!sweep(judge)) break
  // proof of the fixpoint: count legal improving simplifications still available (must be 0)
  const left = improvementsLeft(judge)
  explainBends(judge)
  return {
    applied: judge.applied,
    sweeps,
    evaluations: judge.evaluations,
    left,
  }
}

// One pass: the first accepted candidate per route, then lane swaps. Whether anything changed.
function sweep(judge: Judge): boolean {
  const { R } = judge
  let changed = false
  for (const r of R.routes) {
    for (const cand of candidates(r, R))
      if (judge.tryMove([[r, cand.pts]], cand.kind)) {
        cand.onAccept?.()
        changed = true
        break
      }
  }
  if (laneSwaps(judge)) changed = true
  return changed
}

// lane swaps: two routes that cross, with parallel segments close together
function laneSwaps(judge: Judge): boolean {
  const { routes } = judge.R
  let changed = false
  for (let i = 0; i < routes.length; i++)
    for (let j = i + 1; j < routes.length; j++) {
      const A = routes[i],
        B = routes[j]
      if (!crosses(A.pts, B.pts)) continue
      if (swapLanes(judge, A, B)) changed = true
    }
  return changed
}

// Try swapping each pair of parallel middle segments (≤ 80px apart) of two crossing routes.
function swapLanes(judge: Judge, A: Route, B: Route): boolean {
  let changed = false
  for (let s = 1; s + 2 < A.pts.length; s++)
    for (let t = 1; t + 2 < B.pts.length; t++) {
      const a0 = A.pts[s],
        a1 = A.pts[s + 1],
        b0 = B.pts[t],
        b1 = B.pts[t + 1]
      const hA = a0[1] === a1[1],
        hB = b0[1] === b1[1]
      if (hA !== hB) continue
      const ca = hA ? a0[1] : a0[0],
        cb = hA ? b0[1] : b0[0]
      if (Math.abs(ca - cb) > 80 || ca === cb) continue
      const na = shift(A.pts, s, cb),
        nb = shift(B.pts, t, ca)
      if (
        judge.tryMove(
          [
            [A, na],
            [B, nb],
          ],
          "laneSwap",
        )
      )
        changed = true
    }
  return changed
}

function improvementsLeft(judge: Judge): number {
  const { R } = judge
  let left = 0
  for (const r of R.routes)
    for (const cand of candidates(r, R)) {
      const old = r.pts
      r.pts = cand.pts
      const c = judge.evalAll()
      if (judge.improves(c)) left++
      r.pts = old
    }
  return left
}

// verified explanations for every remaining bend: try the straighter alternative, name what breaks
function explainBends(judge: Judge): void {
  const { R } = judge
  const explain = (R.explain ??= {})
  for (const r of R.routes) {
    const causes = bendCauses(judge, r)
    if (r.pts.length === 3) causes.push(`single bend: ${cornerCause(r)}`)
    explain[r.edge] = { ...explain[r.edge], bends: causes }
  }
}

function bendCauses(judge: Judge, r: Route): Array<string> {
  const causes: Array<string> = []
  for (let i = 1; i + 2 < r.pts.length; i++) {
    const tried: Array<string> = []
    for (const c2 of [
      axisCoord(r.pts[i - 1], r.pts[i], r.pts[i + 1]),
      axisCoord(r.pts[i + 2], r.pts[i + 1], r.pts[i]),
    ]) {
      const alt = shift(r.pts, i, c2)
      if (alt.length >= r.pts.length) continue
      tried.push(whyNot(judge, r, alt))
    }
    causes.push(
      tried.length > 0 ?
        tried.join("; ")
      : "no straighter alternative on the lattice",
    )
  }
  return causes
}

// coordinate a middle segment would take to line up with the given neighbour point
function axisCoord(target: Pt, a: Pt, b: Pt): number {
  return a[1] === b[1] ? target[1] : target[0]
}

function shift(pts: Array<Pt>, i: number, c: number): Array<Pt> {
  const out = pts.map((p) => [...p] as Pt)
  const horiz = out[i][1] === out[i + 1][1]
  if (horiz) {
    out[i][1] = c
    out[i + 1][1] = c
  } else {
    out[i][0] = c
    out[i + 1][0] = c
  }
  return simplify(out)
}

function candidates(r: Route, R: Layout): Array<Candidate> {
  return [
    ...jogCandidates(r),
    ...portToLaneCandidates(r, R),
    ...portToCentreCandidates(r, R),
  ]
}

function jogKind(nearPort: boolean, u: boolean): string {
  if (nearPort) return "slideToPort"
  return u ? "collapseU" : "alignJog"
}

// middle segments aligned onto a neighbour's line
function jogCandidates(r: Route): Array<Candidate> {
  const out: Array<Candidate> = []
  const n = r.pts.length
  for (let i = 1; i + 2 < n; i++) {
    const before = r.pts[i - 1],
      after = r.pts[i + 2]
    const a = r.pts[i],
      b = r.pts[i + 1]
    const prevDir = Math.sign(a[0] - before[0] + (a[1] - before[1])),
      nextDir = Math.sign(after[0] - b[0] + (after[1] - b[1]))
    const u = prevDir !== 0 && nextDir !== 0 && prevDir !== nextDir
    // never align onto a port's own coordinate (that would lay the line on the card's border and
    // collapse the stub); aligning onto the stub's line (the segment after the first bend) is fine
    for (const [c, fromPort] of [
      [axisCoord(before, a, b), i === 1],
      [axisCoord(after, a, b), i + 2 === n - 1],
    ] as Array<[number, boolean]>) {
      if (fromPort) continue
      const pts = shift(r.pts, i, c)
      const nearPort = i === 2 || i + 3 === n - 1
      if (pts.length < n) out.push({ kind: jogKind(nearPort, u), pts })
    }
  }
  return out
}

// Record that the port at `end` was slid along its side onto its own lane.
function notePortSlide(R: Layout, edge: string, end: "from" | "to"): void {
  const ex = (R.explain ??= {})
  const entry = ex[edge] ?? {}
  ex[edge] = entry
  const port = entry[end]
  entry[end] = {
    ...(typeof port === "object" ? port : undefined),
    cause: "slid along its side onto its own lane (removes a jog)",
  }
}

// ports onto their own lane: a short sideways step right after (or before) the stub is removed by
// sliding the port along its side onto the next lane's coordinate
function portToLaneCandidates(r: Route, R: Layout): Array<Candidate> {
  const n = r.pts.length
  if (n < 4) return []
  const out: Array<Candidate> = []
  for (const end of [0, 1] as const) {
    const [p0, p1, p2] = end === 0 ? [0, 1, 2] : [n - 1, n - 2, n - 3]
    const a = r.pts[p1],
      b = r.pts[p2]
    const step = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])
    if (step > 80) continue
    const stubVertical = r.pts[p0][0] === a[0]
    const p3 = end === 0 ? 3 : n - 4
    const from = stubVertical ? a[0] : a[1],
      to = stubVertical ? b[0] : b[1]
    // candidate lines: the lane's own coordinate, or any 20px line between port and lane (then the
    // lane moves too, if it isn't the far port's stub)
    const lines: Array<number> = [to]
    for (let c = Math.min(from, to) + 20; c < Math.max(from, to); c += 20)
      lines.push(c)
    for (const c of lines) {
      const pts = r.pts.map((z) => [...z] as Pt)
      const set = (i: number) => {
        if (stubVertical) pts[i][0] = c
        else pts[i][1] = c
      }
      set(p0)
      set(p1)
      if (c !== to) {
        if (p3 <= 0 || p3 >= n - 1) continue
        set(p2)
        set(p3)
      }
      const simplified = simplify(pts)
      if (simplified.length < n)
        out.push({
          kind: "portToLane",
          pts: simplified,
          onAccept: () => {
            notePortSlide(R, r.edge, end === 0 ? "from" : "to")
          },
        })
    }
  }
  return out
}

// The coordinate a port at p on one of the card's sides should take: the side's centre, or its
// slot in a symmetric spread of every port on that side.
function centreSlot(R: Layout, card: Node, p: Pt): number {
  const onTB = p[1] <= card.rect.y || p[1] >= card.rect.y + card.rect.h
  const centre =
    onTB ? card.rect.x + card.rect.w / 2 : card.rect.y + card.rect.h / 2
  const sameSide = R.routes
    .flatMap((q) => [q.pts[0], last(q.pts)])
    .filter(
      (z) => cardAt(R, z) === card && (onTB ? z[1] === p[1] : z[0] === p[0]),
    )
    .map((z) => (onTB ? z[0] : z[1]))
    .sort((u, v) => u - v)
  const k = sameSide.length,
    rank = sameSide.indexOf(onTB ? p[0] : p[1])
  const sideLen = onTB ? card.rect.w : card.rect.h
  const pitch =
    k > 1 ?
      Math.min(
        160,
        Math.max(40, Math.floor((0.6 * sideLen) / (k - 1) / 20) * 20),
      )
    : 0 // same rule as the router
  return Math.round((centre + (rank - (k - 1) / 2) * pitch) / 20) * 20
}

// ports: move an end to its side's centre / symmetric slot (only when a bend absorbs the shift)
function portToCentreCandidates(r: Route, R: Layout): Array<Candidate> {
  const n = r.pts.length
  if (n < 3) return []
  const out: Array<Candidate> = []
  for (const end of [0, 1] as const) {
    const idx = end === 0 ? 0 : n - 1,
      nb = end === 0 ? 1 : n - 2
    const p = r.pts[idx]
    const card = cardAt(R, p)
    if (!card) continue
    const onTB = p[1] <= card.rect.y || p[1] >= card.rect.y + card.rect.h
    const want = centreSlot(R, card, p)
    const now = onTB ? p[0] : p[1]
    if (want === now) continue
    const pts = r.pts.map((z) => [...z] as Pt)
    if (onTB) {
      pts[idx][0] = want
      pts[nb][0] = want
    } else {
      pts[idx][1] = want
      pts[nb][1] = want
    }
    out.push({ kind: "portToCentre", pts: simplify(pts) })
  }
  return out
}

function cardAt(R: Layout, p: Pt): Node | undefined {
  return R.nodes.find(
    (n) =>
      n.obstacle
      && p[0] >= n.rect.x - 0.5
      && p[0] <= n.rect.x + n.rect.w + 0.5
      && p[1] >= n.rect.y - 0.5
      && p[1] <= n.rect.y + n.rect.h + 0.5,
  )
}

function crosses(a: Array<Pt>, b: Array<Pt>): boolean {
  for (let s = 0; s + 1 < a.length; s++)
    for (let t = 0; t + 1 < b.length; t++) {
      const p = a[s],
        q = a[s + 1],
        u = b[t],
        v = b[t + 1]
      const hA = p[1] === q[1],
        hB = u[1] === v[1]
      if (hA === hB) continue
      const H = hA ? [p, q] : [u, v],
        V = hA ? [u, v] : [p, q]
      const x = V[0][0],
        y = H[0][1]
      if (
        x > Math.min(H[0][0], H[1][0])
        && x < Math.max(H[0][0], H[1][0])
        && y > Math.min(V[0][1], V[1][1])
        && y < Math.max(V[0][1], V[1][1])
      )
        return true
    }
  return false
}

export function portDeviation(R: Layout): number {
  let d = 0
  for (const r of R.routes)
    for (const p of [r.pts[0], last(r.pts)]) {
      const c = cardAt(R, p)
      if (!c) continue
      const onTB = p[1] <= c.rect.y || p[1] >= c.rect.y + c.rect.h
      d += Math.abs(
        onTB ?
          p[0] - (c.rect.x + c.rect.w / 2)
        : p[1] - (c.rect.y + c.rect.h / 2),
      )
    }
  return Math.round(d)
}

const title = (R: Layout, id: string) =>
  (R.nodes.find((n) => n.id === id)?.text ?? id).split("\n")[0]

const edgeOf = (R: Layout, id: string) =>
  must(
    R.edges.find((x) => x.id === id),
    `edge ${id}`,
  )

// What a straighter version `alt` of route r runs into: a card, another line, or neither.
function blocker(R: Layout, r: Route, alt: Array<Pt>): string {
  const segs = alt.slice(1).map((q, i): Seg => [alt[i], q])
  const e = edgeOf(R, r.edge)
  const hitCard = R.nodes.find(
    (n) =>
      n.obstacle
      && n.id !== e.from
      && n.id !== e.to
      && segs.some(
        ([a, b]) =>
          Math.max(a[0], b[0]) > n.rect.x - 16
          && Math.min(a[0], b[0]) < n.rect.x + n.rect.w + 16
          && Math.max(a[1], b[1]) > n.rect.y - 16
          && Math.min(a[1], b[1]) < n.rect.y + n.rect.h + 16,
      ),
  )
  if (hitCard) return `card ${title(R, hitCard.id)}`
  const other = R.routes.find(
    (q) =>
      q !== r
      && (q.bundle ?? q.edge) !== (r.bundle ?? r.edge)
      && q.pts
        .slice(1)
        .some((v, j) => segs.some((sg) => near(sg, [q.pts[j], v]))),
  )
  if (other)
    return `the line ${title(R, edgeOf(R, other.edge).from)} → ${title(R, edgeOf(R, other.edge).to)}`
  return "a wall/door or port rule"
}

// Why an alternative that broke no hard check still lost on the objective.
function objectiveVerdict(k: Array<number>, cur: Array<number>): string {
  if (k[1] > cur[1]) return "straighter version adds a crossing"
  if (k[2] > cur[2]) return "straighter version is non-monotone"
  return "straighter version is no better on the objective"
}

// why a straighter alternative was not taken: apply it, see which hard check breaks, name the thing
function whyNot(judge: Judge, r: Route, alt: Array<Pt>): string {
  const old = r.pts
  r.pts = alt
  const c = judge.evalAll()
  const broke = HARD.filter((k) => (c[k] ?? 0) > (judge.curC[k] ?? 0))
  const msg =
    broke.length > 0 ?
      `straighter version breaks ${broke.join(", ")} (${blocker(judge.R, r, alt)})`
    : objectiveVerdict(judge.key(c), judge.cur)
  r.pts = old
  return msg
}

function near([a, b]: Seg, [c, d]: Seg): boolean {
  const h1 = a[1] === b[1],
    h2 = c[1] === d[1]
  if (h1 === h2) {
    const dist = h1 ? Math.abs(a[1] - c[1]) : Math.abs(a[0] - c[0])
    const [p0, p1] =
      h1 ?
        [Math.min(a[0], b[0]), Math.max(a[0], b[0])]
      : [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
    const [q0, q1] =
      h2 ?
        [Math.min(c[0], d[0]), Math.max(c[0], d[0])]
      : [Math.min(c[1], d[1]), Math.max(c[1], d[1])]
    return dist < 16 && Math.min(p1, q1) > Math.max(p0, q0)
  }
  const H = h1 ? [a, b] : [c, d],
    V = h1 ? [c, d] : [a, b]
  const x = V[0][0],
    y = H[0][1]
  return (
    x >= Math.min(H[0][0], H[1][0])
    && x <= Math.max(H[0][0], H[1][0])
    && y >= Math.min(V[0][1], V[1][1])
    && y <= Math.max(V[0][1], V[1][1])
  )
}

// a single bend (an L): the two ends are on perpendicular sides, so one bend is the minimum
function cornerCause(r: Route): string {
  const a = r.pts[0],
    b = r.pts[2]
  return a[0] !== b[0] && a[1] !== b[1] ?
      "ports on perpendicular sides; an L is the minimum"
    : "—"
}
