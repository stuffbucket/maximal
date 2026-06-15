# Type system

**Pairing: Fraunces (display) + Commissioner (body).** Humanist
editorial pair. Fraunces is already in the brand mark, so the display
tier and the icon share a typographic family. Commissioner is the
workhorse humanist sans for everything else.

**Ramp: 16px base, 1.2 ratio.** Token names — never inline raw
pixel/rem values in components. See [`tokens.md`](tokens.md) for the
full token list and [`shell/src/tokens.css`](../../shell/src/tokens.css)
for the authoritative values.

## Token reference (names — not values)

| Token | Purpose |
|---|---|
| `--font-display` | Fraunces. Brand mark + one display heading per window. |
| `--font-body` | Commissioner. Everything that isn't display or mono. |
| `--font-mono` | UI mono stack. Code, identifiers, paths, updating-in-place numerics. |
| `--text-xs` | Caption, footnote, helper text. |
| `--text-sm` | Inline labels, dense rows, descriptions in Settings. |
| `--text-base` | Body, inputs, control labels. **Floor for multi-line prose.** |
| `--text-md` | Lead body for single-section windows (Setup, Dashboard). |
| `--text-lg` | Subhead, sidebar-nav active item. |
| `--text-xl` | Section heading inside a window (`h2`, `.h-section`). |
| `--text-2xl` | Window heading (`h1`, `.h-display`). |
| `--text-3xl` | Display — onboarding moments only. |
| `--text-4xl` | Hero display — rare; e.g. the Welcome state. |
| `--weight-base` (400) | Body default. |
| `--weight-md` (500) | Emphasis, button label, active sidebar-nav. |
| `--weight-lg` (600) | Section headings. |
| `--weight-xl` (600) | Section headings (alias for ramp consistency). |
| `--weight-2xl` (700) | Window headings. |
| `--leading-base` (1.6) | Body. |
| `--leading-lg` (1.4) | Sub-heads, dense headings. |
| `--leading-xl` (1.3) | Section headings. |
| `--leading-2xl` (1.2) | Window headings. |

> **Drift note.** The previous version of this doc declared
> `--weight-3xl`, `--weight-4xl`, `--leading-3xl`, `--leading-4xl`,
> and a full `--tracking-*` ramp. None of these tokens exist in
> `tokens.css`. If you need them for a hero display moment, add them
> to `tokens.css` first (see [`change-checklists.md`](change-checklists.md)).

## Weights

- **400** — body default
- **500** — emphasis, button label, active sidebar-nav item
- **600** — section headings (`h2`, `.h-section`) and window headings
  (`h1`, `.h-display`) currently share `--weight-2xl` → 700 in tokens
- **No 100/200/300** — reads thin on dark backgrounds.
- **No 900** — too heavy for warm + crafted.

## Mono usage

`var(--font-mono)` is for: code samples (the `curl` block in the
Dashboard's Connect section), inline API keys, the device code in
the Setup window's Waiting state, and the numeric tails in the
Activity feed. **Always `tabular-nums`** when paired with updating
values so columns don't dance.

## Lengths and density

- Body text: minimum size `--text-base` (16px); never smaller for
  multi-line prose.
- Max line length: `65ch` on prose containers. Code/sample blocks
  are exempt and allowed to scroll.
- Setup and Dashboard windows: prose uses `--text-md` (18px) because
  the column is narrower and the spaces breathe more.
- Settings: dense form rows use `--text-base` for control labels and
  values; `--text-sm` for descriptions.

## Numerics

- **Tabular figures** (`font-variant-numeric: tabular-nums`) for any
  numbers that update in place: rate-limit counters, request
  durations, token counts, the activity feed timestamps.
- **Currency / measurement units** sit immediately adjacent (no extra
  space): `7,432 tokens`, `1.2s`.

## Casing

- Sentence case for everything user-facing: headings, buttons, menu
  items, labels. **No ALL CAPS** (too marketing).
- Title Case only for proper nouns ("GitHub Copilot", "Open Maximal").
- Section dividers like "Account" / "API clients" — sentence case for
  the second word.

## Emphasis

- **Bold** (weight 500–600) for in-copy emphasis. Sparingly.
- Italics for the rare phrase or quoted user input. Avoid for UI labels.
- Never combine bold + italics. Choose one.

## Font loading

Both Fraunces and Commissioner are on Google Fonts. **Production:
self-host.** The Tauri shell ships WOFF2 files bundled with the Vite
output so the webview never makes an external request — keeps the
app working offline and preserves the no-telemetry posture.
