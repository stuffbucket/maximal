# figjam-layout — layout and edge routing for FigJam boards

This runs on the bridge side, in Bun. It reads a page's AST (`board_tree`), plans the edges
**offline**, scores every candidate with the same self-checks and quality scores, writes SVG/PNG
previews, and only then builds the chosen result on a page it owns.

```sh
mise -C packages/figjam-layout exec -- pnpm install --frozen-lockfile   # elkjs, libavoid-js
bun src/cli.ts fetch 8:248 out/map.json                      # read-only: board_tree (+style) → Layout JSON
bun src/cli.ts convert out/bt.json out/map.json [ref.json]   # offline: cached board_tree → Layout (edge kinds from ref)
bun src/cli.ts plan out/map.json out/run1                    # all candidates → checks, previews, plan.json, classification.json
bun src/cli.ts build out/run1/plan.json lanes [pageId]       # recreate on "Map — layout experiment"; refuses if a hard check fails
```

**Board:** commands that talk to the bridge (`fetch`, `build`) need `FIGJAM_BOARD` set to the
board's name or id. There is no default, because the bridge can serve several FigJam files.

**Bridge auth:** `client.ts` sends no token by default. The pairing token is a credential for the
whole bridge, so using it is opt-in:
- `FIGJAM_TOKEN=<value>` passes the token directly.
- `FIGJAM_USE_PAIRING_TOKEN=1` reads `<data>/figjam/pairing-token`.

**Input:** `fixtures/map-8-248.live.json`, from a `board_tree` read of 8:248. It has 85 cards,
101 edges and 6 family sections, and the legend is kept as a no-go block. Edge kinds come from
`fixtures/map-8-248.offline.json`, because `board_tree` edges carry no style.

## Files
- `pipeline.ts`: the full pipeline (`planMap`, recommended). It also places the name-tag pills.
- `global.ts`: global routing (`globalPlan`) and the monotone crossing lower bound.
- `lanes.ts`: the detailed router (`lanes`), plus the self-checks (`checks`) and `spread`, which
  widens the gutters.
- `classify.ts`: the ORDERED/UNORDERED classification and the suggested (unapplied) moves.
- `build.ts`: writes the page and runs `gate()` first, which refuses to write when any hard check
  fails. It draws:
  - bundle chains as vectors, with legend dashes
  - fixed-size arrowheads (a dot for "checks the result")
  - label pills and name-tag pills: auto-width text over a pill, with `set_link` from each
    name-tag pill to the other card

  `overlay` targets an existing map: it hides the old connectors and adds one "Routed edges" group.
- `bus.ts` and `engine.ts` are earlier strategies, kept as baselines:
  - `bus`: libavoid with trunks.
  - `route`: libavoid with per-card doors.
  - `reflow`: ELK.
  - `magnets`: re-picks connector sides only.
- `model.ts` holds the shared geometry and metrics, and `svg.ts` the offline preview.

## Pipeline (`planMap`)
1. **Global routing (`global.ts`).**
   - Grid: 80px gcells. The map's cards and sections sit on this grid.
   - Blocked cells: cards, the legend, section title pills, and everything outside the sections'
     bounding box, so nothing can wrap around the page.
   - Capacity per cell and direction: 4 lanes, 2 beside a card, 3 in the 80px column gaps.
   - Router: PathFinder-style negotiated congestion. A* costs length + bends + section-wall passes
     + crossings with other bundles + (1 + history) × (1 + present × overflow). Rip up and reroute
     every net until nothing overflows.
   - Bundles (same family pair and kind) share cells at a discount, so they form trunks.
   - Output per edge: a coarse path, the card side used at each end (pin assignment), and the wall
     crossings. The crossings become door windows.
