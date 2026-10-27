# Type system

**Pairing: Fraunces (display) + Commissioner (body).** Humanist
editorial pair. Fraunces is already in the brand mark, so the
display tier and the icon share a typographic family. Commissioner
is the workhorse humanist sans for everything else.

**Ramp: `--text-xs` … `--text-4xl` around a `--text-base` body size.**
Always reference token names — never inline raw pixel/rem values in
components. Values live in
[`shell/src/ui/styles/theme.ts`](../../shell/src/ui/styles/theme.ts);
vocabulary in [`tokens.md`](tokens.md).

## Usage by token name

| Token | Use |
|---|---|
| `--text-xs` | Glyph-only contexts, such as a `.kbd` keycap badge. **Nothing else in Settings:** `bun run check:tokens` fails any `var(--text-xs)` in `shell/src/ui/styles/styles.css` outside a `.kbd` rule. `--text-sm` is the Settings floor. |
| `--text-sm` | Settings form labels, inputs, buttons, sidebar-nav items, descriptions and hints |
| `--text-base` | Body prose. **Floor for multi-line prose.** |
| `--text-md` | Subsection, card, empty-state and dialog titles |
| `--text-lg` | Subhead |
| `--text-xl` | Section heading inside the Dashboard (`.h-section`) |
| `--text-2xl` | The Settings section's display heading (`.section__title`, Fraunces) |
| `--text-3xl` / `--text-4xl` | Hero display — rare; neither window uses them today |

Pair each `--text-*` with a `--weight-*` and `--leading-*` from the
ramp; don't hand-tune. The two display sizes also have a tightened
letter-spacing token, `--tracking-xl` / `--tracking-2xl`.

## Weights (by role, not by number)

- **`--weight-base`** — body default
- **`--weight-md`** — emphasis, button label, active sidebar-nav item
- **`--weight-lg`** / **`--weight-xl`** — section headings
- **`--weight-2xl`** — window headings

> No thin weights (100/200/300) — reads thin on dark backgrounds. No
> 900 — too heavy for warm + crafted. If you find a design moment
> that wants either, the answer is usually a different size, not a
> different weight.

The weight and leading ramps stop at `2xl`. If a hero moment needs
more, add the token to `theme.ts` *first* (see
[`change-checklists.md`](change-checklists.md)).

## Mono usage

`var(--font-mono)` is for: code samples, inline API keys, the GitHub
device code on the Settings sign-in button, and identifiers in the
Dashboard's tables (session and trace IDs). **Always `tabular-nums`**
when paired with updating values so columns don't dance.

## Lengths and density

- Body text: minimum `--text-base`; never smaller for multi-line prose.
- Max line length: `65ch` on prose containers. Code/sample blocks
  are exempt and allowed to scroll.
- Settings: dense form rows use `--text-sm` for labels, controls and
  hints.

## Numerics

- **Tabular figures** (`font-variant-numeric: tabular-nums`) for any
  numbers that update in place: quota counters, request durations,
  token counts, timestamps.
- **Currency / measurement units** sit immediately adjacent (no
  extra space): `7,432 tokens`, `1.2s`.

## Casing

- **Sentence case** for everything user-facing: headings, buttons,
  menu items, labels. **No ALL CAPS** in copy or on headings, buttons
  and nav items (too marketing). The one exception is small muted
  metadata labels — `styles.css` sets `.table th` column headers and
  the `.nav__chip` sidebar chip in uppercase with slight
  letter-spacing. Write their text in sentence case; the CSS does the
  casing.
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

Both Fraunces and Commissioner are on Google Fonts. **Self-host.**
The WOFF2 files are vendored under `shell/ui/settings/vendor/fonts/`
(Fraunces + Commissioner) and `shell/ui/dashboard/vendor/fonts/`
(Commissioner only) and copied next to each build, so the webview never
makes an external request — keeps the app working offline and
preserves the no-telemetry posture.
