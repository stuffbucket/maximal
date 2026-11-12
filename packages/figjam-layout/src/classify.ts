// Meaning-preserving placement: classify card groups as ORDERED (locked) or UNORDERED (may be
// permuted), with evidence, and search permutations of unordered rows that reduce crossings.
// Nothing here moves anything on the board: it returns suggestions.
import { sectionOf } from "./engine"
import {
  center,
  jsonClone,
  last,
  must,
  type Edge,
  type Layout,
  type Node,
  type Pt,
  type Section,
} from "./model"

export type Group = {
  section: string
  kind: "ORDERED" | "UNORDERED" | "UNSURE"
  what: string
  cards: Array<string>
  evidence: Array<string>
}
export type Move = {
  card: string
  title: string
  from: [number, number]
  to: [number, number]
}

const title = (n: Node) => (n.text ?? n.id).split("\n")[0]
const overlaps = (a: Node, b: Node) =>
  a.rect.x < b.rect.x + b.rect.w
  && b.rect.x < a.rect.x + a.rect.w
  && a.rect.y < b.rect.y + b.rect.h
  && b.rect.y < a.rect.y + a.rect.h

// One section being classified: its cards (no markers), the arrows inside it, the cards already
// locked into an ordered group, and the output list the groups go to.
type SectionScan = {
  s: Section
  node: (id: string) => Node
  cards: Array<Node>
  intra: Array<Edge>
  locked: Set<string>
  groups: Array<Group>
}

// 1. numbered markers pinned to cards
function numberedSequence(scan: SectionScan, markers: Array<Node>): void {
  const { s, cards, locked, groups } = scan
  if (markers.length < 2) return
  const hosts = markers
    .flatMap((mk) => {
      const host = cards.find((c) => overlaps(c, mk))
      return host ? [{ n: Number(mk.text), host }] : []
    })
    .sort((a, b) => a.n - b.n)
  if (hosts.length < 2) return
  groups.push({
    section: s.name,
    kind: "ORDERED",
    what: "numbered sequence",
    cards: hosts.map((h) => h.host.id),
    evidence: [
      `numbered markers ${hosts.map((h) => h.n).join(", ")} sit on ${hosts.map((h) => title(h.host)).join(" → ")}`,
    ],
  })
  for (const h of hosts) locked.add(h.host.id)
}

// 2. chevron (step) shapes
function chevronSteps(scan: SectionScan): void {
  const { s, cards, locked, groups } = scan
  const chevrons = cards.filter((c) => c.style?.shape === "CHEVRON")
  if (chevrons.length < 2) return
  if (chevrons.every((c) => locked.has(c.id))) {
    // only the numbered sequence locks cards before this, so that is the group just pushed
    last(groups).evidence.push(`the same cards are chevron step shapes`)
    return
  }
  groups.push({
    section: s.name,
    kind: "ORDERED",
    what: "chevron steps",
    cards: chevrons.map((c) => c.id),
    evidence: [`${chevrons.length} chevron step shapes in a row`],
  })
  for (const c of chevrons) locked.add(c.id)
}

// The chain of single arrows starting at `start`, up to (and including) the first card that
// doesn't continue it.
function chainFrom(
  start: string,
  out: Map<string, Array<Edge>>,
  indeg: Map<string, number>,
): Array<string> {
  let cur = start
  const chain = [cur]
  const seen = new Set([cur])
  while ((out.get(cur)?.length ?? 0) === 1) {
    const nx = must(out.get(cur), `arrows from ${cur}`)[0].to
    if (seen.has(nx) || (indeg.get(nx) ?? 0) !== 1) {
      if (!seen.has(nx)) chain.push(nx)
      break
    }
    chain.push(nx)
    seen.add(nx)
    cur = nx
  }
  return chain
}

