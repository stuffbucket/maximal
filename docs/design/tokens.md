# Token vocabulary

The canonical declaration site is
[`shell/src/tokens.css`](../../shell/src/tokens.css). **Values live
there only.** This file is the lookup of *name → purpose → scope*.

If you need a value, open `tokens.css`. If you're describing a token
in a doc or commit message, use its name — never inline the value.

> **Drift warning.** `src/pages/usage-viewer.css` redeclares many of
> these tokens independently (the Dashboard is a single embedded HTML
> file with no CSS imports — see [`windows.md`](windows.md)).
> Several values currently differ. See
> [`failure-modes.md`](failure-modes.md) → *Known active drift* for
> the audit (and that's the one place we *do* show conflicting values
> on purpose).

## Type

| Token | Purpose | Use for | Do NOT use for |
|---|---|---|---|
| `--font-display` | Display serif (Fraunces) | Brand mark, one display heading per window | Body, buttons, labels |
| `--font-body` | Workhorse sans (Commissioner) | Everything that isn't display or mono | Brand mark |
| `--font-mono` | Code / identifiers | API keys, device codes, file paths, code blocks, in-place updating numerics (with `tabular-nums`) | Prose, labels |
| `--text-xs` … `--text-4xl` | 1.2-ratio type ramp | Reference by name; see [`type.md`](type.md) | Inline raw rem/px values |
| `--weight-base` … `--weight-2xl` | Weight ramp | Pair with the matching `--text-*` size | Weights outside the ramp |
| `--leading-base` … `--leading-2xl` | Line-height ramp | Pair with text size | Hand-tuned values |

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
| `--elevation-card` | Card shadow | Cards in light mode | Dark mode (surface step does the work) |
| `--elevation-modal` | Modal shadow | Modals | Cards |
| `--elevation-tooltip` | Tooltip shadow | Tooltips, popovers | Cards |

## Color (light + dark via `[data-theme]`)

| Token | Purpose | Use for | Do NOT use for |
|---|---|---|---|
| `--brand` | Crimson identity | Brand mark, hero, badging, attention-state tray dot | Buttons, links, focus rings |
| `--brand-fg` | Foreground on brand fill | Text/icon on `--brand` | Anything else |
| `--accent` | Teal interactive | Primary button fill, switch "on", focus ring, active-nav | Brand identity, prose links |
| `--accent-fg` | Foreground on accent fill | Button label on `--accent` | Anything else |
| `--accent-destructive` | Crimson-adjacent destructive | Delete/destroy buttons | Anything non-destructive |
| `--accent-destructive-foreground` | Foreground on destructive fill | Destructive button label | Anything else |
| `--link` | Prose link color | `<a>` in prose | Primary actions (use `--accent`), navigation (own state) |
| `--link-hover` | Link hover variant | `:hover` on `<a>` | Default state |
| `--focus-ring-width` / `-offset` / `-color` / `--focus-ring` | Focus ring composition | Every focusable element | Hover styling |
| `--surface-base` | Window background | `body` background | Cards (use `--surface-card`) |
| `--surface-card` | Card / sidebar | Cards, sidebar fill | Window background |
| `--surface-control` | Input / button surface | Form controls, secondary buttons | Cards |
| `--text-strong` | Strong text | Headings, primary body | Helpers, captions |
| `--text-base-color` | Body text | Body prose | Headings (use `--text-strong`) |
| `--text-muted` | Muted text | Helpers, captions, group labels | Body prose (fails contrast for long form) |
| `--border-subtle` | Subtle divider | Hairline separators, card borders | High-contrast emphasis |
| `--border-strong` | Strong divider | Input borders, emphasized rules | Subtle dividers |

## Operational rules

- **One token table, one place to look.** Don't redeclare values
  inline in components.
- **If you need a new value, add a token first** and justify it here
  with a `Purpose / Use for / Do NOT use for` row before using it.
- **User-themable overrides** apply to `--accent` and `--surface-card`
  only; everything else recomputes against the new pair with the
  contrast guardrails in [`color.md`](color.md).
- **Numeric tokens** (spacing, type sizes, radii, elevations) ship as
  CSS custom properties on `:root`. Surface, text, and `--link*` keys
  override per theme via `[data-theme="light"]` / `[data-theme="dark"]`.
