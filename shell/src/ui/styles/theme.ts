export const fontStacks = {
  display: '"Fraunces", Georgia, "Times New Roman", serif',
  body: '"Commissioner", "Segoe UI", Helvetica, Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
} as const

export const text = {
  xs: "0.75rem",
  sm: "0.875rem",
  base: "1rem",
  md: "1.125rem",
  lg: "1.25rem",
  xl: "1.5rem",
  "2xl": "2rem",
  "3xl": "2.5rem",
  "4xl": "3rem",
} as const

export const weight = {
  base: "400",
  md: "500",
  lg: "600",
  xl: "600",
  "2xl": "700",
} as const

export const leading = {
  base: "1.6",
  lg: "1.4",
  xl: "1.3",
  "2xl": "1.2",
} as const

export const tracking = {
  xl: "-0.01em",
  "2xl": "-0.015em",
  caps: "0.02em", // Uppercase micro-labels / table headers (open the caps a touch).
} as const

/**
 * Disabled-state opacity. One canonical value for every disabled control
 * (buttons, inputs, switches, checkboxes, pager) so the dim reads uniformly.
 */
export const opacity = {
  disabled: "0.5",
} as const

/**
 * Motion — utility transition durations + the standard easing. Per the motion
 * contract these are short, functional eases (not delight). `fast` (120ms) for
 * small reveals/rotations, `base` (150ms) for the common color/background tint.
 */
export const duration = {
  fast: "120ms",
  base: "150ms",
} as const

export const easing = {
  standard: "ease-out",
} as const

export const spacing = {
  1: "4px",
  2: "8px",
  3: "12px",
  4: "16px",
  5: "24px",
  6: "32px",
  7: "48px",
  8: "64px",
} as const

export const radii = {
  input: "6px",
  card: "8px",
  chip: "4px",
  pill: "9999px",
} as const

export const borderWidth = {
  hairline: "1px",
  thin: "1px",
  thick: "2px",
  heavy: "4px",
} as const

export const size = {
  xs: "12px",
  sm: "16px",
  md: "20px",
  lg: "24px",
  xl: "32px",
  "2xl": "40px",
} as const

export const elevation = {
  card: "0 1px 2px rgb(0 0 0 / 0.06)",
  modal: "0 8px 24px rgb(0 0 0 / 0.18)",
  tooltip: "0 2px 6px rgb(0 0 0 / 0.1)",
} as const

export const brand = {
  color: "#c8334a",
  fg: "#ffffff",
} as const

export const accent = {
  color: "#5198a6", // Used from tokens.css (overriding the drift in usage-viewer)
  hover: "#63a9b6", // Derived from --accent (#5198a6): a subtle ~10% lighten for hover.
  fg: "#ffffff",
  destructive: "#b32d3f",
  destructiveFg: "#ffffff",
} as const

export const status = {
  error: "#ef4444",
  errorFg: "#fca5a5",
  success: "#22c55e",
  successFg: "#4ade80",
  warning: "#eab308",
  warningFg: "#facc15",
  info: "#38bdf8",
  infoFg: "#7dd3fc",
} as const

/**
 * Data-visualization palette for the Usage charts (see docs/design/tokens.md →
 * Data visualization). Category identity by token TYPE, not interactive state —
 * deliberately not `--accent`, never `--brand`. Mid-tone values chosen to read
 * on both the dark and light surfaces; declared once on `:root`
 * (theme-independent). These three are the token-type split (input / output /
 * cache) used consistently across the traffic area, the proportion bar, and the
 * per-model/provider bars, so one color language reads everywhere.
 */
export const viz = {
  input: "#3f9aa8", // teal
  output: "#7b6fd0", // indigo
  cache: "#8a8f98", // slate — calm neutral (cache is "free")
} as const

export const link = {
  dark: {
    color: "#7fc1d2",
    hover: "#a8d8e3",
  },
  light: {
    color: "#2d6470",
    hover: "#1e5560",
  },
} as const

export const focusRing = {
  width: "2px",
  offset: "2px",
  color: "var(--accent)",
  // Single canonical treatment for every surface: a 2px solid outline
  // in the accent color, offset 2px. Applied via `outline: var(--focus-ring)`
  // on `:focus-visible`. There is deliberately no box-shadow variant —
  // see docs/design/components.md → Focus rings.
  expr: "var(--focus-ring-width) solid var(--focus-ring-color)",
} as const

export const layout = {
  sidebarWidth: "200px",
  contentMax: "640px",
  contentMaxWide: "1040px",
} as const

export const themes = {
  dark: {
    surfaceBase: "#0a0a0a",
    surfaceCard: "#161616",
    surfaceControl: "#1f1f1f",
    textStrong: "#f5f5f5",
    textBaseColor: "#d4d4d4",
    textMuted: "#8a8a8a",
    borderSubtle: "#2a2a2a",
    borderStrong: "#666666",
    link: link.dark.color,
    linkHover: link.dark.hover,
  },
  light: {
    surfaceBase: "#fafafa",
    surfaceCard: "#ffffff",
    surfaceControl: "#f0f0f0",
    textStrong: "#0a0a0a",
    textBaseColor: "#2a2a2a",
    textMuted: "#6a6a6a",
    borderSubtle: "#e5e5e5",
    borderStrong: "#8a8a8a",
    link: link.light.color,
    linkHover: link.light.hover,
  },
} as const