// 3. chains of consecutive arrows (≥ 3 cards, each step one hop)
function arrowChains(scan: SectionScan): void {
  const { s, node, cards, intra, locked, groups } = scan
  const out = new Map<string, Array<Edge>>()
  for (const e of intra) out.set(e.from, [...(out.get(e.from) ?? []), e])
  const indeg = new Map<string, number>()
  for (const e of intra) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  for (const c of cards) {
    if ((indeg.get(c.id) ?? 0) === 1 && (out.get(c.id)?.length ?? 0) === 1)
      continue // middle of a chain
    const chain = chainFrom(c.id, out, indeg)
    if (chain.length >= 3 && !chain.every((id) => locked.has(id))) {
      groups.push({
        section: s.name,
        kind: "ORDERED",
        what: "arrow chain",
        cards: chain,
        evidence: [
          `consecutive arrows ${chain.map((id) => title(node(id))).join(" → ")}`,
        ],
      })
      for (const id of chain) locked.add(id)
    }
  }
}

// 4. flow direction: are rows layers of a top-to-bottom flow? (most arrows point downward)
function flowLayers(
  scan: SectionScan,
  rows: Map<number, Array<Node>>,
  ys: Array<number>,
): void {
  const { s, node, intra, groups } = scan
  const down = intra.filter((e) => {
    const a = center(node(e.from).rect),
      b = center(node(e.to).rect)
    return b[1] - a[1] > 40
  }).length
  if (intra.length < 3 || down / intra.length < 0.6) return
  groups.push({
    section: s.name,
    kind: "ORDERED",
    what: "row order (flow layers)",
    cards: ys.map((y) => must(rows.get(y), `row at y=${y}`)[0].id),
    evidence: [
      `${down} of ${intra.length} arrows inside the family point downward: rows are steps of a top-to-bottom flow, so rows keep their order`,
    ],
  })
}

// One row's unlocked cards: UNORDERED peers, or UNSURE when arrows run inside it or shapes mix.
function rowGroup(scan: SectionScan, row: Array<Node>, y: number): Group {
  const { s, node, intra } = scan
  const ids = new Set(row.map((c) => c.id))
  const inRow = intra.filter((e) => ids.has(e.from) && ids.has(e.to))
  const shapes = new Set(row.map((c) => c.style?.shape))
  const ev: Array<string> = [
    `${row.length} cards side by side: ${row.map((c) => title(c)).join(", ")}`,
  ]
  if (inRow.length > 0)
    ev.push(
      `${inRow.length} arrow(s) run inside this row (${inRow.map((e) => `${title(node(e.from))} → ${title(node(e.to))}`).join("; ")})`,
    )
  if (shapes.size > 1)
    ev.push(
      `mixed shapes (${[...shapes].join(", ")}): tools and rules/fields share the row`,
    )
  const unsure = inRow.length > 0 || shapes.size > 1
  if (!unsure)
    ev.push("no numbering, no arrows between them, same shape: peers")
  return {
    section: s.name,
    kind: unsure ? "UNSURE" : "UNORDERED",
    what: `row at y=${y}`,
    cards: row.map((c) => c.id),
    evidence: ev,
  }
}

function classifySection(L: Layout, s: Section, groups: Array<Group>): void {
  const m = new Map(L.nodes.map((n) => [n.id, n]))
  const scan: SectionScan = {
    s,
    node: (id) => must(m.get(id), `card ${id}`),
    cards: L.nodes.filter(
      (n) => n.section === s.id && n.obstacle && n.style?.shape !== "ELLIPSE",
    ),
    intra: L.edges.filter((e) => {
      const [a, b] = sectionOf(L, e)
      return a === s.id && b === s.id
    }),
    locked: new Set<string>(),
    groups,
  }
  const markers = L.nodes.filter(
    (n) =>
      n.section === s.id
      && n.style?.shape === "ELLIPSE"
      && /^\d+$/.test((n.text ?? "").trim()),
  )
  numberedSequence(scan, markers)
  chevronSteps(scan)
  arrowChains(scan)
  // 5. rows
  const rows = new Map<number, Array<Node>>()
  for (const c of scan.cards)
    rows.set(c.rect.y, [...(rows.get(c.rect.y) ?? []), c])
  const ys = [...rows.keys()].sort((a, b) => a - b)
  flowLayers(scan, rows, ys)
  for (const y of ys) {
    const row = must(rows.get(y), `row at y=${y}`)
      .filter((c) => !scan.locked.has(c.id))
      .sort((a, b) => a.rect.x - b.rect.x)
    if (row.length >= 2) groups.push(rowGroup(scan, row, y))
  }
}

