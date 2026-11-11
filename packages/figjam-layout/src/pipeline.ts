// The full routing pipeline: global routing → name-tag decisions → detailed lanes (best of a few
// router settings) → name-tag pills → self-checks and quality scores.
import { fixpoint } from "./fixpoint"
import { globalPlan, monotoneLowerBound, type GlobalPlan } from "./global"
import {
  HARD_CHECKS,
  checks,
  lanes,
  labelSize,
  piecesFromRoutes,
  placeLabels,
  titleRect,
} from "./lanes"
import {
  center,
  checkValue,
  last,
  must,
  type Edge,
  type Layout,
  type Node,
  type Pt,
  type Rect,
  type Tag,
} from "./model"

// One detailed-router setting: crossing cost, passes, bend cost, slot penalty.
type Setting = [number, number, number, number]
export type PipelineOpts = {
  tagRatio?: number
  tagLength?: number
  settings?: Array<Setting>
  policy?: "A" | "B"
}

type Seg = [Pt, Pt]

const lenOf = (pts: Array<Pt>) =>
  pts
    .slice(1)
    .reduce(
      (a, q, i) => a + Math.abs(q[0] - pts[i][0]) + Math.abs(q[1] - pts[i][1]),
      0,
    )
const hitRect = ([a, b]: Seg, r: Rect, pad = 0) =>
  Math.max(a[0], b[0]) > r.x - pad
  && Math.min(a[0], b[0]) < r.x + r.w + pad
  && Math.max(a[1], b[1]) > r.y - pad
  && Math.min(a[1], b[1]) < r.y + r.h + pad
const rectsHit = (a: Rect, b: Rect, pad = 0) =>
  a.x < b.x + b.w + pad
  && b.x < a.x + a.w + pad
  && a.y < b.y + b.h + pad
  && b.y < a.y + a.h + pad
const shortFamily = (name: string) => name.split(/\s*&\s*|\s+/)[0]
const routeSegments = (R: Layout): Array<Seg> =>
  R.routes.flatMap((r) => r.pts.slice(1).map((q, i): Seg => [r.pts[i], q]))

const checksOf = (c: Layout) => must(c.checks, `checks of ${c.name}`)
const hardBad = (c: Layout) =>
  HARD_CHECKS.reduce((s, k) => s + checkValue(checksOf(c), k), 0)

// lexicographic objective: hard validity → crossings → non-monotone → bends → port deviation → length
function objectiveKey(c: Layout): Array<number> {
  const ch = checksOf(c)
  return [
    hardBad(c),
    ch.crossings,
    checkValue(ch, "nonMonotone"),
    Math.round(checkValue(ch, "bendsPerEdge") * c.routes.length),
    checkValue(ch, "meanPortDeviation") * c.routes.length,
    checkValue(ch, "wireLength"),
  ]
}

function compareKeys(ka: Array<number>, kb: Array<number>): number {
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]
  return 0
}

type RoundInput = {
  L: Layout
  settings: Array<Setting>
  policy: "A" | "B"
  plan: GlobalPlan
  tags: Set<string>
}

// Detailed routing under every router setting; the best candidate on the objective.
async function bestOfSettings({
  L,
  settings,
  policy,
  plan,
  tags,
}: RoundInput): Promise<Layout> {
  const tries: Array<Layout> = []
  for (const [cross, passes, bend, slotPenalty] of settings)
    tries.push(
      await lanes(L, {
        cross,
        passes,
        bend,
        slotPenalty,
        plan,
        tags,
        policy,
      }),
    )
  tries.sort((a, b) => compareKeys(objectiveKey(a), objectiveKey(b)))
  return must(tries[0], "a routed candidate")
}

// name tags: a wire that detours more than tau × its Manhattan distance, or spans more than
// maxLen px, becomes a pair of link pills
function detoured(best: Layout, tau: number, maxLen: number): Array<string> {
  return best.routes
    .filter((r) => {
      const a = r.pts[0],
        b = last(r.pts)
      const len = lenOf(r.pts)
      return (
        len / Math.max(40, Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])) > tau
        || len > maxLen
      )
    })
    .map((r) => r.edge)
}

