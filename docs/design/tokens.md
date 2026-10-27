# Token vocabulary

The canonical declaration site is
[`shell/src/ui/styles/theme.ts`](../../shell/src/ui/styles/theme.ts).
**Values live there only.** `bun run tokens:generate` writes them into
`shell/src/ui/styles/tokens.css` (Settings) and the generated region of
`shell/ui/dashboard/style.css` (Dashboard). This file is the lookup of
*name → purpose → scope*.

If you need a value, open `theme.ts`. If you're describing a token
in a doc or commit message, use its name — never inline the value.

> **The Dashboard gets a subset.** Every value it has matches Settings,
> but some tokens aren't generated into its region. See
> [`failure-modes.md`](failure-modes.md) → *Known active drift* for
> which ones.

## Type

| Token | Purpose | Use for | Do NOT use for |
|---|---|---|---|
| `--font-display` | Display serif (Fraunces) | Brand mark, one display heading per window | Body, buttons, labels |
| `--font-body` | Workhorse sans (Commissioner) | Everything that isn't display or mono | Brand mark |
| `--font-mono` | Code / identifiers | API keys, device codes, file paths, code blocks, in-place updating numerics (with `tabular-nums`) | Prose, labels |
| `--text-xs` … `--text-4xl` | Type ramp | Reference by name; see [`type.md`](type.md) | Inline raw rem/px values |
| `--weight-base` … `--weight-2xl` | Weight ramp | Pair with a `--text-*` size | Weights outside the ramp |
| `--leading-base` … `--leading-2xl` | Line-height ramp | Pair with text size | Hand-tuned values |
| `--tracking-xl` / `--tracking-2xl` | Tightened letter-spacing | `--text-xl` / `--text-2xl` display headings | Body text |

## Spacing & sizing

| Token | Purpose | Use for | Do NOT use for |
|---|---|---|---|
| `--space-1` … `--space-8` | Spacing scale | All gaps, padding, margins | Off-scale values |
| `--size-xs` … `--size-2xl` | Component dimensions | Icon sizing, hit-target dimensions | Spacing (use `--space-*`) |
| `--radius-input` | Form-control radius | Inputs, buttons | Cards |
| `--radius-card` | Card radius | Cards, code blocks | Inputs (looks bloated) |
| `--radius-chip` | Chip radius | Chips, count badges | Cards |
| `--radius-pill` | Fully rounded | Status dots, round badges | Anything text-heavy |
| `--border-width-hairline` / `-thin` / `-thick` / `-heavy` | Border widths | Reference by name | Off-scale borders |
| `--sidebar-width` | Settings sidebar width | Settings sidebar only | Anything else |
| `--content-max` | Settings content pane max-width | Settings content max-width | Dashboard (uses its own max) |

## Elevation

| Token | Purpose | Use for | Do NOT use for |
|---|---|---|---|
| `--elevation-card` | Card shadow | Cards (barely visible on dark, where the surface step does the work) | Modals |
| `--elevation-modal` | Modal shadow | Modals | Cards |
| `--elevation-tooltip` | Tooltip shadow | Tooltips, popovers | Cards |

## Color (follows the OS; `[data-theme]` pins one)

19 color tokens: 4 theme-independent, 15 per theme.
"Per theme" tokens have a dark and a light value in `theme.ts`; call sites
use the one name and the theme picks the value — there are no `-light` /
`-dark` names to choose between. Every value is checked against all three
surfaces of its theme by `bun scripts/contrast-audit.ts` (in
`packages/storybook`; Storybook → Foundations → Contrast shows the table).

| Token | Theme | Purpose | Use for | Do NOT use for |
|---|---|---|---|---|
| `--brand` | fixed | Crimson identity (≥3:1 non-text) | Brand mark, requirement icon, tray dot | Buttons, links, focus rings, text |
| `--accent` | per theme | Teal **fill / non-text** (≥3:1; white label ≥4.5:1) | Primary button fill, switch "on", checkbox fill, focus ring, busy bar | Text of any kind (use `--link`) |
| `--accent-fg` | fixed | Label on `--accent` | Primary button label, switch thumb and checkbox tick when on | Anything else |
| `--accent-destructive` | fixed | Crimson **fill** for destructive buttons | Delete/destroy button fill | Error text, icons, stripes (use `--status-error`) |
| `--accent-destructive-foreground` | fixed | Label on destructive fill | Destructive button label | Anything else |
| `--link` / `--link-hover` | per theme | Teal **text** (≥4.5:1) | Links, and any teal text: "Copied", accent figures | Fills (use `--accent`) |
| `--surface-base` / `-card` / `-control` | per theme | The three surfaces | Window bg / cards, sidebar / inputs, secondary buttons | Each other's job |
| `--text-strong` / `-base-color` / `-muted` | per theme | Text (all ≥4.5:1) | Headings / body / captions | Muted for body prose |
| `--border-subtle` | per theme | Hairline divider | Separators, card borders | Input borders (not 3:1) |
| `--border-strong` | per theme | Control border (≥3:1) | Input and checkbox borders | Decorative rules |
| `--status-error` / `-success` / `-warning` / `-info` | per theme | State color, text-safe (≥4.5:1) so also icon-safe | Error text, icons, stripes; success/warning indicators | Identity or interaction |
| `--focus-ring*` | — | Focus ring composition (color = `--accent`) | Every focusable element | Hover styling |

There are no `--brand-fg`, `--accent-hover` or `--status-*-fg` tokens:
brand never sits behind text, teal text is `--link`, and the status
colors pass as text on their own.

## Operational rules

- **One token table, one place to look.** Don't redeclare values
  inline in components.
- **If you need a new value, add a token first** and justify it here
  with a `Purpose / Use for / Do NOT use for` row before using it.
- **Numeric tokens** (spacing, type sizes, radii, elevations) and the
  theme-independent colors (brand, button labels, destructive fill) ship on
  `:root`. Every theme-dependent color — surfaces, text, borders,
  `--accent`, `--link*`, `--status-*` — lives in `themes.dark` /
  `themes.light` in `shell/src/ui/styles/theme.ts`. Both themes must
  declare the same keys (the generator refuses otherwise).
- **Theme selection is CSS, not script.** Dark is the `:root` default;
  `@media (prefers-color-scheme: light)` switches to light unless
  `<html data-theme="dark">`; `<html data-theme="light">` pins light.
  Each block sets `color-scheme` so native controls follow. Don't
  hard-code `data-theme` in a window's HTML — that pins it against the
  OS.
- **Regenerate, don't hand-edit.** `bun run tokens:generate` writes
  `tokens.css` and the generated region of the Dashboard's `style.css`
  from `theme.ts`.

- **A color has one role.** If a token fails contrast in some use, don't
  add a variant of it — use the token whose role that is (`--link` for
  teal text, `--status-error` for error text). Then run
  `bun run storybook:check`, which includes the contrast matrix.