export function classify(L: Layout): Array<Group> {
  const groups: Array<Group> = []
  for (const s of L.sections) classifySection(L, s, groups)
  return groups
}

type Seg = [Pt, Pt]

const orient = (a: Pt, b: Pt, c: Pt) =>
  Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))

function properlyCross([p, q]: Seg, [r, s]: Seg): boolean {
  return (
    orient(p, q, r) * orient(p, q, s) < 0
    && orient(r, s, p) * orient(r, s, q) < 0
  )
}

// The swap search's state: the fast proxy score of the current placement, and how to recompute it.
type Climb = { best: number; score: () => number }

// One pass of pairwise swaps of equal-width cards in an UNORDERED group; a swap is kept when it
// lowers the score by more than 1. Whether any swap was kept.
function swapPass(g: Group, node: (id: string) => Node, climb: Climb): boolean {
  let improved = false
  for (let i = 0; i < g.cards.length; i++)
    for (let j = i + 1; j < g.cards.length; j++) {
      const a = node(g.cards[i]),
        b = node(g.cards[j])
      if (a.rect.w !== b.rect.w) continue
      const ax = a.rect.x
      a.rect = { ...a.rect, x: b.rect.x }
      b.rect = { ...b.rect, x: ax }
      const sc = climb.score()
      if (sc < climb.best - 1) {
        climb.best = sc
        improved = true
      } else {
        b.rect = { ...b.rect, x: a.rect.x }
        a.rect = { ...a.rect, x: ax }
      }
    }
  return improved
}

// Hill-climb swaps of equal-width cards inside UNORDERED rows, scored by a fast proxy (total
// Manhattan length of affected edges + 400 × straight-line crossings among them).
export function suggestMoves(
  L: Layout,
  groups: Array<Group>,
): { moves: Array<Move>; layout: Layout } {
  const T = jsonClone(L)
  const m = new Map(T.nodes.map((n) => [n.id, n]))
  const node = (id: string) => must(m.get(id), `card ${id}`)
  const score = () => {
    const segs = T.edges.map((e): [Pt, Pt, Edge] => [
      center(node(e.from).rect),
      center(node(e.to).rect),
      e,
    ])
    let len = 0,
      x = 0
    for (const [a, b] of segs)
      len += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])
    for (let i = 0; i < segs.length; i++)
      for (let j = i + 1; j < segs.length; j++) {
        const A = segs[i][2],
          B = segs[j][2]
        if ([A.from, A.to].some((v) => v === B.from || v === B.to)) continue
        if (properlyCross([segs[i][0], segs[i][1]], [segs[j][0], segs[j][1]]))
          x++
      }
    return len + 400 * x
  }
  const orig = new Map(T.nodes.map((n) => [n.id, { ...n.rect }]))
  const climb: Climb = { best: score(), score }
  for (let pass = 0; pass < 4; pass++) {
    let improved = false
    for (const g of groups.filter((g) => g.kind === "UNORDERED"))
      if (swapPass(g, node, climb)) improved = true
    if (!improved) break
  }
  const moves: Array<Move> = []
  for (const n of T.nodes) {
    const o = must(orig.get(n.id), `original rect of ${n.id}`)
    if (o.x !== n.rect.x || o.y !== n.rect.y)
      moves.push({
        card: n.id,
        title: title(n),
        from: [o.x, o.y],
        to: [n.rect.x, n.rect.y],
      })
  }
  return { moves, layout: T }
}