// local-optimality fixpoint, then redraw pieces, re-place labels and re-score
function settle(R: Layout): void {
  const titlesR = R.sections.map((s) => titleRect(s))
  const fx = fixpoint(R, titlesR)
  R.pieces = piecesFromRoutes(R)
  R.labels = placeLabels(R, titlesR)
  const unrouted0 = checkValue(checksOf(R), "unrouted")
  R.checks = checks(R, titlesR)
  R.checks.unrouted = unrouted0
  R.fixpoint = fx
  R.checks.simplificationsLeft = fx.left
  R.name = "lanes"
}

// pill checks: every tagged link must show at both ends, as its own pill or inside a "+N more" pill
function scoreTags(R: Layout, L: Layout, tags: Set<string>): void {
  const tagList = must(R.tags, "placed tags")
  const ch = checksOf(R)
  ch.nameTags = tags.size
  ch.tagPills = tagList.length
  const shown = new Map<string, number>()
  for (const t of tagList)
    for (const id of t.edges ?? [t.edge])
      shown.set(id, (shown.get(id) ?? 0) + 1)
  ch.tagsMissing = [...tags].filter((id) => (shown.get(id) ?? 0) < 2).length
  ch.tagsUnplaced = 0
  const perCard = new Map<string, number>()
  for (const t of tagList) perCard.set(t.card, (perCard.get(t.card) ?? 0) + 1)
  ch.pillsPerCardMax = Math.max(0, ...perCard.values())
  ch.pillsPerCardMean =
    Math.round(
      ([...perCard.values()].reduce((a, b) => a + b, 0)
        / Math.max(1, perCard.size))
        * 10,
    ) / 10
  ch.tagHits = tagHits(R, tagList)
  ch.pillsInCorridor = pillsInCorridor(R, tagList)
  ch.lowerBoundPairs = monotoneLowerBound(L, tags)
  ch.lowerBoundPairsAllWires = monotoneLowerBound(L)
}

export async function planMap(
  L: Layout,
  opts: PipelineOpts = {},
): Promise<Layout> {
  const tau = opts.tagRatio ?? 2.0,
    maxLen = opts.tagLength ?? 5000
  const settings: Array<Setting> = opts.settings ?? [
    [150, 2, 6, 0],
    [150, 2, 6, 5],
    [150, 2, 12, 0],
    [100, 2, 6, 0],
  ]
  const policy = opts.policy ?? "A"
  let tags = new Set<string>()
  let plan: GlobalPlan = globalPlan(L, { tagRatio: 2.5 })
  for (const t of plan.tagged) tags.add(t)
  let best: Layout | undefined
  for (let round = 0; round < 4; round++) {
    best = await bestOfSettings({ L, settings, policy, plan, tags })
    // links the router could only draw non-monotonically (or same-row with a card between) → tags
    const pending = best.newTags ?? []
    for (const id of pending) tags.add(id)
    // detoured or page-spanning wires become pills; then route again without them
    const add = detoured(best, tau, maxLen)
    if ((add.length === 0 && pending.length === 0) || round === 3) break // last round: keep what was routed (no late tags)
    for (const id of add) tags.add(id)
    plan = globalPlan(L, { tagRatio: 2.5, tagged: tags })
    for (const t of plan.tagged) tags.add(t)
  }
  const R = must(best, "a routed candidate")
  settle(R)
  // an edge is either a wire or a pair of pills, never both
  const routedIds = new Set(R.routes.map((r) => r.edge))
  tags = new Set([...tags].filter((id) => !routedIds.has(id)))
  R.tags = placeTags(R, L, tags)
  R.plan = {
    overflow: plan.overflow,
    iterations: plan.iterations,
    windows: plan.windows.length,
    tagRatio: tau,
    tagLength: maxLen,
  }
  scoreTags(R, L, tags)
  return R
}