2. **Name tags.**
   - An edge becomes a pair of link pills when its detailed route detours more than 2.0× its
     Manhattan distance, or runs longer than 5000px (about half the page).
   - The source pill reads "→ Guard: expect" and the target pill "← Read: rev". Both link to the
     other card.
   - Global routing, then detailed routing, is redone without the tagged edges, up to 3 rounds.
   - Measured: the 2.5× global rule alone tagged nothing (global p95 detour 1.12). The 5000px rule
     picks the page-spanning links.
3. **Detailed routing (`lanes.ts`):** layered routing inside families, then a monotone search for
   the rest (below).
   - Candidates (4 router settings) are compared on a lexicographic objective, with no weighted
     penalties: hard validity → crossings → non-monotone routes → bends → port deviation from
     centre → length.
4. **Local-optimality fixpoint (`fixpoint.ts`).** Legal simplifications are applied until none is
   left:
   - align a jog onto its neighbour's line
   - collapse a U
   - slide a port along its side onto its own lane, or onto a line between port and lane (removes a
     jog at the stub). A segment is never aligned onto a port's own coordinate: that would lay the
     line on the card's border.
   - move a port to its centre or symmetric slot
   - swap two lanes that cross
   - merge collinear segments

   A move counts only if no hard check gets worse and it improves the objective. The hard
   check `simplificationsLeft` re-scans afterwards and must be 0. Each remaining bend's cause is
   verified by applying the straighter alternative and naming the hard check and the card or line
   it breaks.
5. **Nearest to furthest, and centred.**
   - One link on a card side sits at its centre. k links sit symmetric around the centre, spread over
     up to ~60% of the side (pitch 40–160px, never below 20px), ordered by the other end's position.
   - A link whose two card centres line up within 40px takes the shared x between them: a straight
     drop. The others sit symmetric around it.
   - Pills: at most 3 per card. Extras merge into one "+N more links" pill, linked to the first of
     them.
   - Pills: stacked nearest-first, on the card's top corners first, ≥ 20px from every line.
6. **Placement advice (`classify.ts`), never applied.**
   - Groups are ORDERED when there is evidence: numbered markers, chevron steps, chains of ≥ 3
     consecutive arrows, or a family whose arrows mostly point down (rows are flow layers).
   - Rows of same-shape peers with no arrows between them are UNORDERED.
   - Rows with arrows inside them or mixed shapes are UNSURE and are never permuted.
   - A hill-climb swaps equal-width cards in UNORDERED rows. The result is checked with the real
     router, with name tags fixed so the comparison is fair.

## The `lanes` detailed router
Every link gets a mode before anything is routed, and every port deviation and bend records a cause
in `plan.json` → `explain`.

**Inside a family, cards sit in rows, routed like a layered (Sugiyama-style) orthogonal router:**
- **row:** same-row neighbours get one straight horizontal between the side centres.
- **channel:** adjacent rows leave the bottom (centred or symmetric slot), take one horizontal track
  in the gap between the rows, and enter the top.
  - The tracks in a gap are ordered so the links there don't cross. Each link is inserted where it
    adds the fewest crossings, then the tracks are left-edge packed.
  - When the two centred ports are within 40px, both are nudged to one shared x: a straight drop.
    Ports are never pulled further off-centre than that.
- **loopback:** the agent loop's closing arrow is a U through the gap below its row. It is exempt
  from the monotone rule, because it closes the sequence.
- **mono:** row-skipping and other links use an A* search restricted to monotone moves: never away
  from the target on either axis.
- **tag:** same-row links with a card in between, and any link with no monotone route, become name
  tags instead of wires.

**Across families:**
- A* on the 20px lattice, inside the global plan's corridor.
- Monotone everywhere: no move ever increases the distance to the target on either axis.
- The first try uses the centred port and the assigned door slot. Fallbacks record why they were
  needed.

**Unchanged:**
- Every line is on a 20px lattice, and bends are ≥ 40px apart.
- Bundles share lanes only in the gutters.
- Links that share a card never cross.
- Ports sit only on flat outline: stadium ends keep radius + 16px. Pointed or round ends take a
  mid-height port that is approached head-on.
