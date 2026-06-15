# Aesthetic direction

## Brand personality

**Warm + crafted + considered.** The brand mark (red rounded square
in `#c8334a` with a wonky Fraunces "m") sets the tone: a tool made
by a person, not a corporation. Friendly without being playful-cute.
Confident without being terminal-stark.

- **Voice:** clear, direct, second-person. "Sign in with GitHub" not
  "Initiate OAuth flow." "We can't reach the proxy" not "ECONNREFUSED."
- **Type:** Commissioner (humanist sans) does the body heavy lifting;
  Fraunces appears in the brand mark and one display heading per
  window. See [`type.md`](type.md).
- **Restraint over decoration:** layout, type, and spacing carry the
  feeling. Color is one surface, not the only surface.

## Humanist powerful

Dense with capability but never overwhelming. Doesn't push machine
concerns onto humans (no raw config keys in the primary UI, no JSON
dumps). Doesn't push human concerns into machine shapes (no chat UI
for what should be a single button).

## Reference apps

Starting points, not destinations.

- **Ollama Settings**: card-grouped sections, monochrome utility
  icons paired with a single humanist accent (the drawn llama avatar).
- **Claude / Anthropic Settings**: sidebar nav with restrained active
  state, human-tone copy ("What should Claude call you?"), monitor /
  sun / moon theme toggle.
- **Anti-references**: Linear (too cold and dense), Slack (too
  noisy), the `create-tauri-app` starter (too generic).

## Density

Comfortable. Slightly more spacious than Raycast, far less airy than
Bear. Rows have real padding, line-height ≥ 1.4 for body, section
gaps generous enough that the eye breathes. **Power lives in depth
(more sections, collapsible advanced), not density (more items per
row).** See [`principles.md`](principles.md) → Principle 2.

## When to use a card

A card is a container with chrome (background fill, border or shadow,
internal padding, rounded corners). Cards exist to make a **discrete
actionable entity** visually cohesive — one card represents one
*thing the user can act on as a unit*.

**Use a card when:**
- The contents are the state of a single entity (a provider, an API
  key row, a connected account). The card's borders say "this group
  of fields belongs together; act on them together."
- The user can perform actions specific to that entity (toggle on/off,
  edit, delete) without affecting neighbors.

**Do not use a card for:**
- **Sectioning content within a window.** That's typography's job —
  a strong section heading, generous vertical space, an optional thin
  rule. Wrapping every section in a card adds chrome without meaning,
  dilutes the strong-grouping signal when cards *are* warranted, and
  reads as the AI-dashboard archetype.
- **Holding a single block of content** (a chart, a code sample, an
  empty state). The content's own visual already separates it.
- **Stacking icons + heading + text in identical rows.** That's a
  list, not a grid of cards.

**Card nesting is forbidden.** If you find yourself wanting cards
inside cards, the inner card should be a list-row inside the outer
card, or the outer card should be a typographic section.

**Squint test:** if you blur your eyes and the page looks like a
grid of similar rectangles, the cards aren't doing work — they're
chrome. Drop them.

## Iconography

- **Functional / utility icons:** monochrome, system-tinted, stroke
  ~1.5–2px at 16/20/24 sizes. Lucide or Phosphor as the source
  library; pick one and stick with it.
- **Identity / accent:** the brand "m" appears once per window (top
  of the window, near the heading). Never on every row.