type TagItem = { edge: Edge; other: string; arrow: string }
type Size = { w: number; h: number }

// Tagged links per card: "→" on the source card, "←" on the target.
function tagItemsByCard(
  edges: Array<Edge>,
  tags: Set<string>,
): Map<string, Array<TagItem>> {
  const byCard = new Map<string, Array<TagItem>>()
  for (const e of edges) {
    if (!tags.has(e.id)) continue
    byCard.set(e.from, [
      ...(byCard.get(e.from) ?? []),
      { edge: e, other: e.to, arrow: "→" },
    ])
    byCard.set(e.to, [
      ...(byCard.get(e.to) ?? []),
      { edge: e, other: e.from, arrow: "←" },
    ])
  }
  return byCard
}

// Candidate anchors for a card's pill stack (W × H): its top corners first, then beside, below
// and above it, stepping outward.
function stackAnchors(r: Rect, W: number, H: number): Array<[number, number]> {
  const anchors: Array<[number, number]> = [
    [r.x, r.y - 16 - H],
    [r.x + r.w - W, r.y - 16 - H],
    [r.x - 16 - W, r.y - H / 2],
    [r.x + r.w + 16, r.y - H / 2],
    [r.x, r.y + r.h + 24],
    [r.x + r.w + 24, r.y],
    [r.x - 24 - W, r.y],
  ]
  for (let dx = 0; dx <= 160; dx += 40)
    anchors.push(
      [r.x + dx, r.y + r.h + 64],
      [r.x + r.w + 64, r.y + dx],
      [r.x + dx, r.y - 64 - H],
    )
  return anchors
}

// The whole stack at the first anchor where every pill is free; undefined if none fits.
function firstFreeStack(
  r: Rect,
  sizes: Array<Size>,
  free: (rr: Rect) => boolean,
): Array<Rect> | undefined {
  const H = sizes.reduce((a, s) => a + s.h + 6, -6),
    W = Math.max(...sizes.map((s) => s.w))
  // nearest link sits innermost (closest to the card): stacks above the card run upward
  const stackAt = ([ax, ay]: [number, number]): Array<Rect> => {
    const above = ay < r.y
    let y = above ? ay + H : ay
    return sizes.map((s) => {
      if (above) y -= s.h
      const rr = {
        x: Math.round(ax / 4) * 4,
        y: Math.round(y / 4) * 4,
        w: s.w,
        h: s.h,
      }
      y = above ? y - 6 : y + s.h + 6
      return rr
    })
  }
  for (const anchor of stackAnchors(r, W, H)) {
    const rects = stackAt(anchor)
    if (
      rects.every(
        (rr, i) =>
          free(rr) && !rects.slice(0, i).some((o) => rectsHit(o, rr, 4)),
      )
    )
      return rects
  }
  return undefined
}

// The free spot nearest the card for one pill (20px grid search out to 800px).
function nearestFreeSpot(
  r: Rect,
  size: Size,
  free: (rr: Rect) => boolean,
): Rect | undefined {
  const cands: Array<[number, number, number]> = []
  for (let dy = -800; dy <= 800; dy += 20)
    for (let dx = -800; dx <= 800; dx += 20) {
      const x = r.x + dx,
        y = r.y + dy
      const ddx = Math.max(0, r.x - (x + size.w), x - (r.x + r.w)),
        ddy = Math.max(0, r.y - (y + size.h), y - (r.y + r.h))
      cands.push([x, y, ddx + ddy])
    }
  cands.sort((a, b) => a[2] - b[2])
  for (const [x, y] of cands) {
    const rr = { x, y, ...size }
    if (free(rr)) return rr
  }
  return undefined
}