- Labels and pills are auto-width text over a pill, placed after routing in free space, ≥ 20px from
  any line.

## Self-checks
Hard checks are in `HARD_CHECKS`, and `gate()` refuses to build when any of them is non-zero:
- parallel pitch < 16px
- short jogs
- port spacing
- line–card clearance
- runs along a border
- title-pill hits
- label hits or truncation
- crossings at doors or stubs
- arrowhead hits
- gutter lane swaps
- perimeter wraps
- unrouted edges
- pill hits or unplaced pills
- there-and-back jogs (a step out and back of ≤ 120px)
- missed straight links (the sides overlap with a clear strip, yet the link bends)
- Z links with more than 2 bends
- shared trunks splitting onto one card side
- bends into slanted or round ends
- ports inside a corner radius or slant
- nesting violations (two links on the same card side that cross)
- non-monotone routes, inside a family and anywhere (the loop return is exempt)
- wall crossings outside a door
- simplifications still applicable after the fixpoint
- stubs: each first and last segment perpendicular to its side and ≥ 24px; nothing else within 16px
  of its own card (no line laid on a card's border)
- arrowheads pointing into the card, along the side's normal
- S-jogs (a sideways step ≤ 60px between runs going the same way)
- name-tagged links missing at either end
- in-family detour above 1.25×
- unexplained port deviation
- a lone link more than 25% of the side's length off-centre
- pills inside a routing corridor (< 20px from a line)

These are scores only: crossings against the lower bound, detour max and p95, wire length, bends
per edge (mean and max), S-jogs (a sideways step ≤ 60px between runs going the same way), box
runs, in-section swaps, mean port deviation from the side centre, and the share of ports exactly
centred.

## Ordered / unordered groups (from `classify.ts`)

**ORDERED (locked):**
- Guard: the loop *Read the board → Check the target → Write → Review → Export → Fix* (markers 1–6
  and chevron shapes).
- Guard: the chains *Agent name → Change feed → Claims* and *Claims → One write at a time → Write*.
- Read: the chain *read_markup → gestures → Decide*.
- Organize: the chains *select → focus → viewport* and *Theme clusters → sort_stickies →
  fit_section*.
- Row order in Read, Check and Edit, where 10/10, 10/10 and 5/6 of the arrows point down.

**UNORDERED (peers):**
- Read: list_pages…find_nodes; board_tree / get_node; rev / target.
- Check: review_layout / calibrate_fonts; Overlaps / Text problems / Spacing / Connectors;
  Saved to exports / SVG.
- Organize: align / distribute / arrange_grid / reorder.
- Guard: pageId on every call / People are never blocked.
- Edit: Connector edits / Context-menu actions.

**UNSURE (flagged, never permuted):**
- Create: all three rows. The top two have arrows inside them (create_label → create_shape,
  create_section → create_stickies, create_mind_map → connect); the third mixes rules and tools.
- Organize: the rows at y=240 and y=1200 (create_page → switch_page, group → ungroup).
- Guard: the row at y=2560 (arrows inside it, mixed shapes).
- Edit: the rows at y=3920 and y=4400.

**Suggested moves (not applied):** the only swap the proxy found is reversing the Organize row
align / distribute / arrange_grid / reorder. With name tags held fixed, it predicts 26 → 26
crossings and about 3% less wire. Recommendation: don't move anything.

## Limits
- Drawn lines and pills are vectors and text. They don't follow cards when someone moves them;
  re-plan after edits.
- Name tags trade wires for reading: 49 of 101 links are pills in variant A. Relaxing monotonicity
  (variant B) doesn't bring wires back; loosening the 5000px length rule is the lever that would.
- Soft leftovers: 6 S-jogs and 1 in-family lane swap. Ports are centred rather than straight, so a link whose two centres differ by more than 40px is a Z, not a straight drop.
- `plan` takes about 2.5 minutes, mostly from 3 tag rounds × 4 router settings.
- The hexagon and chevron outline insets are measured from exports, at 14% and 12% of the width.
