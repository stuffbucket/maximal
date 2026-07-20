# Token vocabulary

The canonical *source* of token values is
[`shell/src/ui/styles/theme.ts`](../../shell/src/ui/styles/theme.ts);
`shell/src/ui/styles/tokens.css` is generated from it by
`scripts/generate-css-tokens.ts`. **Values live in `theme.ts` only.**
This file is the lookup of *name → purpose → scope*.

If you need a value, open `theme.ts` (or the generated `tokens.css`).
If you're describing a token in a doc or commit message, use its name
— never inline the value.

> **Single source.** Every shell surface is styled from the one
> generated `tokens.css`. The separate dashboard window that used to
> redeclare tokens independently was folded into the settings app by
> the single-window redesign (#343), so the cross-surface token drift
> this doc once warned about no longer exists. The one surface still
> outside the generator is `shell/splash.html` (it boots before any
> bundle) — see [`failure-modes.md`](failure-modes.md) → *Tokens &
> drift*.

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
| `--content-max-wide` | Wide content max-width for data-dense sections | The Usage section (charts/tables earn more width than prose) | Prose sections (use `--content-max`, ~65ch is more readable) |

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

## Data visualization (Usage charts)

The Usage view's charts (live traffic stream, trend area, proportion/breakdown
bars) need a small, stable color vocabulary that reads on **both** themes. These
are declared once on `:root` (not per-`[data-theme]`) — the values are mid-tone
and chosen for dual-theme legibility, and the design system's "warn at sub-AA,
never block" stance applies to chart color the same as elsewhere. Viz color
encodes **token type** (input / output / cache) consistently across every chart
and bar — so — unlike interactive surfaces — it is deliberately not the single
`--accent`; it never uses `--brand` crimson.

| Token | Purpose | Use for | Do NOT use for |
|---|---|---|---|
| `--viz-input` | Input-token band | The input band of the traffic area, proportion bar, and per-model bars | Interactive fills; non-viz surfaces |
| `--viz-output` | Output-token band | The output band, everywhere token type is shown | Interactive fills |
| `--viz-cache` | Cache-token band | The cache-read/creation band (a calm neutral — cache is "free") | Emphasis; text color |



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