// Pills for name-tagged edges: "→ Guard: expect" on the source card, "← Read: rev" on the target.
// Each card's pills stack beside it, nearest link first, in the first free spot around the card.
export function placeTags(R: Layout, L: Layout, tags: Set<string>): Array<Tag> {
  const m = new Map(L.nodes.map((n) => [n.id, n]))
  const sec = new Map(L.sections.map((s) => [s.id, s]))
  const node = (id: string): Node => must(m.get(id), `card ${id}`)
  const segs = routeSegments(R)
  const cards = L.nodes.map((n) => n.rect)
  const titles = L.sections.map((s) => titleRect(s))
  const labels = (R.labels ?? []).map((l) => l.rect)
  const placed: Array<Tag> = []
  const free = (r: Rect) =>
    !segs.some((sg) => hitRect(sg, r, 20))
    && !cards.some((c) => rectsHit(r, c, 12))
    && !titles.some((t) => rectsHit(r, t, 8))
    && !labels.some((l) => rectsHit(r, l, 8))
    && !placed.some((p) => rectsHit(r, p.rect, 6))
    && L.sections.some(
      (s) =>
        r.x >= s.rect.x + 12
        && r.y >= s.rect.y + 12
        && r.x + r.w <= s.rect.x + s.rect.w - 12
        && r.y + r.h <= s.rect.y + s.rect.h - 12,
    )
  const dist = (a: string, b: string) => {
    const p = center(node(a).rect),
      q = center(node(b).rect)
    return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1])
  }
  const pillText = (card: string, it: TagItem) => {
    const o = node(it.other)
    const fam =
      o.section && o.section !== node(card).section ?
        `${shortFamily(must(sec.get(o.section), `section ${o.section}`).name)}: `
      : ""
    return `${it.arrow} ${fam}${(o.text ?? "").split("\n")[0]}`
  }
  for (const [card, items] of tagItemsByCard(L.edges, tags)) {
    items.sort((a, b) => dist(card, a.other) - dist(card, b.other)) // nearest first
    // more than 3 links: the first 2 get their own pill, the rest share a "+N more" pill
    const rest = items.length > 3 ? items.splice(2) : []
    const r = node(card).rect
    const texts = items.map((it) => pillText(card, it))
    const groupEdges: Array<Array<string>> = items.map((it) => [it.edge.id])
    if (rest.length > 0) {
      items.push({ edge: rest[0].edge, other: rest[0].other, arrow: "+" })
      texts.push(`+${rest.length} more links`)
      groupEdges.push(rest.map((x) => x.edge.id))
    }
    const sizes = texts.map((t) => {
      const s = labelSize(t)
      return { w: s.w + 12, h: 28 }
    })
    const tag = (i: number, rect: Rect): Tag => ({
      edge: items[i].edge.id,
      edges: groupEdges[i],
      card,
      other: items[i].other,
      text: texts[i],
      rect,
      order: i,
    })
    const stack = firstFreeStack(r, sizes, free)
    if (stack) {
      for (const [i, rr] of stack.entries()) placed.push(tag(i, rr))
      continue
    }
    // one by one: the free spot nearest the card
    for (const i of items.keys()) {
      const rr = nearestFreeSpot(r, sizes[i], free)
      if (rr) placed.push(tag(i, rr))
    }
  }
  return placed
}

function tagHits(R: Layout, tags: Array<Tag>): number {
  const segs = routeSegments(R)
  let n = 0
  for (const t of tags) {
    if (segs.some((sg) => hitRect(sg, t.rect, 2))) n++
    if (R.nodes.some((c) => rectsHit(t.rect, c.rect))) n++
    if ((R.labels ?? []).some((l) => rectsHit(t.rect, l.rect))) n++
  }
  for (let i = 0; i < tags.length; i++)
    for (let j = i + 1; j < tags.length; j++)
      if (rectsHit(tags[i].rect, tags[j].rect)) n++
  return n
}

// pills must sit outside every routing corridor: ≥ 20px from any line
function pillsInCorridor(R: Layout, tags: Array<Tag>): number {
  const segs = routeSegments(R)
  return tags.filter((t) => segs.some((sg) => hitRect(sg, t.rect, 19))).length
}
