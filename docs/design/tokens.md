# Token vocabulary

The canonical declaration site is
[`shell/src/tokens.css`](../../shell/src/tokens.css). **Never inline
raw values in components — reference tokens by name.** If a needed
measurement isn't tokenized, add the token first (see
[`change-checklists.md`](change-checklists.md)).

> **Drift warning.** `src/pages/usage-viewer.css` redeclares many of
> these tokens independently (the Dashboard is a single embedded HTML
> file with no CSS imports — see [`windows.md`](windows.md)). Several
> values currently differ. See [`failure-modes.md`](failure-modes.md)
> → *Known active drift* for the audit.

| Token | Purpose | Use for | Do NOT use for |
|---|---|---|---|
| `--font-display` | Display serif (Fraunces) | Brand mark, one display heading per window | Body, buttons, labels |
| `--font-body` | Workhorse sans (Commissioner) | Everything that isn't display or mono | Brand mark |
| `--font-mono` | Code / identifiers | API keys, device codes, file paths, code blocks, in-place updating numerics (with `tabular-nums`) | Prose, labels |
| `--text-xs` … `--text-4xl` | 1.2-ratio type ramp | Reference by name; see [`type.md`](type.md) | Inline raw rem/px values |
| `--weight-base` … `--weight-2xl` | Weight ramp (400 → 700) | Pair with the matching `--text-*` size | Weights 100–300 (thin on dark), 900 (too heavy) |
| `--leading-base` … `--leading-2xl` | Line-height ramp (1.6 → 1.2) | Pair with text size | Hand-tuned values |
| `--space-1` … `--space-8` | Spacing scale (4 → 64px) | All gaps, padding, margins | Off-scale values |
| `--size-xs` … `--size-2xl` | Component dimensions (12 → 40px) | Icon sizing, hit-target dimensions | Spacing (use `--space-*`) |
| `--radius-input` (6px) | Inputs, buttons | Form controls | Cards |
| `--radius-card` (8px) | Cards, code blocks | Card-like containers | Inputs (looks bloated) |
| `--radius-chip` (4px) | Chips, count badges | Small inline tags | Cards |
| `--radius-pill` (9999px) | Status dots, count badges | Round/pill shapes | Anything text-heavy |
| `--border-width-hairline` / `-thin` / `-thick` / `-heavy` | Border widths (1 / 1 / 2 / 4px) | Reference by name | Off-scale borders |
| `--elevation-card` | Card shadow | Cards in light mode | Dark mode (surface step does the work) |
| `--elevation-modal` | Modal shadow | Modals | Cards |
| `--elevation-tooltip` | Tooltip shadow | Tooltips, popovers | Cards |
| `--brand` (`#c8334a`) | Crimson identity | Brand mark, hero, badging, attention-state tray dot | Buttons, links, focus rings |
| `--brand-fg` (`#ffffff`) | Foreground on brand fill | Text/icon on `--brand` | Anything else |
| `--accent` (`#5198a6`) | Teal interactive | Primary button fill, switch "on", focus ring, active-nav affordance | Brand identity, prose links |
| `--accent-fg` (`#ffffff`) | Foreground on accent fill | Button label on `--accent` | Anything else |
| `--accent-destructive` (`#b32d3f`) | Crimson-adjacent destructive | Delete/destroy buttons | Anything non-destructive (urgency, not interaction) |
| `--accent-destructive-foreground` (`#ffffff`) | Foreground on destructive fill | Destructive button label | Anything else |
| `--link` (`#7fc1d2` / `#2d6470`) | Prose link color | `<a>` in prose | Primary actions (use `--accent`), navigation (own state) |
| `--link-hover` (`#a8d8e3` / `#1e5560`) | Link hover variant | `:hover` on `<a>` | Default state |
| `--focus-ring-width` / `-offset` / `-color` / `--focus-ring` | Focus ring (2px / 2px / `var(--accent)` / composed) | Every focusable element | Hover styling |
| `--sidebar-width` (200px) | Settings sidebar | Settings sidebar only | Dashboard (no sidebar) |
| `--content-max` (640px) | Settings content pane width | Settings content max-width | Dashboard (uses 720px max — see [`layout.md`](layout.md)) |
| `--surface-base` (`#0a0a0a` / `#fafafa`) | Window background | `body` background | Cards (use `--surface-card`) |
| `--surface-card` (`#161616` / `#ffffff`) | Card / sidebar | Cards, sidebar fill | Window background |
| `--surface-control` (`#1f1f1f` / `#f0f0f0`) | Input / button surface | Form controls, secondary buttons | Cards (one step too dark/light) |
| `--text-strong` (`#f5f5f5` / `#0a0a0a`) | Strong text | Headings, primary body | Helpers, captions |
| `--text-base-color` (`#d4d4d4` / `#2a2a2a`) | Body text | Body prose | Headings (use `--text-strong`) |
| `--text-muted` (`#8a8a8a` / `#6a6a6a`) | Muted text | Helpers, captions, group labels | Body (fails contrast for long-form prose) |
| `--border-subtle` (`#2a2a2a` / `#e5e5e5`) | Subtle divider | Hairline separators, card borders | High-contrast emphasis |
| `--border-strong` (`#666666` / `#8a8a8a`) | Strong divider | Input borders, emphasized rules | Subtle dividers |

## Operational rules

- **One token table, one place to look.** Don't redeclare values
  inline in components.
- **If you need a new value, add a token first** and justify it in
  this file before using it.
- **User-themable overrides** apply to `--accent` and `--surface-card`
  only; everything else recomputes against the new pair with the
  contrast guardrails described in [`color.md`](color.md).
- **All numeric tokens** (spacing, type sizes, radii, elevations)
  ship as CSS custom properties on `:root`. Surface and text keys
  override per theme via `[data-theme="light"]` / `[data-theme="dark"]`.
