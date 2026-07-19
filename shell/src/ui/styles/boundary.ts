import type { CSSProperties } from "react"

// The formal boundary condition (∂S) for system styling.
// Restricts generic CSS properties to explicit, typed values mapping to our design tokens.
export type BoundaryStyles = Omit<
  CSSProperties,
  "color" | "backgroundColor" | "margin" | "padding" | "gap" | "fontSize"
> & {
  // Prevent arbitrary strings/hex/rems — only valid CSS Variable properties
  color?: `var(--${string})`
  backgroundColor?: `var(--${string})`
  margin?: `var(--space-${number})` | 0
  padding?: `var(--space-${number})` | 0
  gap?: `var(--space-${number})` | 0
  fontSize?: `var(--text-${string})`
}

/**
 * Ensures any inline style perfectly obeys semantic boundaries.
 */
export function style(styles: BoundaryStyles): CSSProperties {
  return styles
}
