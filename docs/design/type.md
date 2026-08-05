# Type system

**Pairing: Fraunces (display) + Commissioner (body).** Humanist
editorial pair. Fraunces is already in the brand mark, so the
display tier and the icon share a typographic family. Commissioner
is the workhorse humanist sans for everything else.

**Ramp: 16px base, 1.2 ratio.** Always reference token names —
never inline raw pixel/rem values in components. Values live in [`ui/theme.ts`](../../ui/theme.ts); vocabulary lives in
[`tokens.md`](tokens.md).

## Usage by token name

| Token | Use |
|---|---|
| `--text-xs` | Caption, footnote, helper text |
| `--text-sm` | Inline labels, dense rows, descriptions in Settings |
| `--text-base` | Body, inputs, control labels. **Floor for multi-line prose.** |
| `--text-md` | Lead body for single-section windows (Setup, Dashboard) |
| `--text-lg` | Subhead, sidebar-nav active item |
| `--text-xl` | Section heading inside a window (`h2`, `.h-section`) |
| `--text-2xl` | Window heading (`h1`, `.h-display`) |
| `--text-3xl` | Display — onboarding moments only |
| `--text-4xl` | Hero display — rare; e.g. the Welcome state |

Pair each `--text-*` with the matching `--weight-*` and `--leading-*`
from the ramp; don't hand-tune.

## Weights (by role, not by number)

- **`--weight-base`** — body default
- **`--weight-md`** — emphasis, button label, active sidebar-nav item
- **`--weight-lg`** / **`--weight-xl`** — section headings
- **`--weight-2xl`** — window headings

> No thin weights (100/200/300) — reads thin on dark backgrounds. No
> 900 — too heavy for warm + crafted. If you find a design moment
> that wants either, the answer is usually a different size, not a
> different weight.

> **Heads up.** The previous version of this doc declared
> `--weight-3xl`, `--weight-4xl`, `--leading-3xl`, `--leading-4xl`,
> and a full `--tracking-*` ramp. None exist in `tokens.css`. If you
> need them for a hero display moment, add them to `tokens.css`
> *first* (see [`change-checklists.md`](change-checklists.md)).

## Mono usage

`var(--font-mono)` is for code samples, inline API keys, device codes,
file paths, and numeric tails in activity or usage views. **Always `tabular-nums`** when paired with updating
values so columns don't dance.

## Lengths and density

- Body text: minimum `--text-base`; never smaller for multi-line prose.
- Max line length: `65ch` on prose containers. Code/sample blocks
  are exempt and allowed to scroll.
- Focused onboarding and setup tasks may use `--text-md` lead prose.
- Dense workspace form rows use `--text-base` for control labels and values;
  `--text-sm` for descriptions.

## Numerics

- **Tabular figures** (`font-variant-numeric: tabular-nums`) for any
  numbers that update in place: rate-limit counters, request
  durations, token counts, activity-feed timestamps.
- **Currency / measurement units** sit immediately adjacent (no
  extra space): `7,432 tokens`, `1.2s`.

## Casing

- **Sentence case** for everything user-facing: headings, buttons,
  menu items, labels. **No ALL CAPS** (too marketing).
- **Title Case** only for proper nouns ("GitHub Copilot",
  "Open Maximal").
- Section dividers like "Account" / "API clients" — sentence case
  for the second word.

## Emphasis

- **Bold** (using `--weight-md` or `--weight-lg`) for in-copy
  emphasis. Sparingly.
- Italics for the rare phrase or quoted user input. Avoid for UI labels.
- Never combine bold + italics. Choose one.

## Font loading

Both Fraunces and Commissioner are self-hosted from `ui/assets/fonts`.
The Electron renderer resolves them through Vite; the legacy shell build stages
the same files into its runtime asset location. Neither desktop surface makes an
external font request, preserving offline operation and the no-telemetry posture.
